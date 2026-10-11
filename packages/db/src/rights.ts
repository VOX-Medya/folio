import {and,asc,desc,eq,gt,isNull} from 'drizzle-orm';
import {z} from 'zod';
import {rightsDecisionQuerySchema,rightsRecordCreateSchema,adminRightsReviewInputSchema} from '@folio/contracts';
import type {RightsAction,RightsDecision,RightsDecisionQuery,RightsRecordCreate} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';

type RightsDb=ReturnType<typeof createFolioDb>['db'];
type RightsTx=Parameters<Parameters<RightsDb['transaction']>[0]>[0];
type RightsRecord=typeof schema.rightsRecords.$inferSelect;
type Scope='work'|'edition'|'revision';


/** One transaction for role verification, evidence and audit. New claims stay PENDING. */
async function submitEvidenceInTx(
  tx:RightsTx,actor:string,input:RightsRecordCreate,traceId?:string,
){
  const [work]=await tx.select({id:schema.works.id})
    .from(schema.works).where(eq(schema.works.id,input.workId)).limit(1);
  if(!work)throw new Error('Rights work scope does not exist');
  if(input.editionId){
    const [edition]=await tx.select({workId:schema.editions.workId})
      .from(schema.editions).where(eq(schema.editions.id,input.editionId)).limit(1);
    if(!edition||edition.workId!==input.workId){
      throw new Error('Rights edition belongs to another work');
    }
  }
  if(input.revisionId){
    const [revision]=await tx.select({editionId:schema.contentRevisions.editionId})
      .from(schema.contentRevisions)
      .where(eq(schema.contentRevisions.id,input.revisionId)).limit(1);
    if(!revision||revision.editionId!==input.editionId){
      throw new Error('Rights revision belongs to another edition');
    }
  }
  const [record]=await tx.insert(schema.rightsRecords).values({
    workId:input.workId,editionId:input.editionId??null,revisionId:input.revisionId??null,
    sourceUrl:input.sourceUrl??null,evidence:input.evidence,licenseKind:input.licenseKind,
    territories:input.territories,displayAllowed:input.displayAllowed,
    translationAllowed:input.translationAllowed,audioAllowed:input.audioAllowed,
    sharingAllowed:input.sharingAllowed,
    expiresAt:input.expiresAt?new Date(input.expiresAt):null,
    reviewStatus:'pending',
  }).returning();
  if(!record)throw new Error('Rights insertion failed');
  await tx.insert(schema.auditEvents).values({
    actorId:actor,action:'rights.evidence.submit',entityType:'rights_record',
    entityId:record.id,...(traceId?{requestId:traceId}:{}),
    afterJson:{workId:record.workId,editionId:record.editionId,
      revisionId:record.revisionId,status:record.reviewStatus},
  });
  return record;
}

/** INTERNAL prepared-source interface; caller owns the trusted actor ID. */
export async function submitRightsEvidence(
  db:RightsDb,actorId:string,inputValue:unknown,requestId?:string,
){
  const actor=z.uuid().parse(actorId);
  const traceId=requestId===undefined?undefined:z.uuid().parse(requestId);
  const input:RightsRecordCreate=rightsRecordCreateSchema.parse(inputValue);
  return db.transaction(tx=>submitEvidenceInTx(tx,actor,input,traceId));
}

/** Only active same-device MFA / catalog:edit may create a pending claim. */
export async function submitVerifiedAdminRightsEvidence(
  db:RightsDb,bearer:string,inputValue:unknown,requestId:string,
){
  const input:RightsRecordCreate=rightsRecordCreateSchema.parse(inputValue);
  const traceId=z.uuid().parse(requestId);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',
    (tx,who)=>submitEvidenceInTx(tx,who.userId,input,traceId));
}

async function reviewEvidenceInTx(
  tx:RightsTx,reviewer:string,id:string,
  decision:'approved'|'rejected'|'withdrawn',
  rationale:string,traceId?:string,workId?:string,
){
  // The source and rights decision remain in the same serializable row lock
  // while persisted same-device permission is protected by shared locks.
  const [old]=await tx.select().from(schema.rightsRecords)
    .where(eq(schema.rightsRecords.id,id)).limit(1).for('update');
  if(!old||workId!==undefined&&old.workId!==workId)return null;
  if(old.reviewStatus==='withdrawn'){
    throw new Error('Withdrawn rights cannot be restored');
  }
  const [record]=await tx.update(schema.rightsRecords).set({
    reviewStatus:decision,reviewedBy:reviewer,reviewedAt:new Date(),
  }).where(eq(schema.rightsRecords.id,id)).returning();
  await tx.insert(schema.auditEvents).values({
    actorId:reviewer,action:'rights.review.'+decision,entityType:'rights_record',
    entityId:id,...(traceId?{requestId:traceId}:{}),
    beforeJson:{reviewStatus:old.reviewStatus,reviewedBy:old.reviewedBy},
    afterJson:{reviewStatus:decision,reviewedBy:reviewer},reason:rationale,
  });
  return record;
}

/** INTERNAL trusted reviewer flow for CLI/scoped tests, not an HTTP authorization. */
export async function reviewRightsEvidence(
  db:RightsDb,reviewerId:string,recordId:string,
  decision:'approved'|'rejected'|'withdrawn',reason:string,requestId?:string,
){
  const reviewer=z.uuid().parse(reviewerId);
  const id=z.uuid().parse(recordId);
  const traceId=requestId===undefined?undefined:z.uuid().parse(requestId);
  const input=adminRightsReviewInputSchema.parse({decision,reason});
  return db.transaction(async tx=>{
    const result=await reviewEvidenceInTx(
      tx,reviewer,id,input.decision,input.reason,traceId);
    if(!result)throw new Error('Rights record not found');
    return result;
  });
}

/** Rights approval and withdrawal can only be decided by live rights:review MFA. */
export async function reviewVerifiedAdminRightsEvidence(
  db:RightsDb,bearer:string,workId:string,recordId:string,
  rawInput:unknown,requestId:string,
){
  const input=adminRightsReviewInputSchema.parse(rawInput);
  const ids=[workId,recordId].map(id=>z.uuid().parse(id));
  const traceId=z.uuid().parse(requestId);
  return withVerifiedAdminPermission(db,bearer,'rights:review',
    (tx,who)=>reviewEvidenceInTx(
      tx,who.userId,ids[1]!,input.decision,input.reason,traceId,ids[0]));
}

function allowedForAction(record:RightsRecord,action:RightsAction):boolean {
  switch(action){
    case 'display':return record.displayAllowed;
    case 'translation':return record.translationAllowed;
    case 'audio':return record.audioAllowed;
    case 'sharing':return record.sharingAllowed;
  }
}

function evaluateRecord(record:RightsRecord|undefined,action:RightsAction,territory:string,now:Date):RightsDecision {
  if (!record) return {allowed:false,reason:'missing'};
  if (record.reviewStatus!=='approved' || !record.reviewedAt || !record.reviewedBy) return {allowed:false,reason:'unreviewed'};
  if (record.expiresAt && record.expiresAt.getTime()<=now.getTime()) return {allowed:false,reason:'expired'};
  if (!record.territories.includes(territory)) return {allowed:false,reason:'territory'};
  if (!allowedForAction(record,action)) return {allowed:false,reason:'prohibited'};
  return {allowed:true,reason:'approved'};
}


/** Snapshot gate. No rights claim, missing scope, or withdrawn claim can pass. */
async function readRightsDecisionInTx(
  tx:RightsTx,q:RightsDecisionQuery,now:Date,
):Promise<RightsDecision>{
  const [edition]=await tx.select({workId:schema.editions.workId})
    .from(schema.editions).where(eq(schema.editions.id,q.editionId)).limit(1);
  const [revision]=await tx.select({editionId:schema.contentRevisions.editionId})
    .from(schema.contentRevisions)
    .where(eq(schema.contentRevisions.id,q.revisionId)).limit(1);
  if(!edition||edition.workId!==q.workId||
     !revision||revision.editionId!==q.editionId){
    return {allowed:false,reason:'wrong_scope'};
  }
  const scopes: {kind:Scope;value:string}[]=[
    {kind:'work',value:q.workId},
    {kind:'edition',value:q.editionId},
    {kind:'revision',value:q.revisionId},
  ];
  for(const scope of scopes){
    const where=scope.kind==='work'
      ?and(eq(schema.rightsRecords.workId,scope.value),
        isNull(schema.rightsRecords.editionId),isNull(schema.rightsRecords.revisionId))
      :scope.kind==='edition'
        ?and(eq(schema.rightsRecords.workId,q.workId),
          eq(schema.rightsRecords.editionId,scope.value),
          isNull(schema.rightsRecords.revisionId))
        :and(eq(schema.rightsRecords.workId,q.workId),
          eq(schema.rightsRecords.editionId,q.editionId),
          eq(schema.rightsRecords.revisionId,scope.value));
    const [record]=await tx.select().from(schema.rightsRecords).where(where)
      .orderBy(desc(schema.rightsRecords.createdAt),
        desc(schema.rightsRecords.id)).limit(1);
    const result=evaluateRecord(record,q.action,q.territory,now);
    if(!result.allowed)return result;
  }
  return {allowed:true,reason:'approved'};
}

/** INTERNAL publication gate. Caller must still enforce published status. */
export async function verifyRightsForAction(
  db:RightsDb,rawQuery:unknown,now:Date=new Date(),
):Promise<RightsDecision>{
  const q:RightsDecisionQuery=rightsDecisionQuerySchema.parse(rawQuery);
  return db.transaction(tx=>readRightsDecisionInTx(tx,q,now),
    {isolationLevel:'repeatable read'});
}

/** Rights decision preview, not public content delivery. */
export async function getVerifiedAdminRightsDecision(
  db:RightsDb,bearer:string,rawQuery:unknown,
){
  const q:RightsDecisionQuery=rightsDecisionQuerySchema.parse(rawQuery);
  return withVerifiedAdminPermission(db,bearer,'rights:read',
    tx=>readRightsDecisionInTx(tx,q,new Date()),
    {isolationLevel:'repeatable read'});
}


/** Only a current rights:review officer may inspect raw legal evidence.
 * The ordinary catalog:read and rights:read ledger never expose this. */
export async function getVerifiedAdminRightsEvidence(
  db:RightsDb,bearer:string,workId:string,recordId:string,
){
  const work=z.uuid().parse(workId),id=z.uuid().parse(recordId);
  return withVerifiedAdminPermission(db,bearer,'rights:review',async tx=>{
    const [record]=await tx.select({
      id:schema.rightsRecords.id,
      workId:schema.rightsRecords.workId,
      editionId:schema.rightsRecords.editionId,
      revisionId:schema.rightsRecords.revisionId,
      evidence:schema.rightsRecords.evidence,
      sourceUrl:schema.rightsRecords.sourceUrl,
      licenseKind:schema.rightsRecords.licenseKind,
      territories:schema.rightsRecords.territories,
      display:schema.rightsRecords.displayAllowed,
      translation:schema.rightsRecords.translationAllowed,
      audio:schema.rightsRecords.audioAllowed,
      sharing:schema.rightsRecords.sharingAllowed,
      reviewStatus:schema.rightsRecords.reviewStatus,
      expiresAt:schema.rightsRecords.expiresAt,
    }).from(schema.rightsRecords)
      .where(and(eq(schema.rightsRecords.workId,work),
        eq(schema.rightsRecords.id,id))).limit(1);
    if(!record)return null;
    return {
      id:record.id,workId:record.workId,
      editionId:record.editionId,revisionId:record.revisionId,
      evidence:record.evidence,sourceUrl:record.sourceUrl,
      licenseKind:record.licenseKind,territories:record.territories,
      claims:{display:record.display,translation:record.translation,
        audio:record.audio,sharing:record.sharing},
      reviewStatus:record.reviewStatus,
      expiresAt:record.expiresAt?.toISOString()??null,
    };
  },{isolationLevel:'repeatable read'});
}

/** Metadata-only admin ledger; never a license grant/preview. Each page
 * revalidates real account/session, same-device MFA and persisted rights:read
 * inside the SAME PostgreSQL snapshot as the work and evidence SELECT.
 * It deliberately does not select evidence, sourceUrl, licenseKind, reviewers,
 * user library rows or any private asset reference. */
const rightsLedgerInput=z.object({
  workId:z.uuid(),cursor:z.uuid().optional(),
  limit:z.number().int().min(1).max(50).default(20),
}).strict();
export async function getVerifiedAdminRightsLedger(
  db:RightsDb,bearer:string,rawInput:unknown,
){
  const input=rightsLedgerInput.parse(rawInput);
  return withVerifiedAdminPermission(db,bearer,'rights:read',async tx=>{
    const [work]=await tx.select({id:schema.works.id})
      .from(schema.works).where(eq(schema.works.id,input.workId)).limit(1);
    if(!work)return null;
    const rows=await tx.select({
      id:schema.rightsRecords.id,
      editionId:schema.rightsRecords.editionId,
      revisionId:schema.rightsRecords.revisionId,
      reviewStatus:schema.rightsRecords.reviewStatus,
      territories:schema.rightsRecords.territories,
      displayAllowed:schema.rightsRecords.displayAllowed,
      translationAllowed:schema.rightsRecords.translationAllowed,
      audioAllowed:schema.rightsRecords.audioAllowed,
      sharingAllowed:schema.rightsRecords.sharingAllowed,
      expiresAt:schema.rightsRecords.expiresAt,
    }).from(schema.rightsRecords).where(and(
      eq(schema.rightsRecords.workId,input.workId),
      ...(input.cursor?[gt(schema.rightsRecords.id,input.cursor)]:[]),
    )).orderBy(asc(schema.rightsRecords.id)).limit(input.limit+1);
    const items=rows.slice(0,input.limit).map(record=>({
      id:record.id,editionId:record.editionId,revisionId:record.revisionId,
      reviewStatus:record.reviewStatus,
      territories:record.territories,
      claims:{
        display:record.displayAllowed,
        translation:record.translationAllowed,
        audio:record.audioAllowed,sharing:record.sharingAllowed,
      },
      expiresAt:record.expiresAt?.toISOString()??null,
    }));
    return {
      workId:input.workId,items,
      nextCursor:rows.length>input.limit?(items.at(-1)?.id??null):null,
      isMetadataOnly:true as const,
    };
  },{isolationLevel:'repeatable read'});
}
