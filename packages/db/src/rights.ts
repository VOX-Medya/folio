import {and,asc,desc,eq,gt,isNull} from 'drizzle-orm';
import {z} from 'zod';
import {rightsDecisionQuerySchema,rightsRecordCreateSchema} from '@folio/contracts';
import type {RightsAction,RightsDecision,RightsDecisionQuery,RightsRecordCreate} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';

type RightsDb=ReturnType<typeof createFolioDb>['db'];
type RightsRecord=typeof schema.rightsRecords.$inferSelect;
type Scope='work'|'edition'|'revision';

/** Evidence submission NEVER approves a record. Call only from trusted admin modules. */
export async function submitRightsEvidence(
  db:RightsDb,actorId:string,inputValue:unknown,requestId?:string,
) {
  const actor=z.uuid().parse(actorId);
  // Validate the caller's trusted HTTP trace before any draft/evidence write.
  // It never proves MFA, reviewer approval or licensing rights.
  const traceId=requestId===undefined?undefined:z.uuid().parse(requestId);
  const input:RightsRecordCreate=rightsRecordCreateSchema.parse(inputValue);
  return db.transaction(async tx=>{
    const [work]=await tx.select().from(schema.works).where(eq(schema.works.id,input.workId)).limit(1);
    if (!work) throw new Error('Rights work scope does not exist');
    if (input.editionId) {
      const [edition]=await tx.select().from(schema.editions).where(eq(schema.editions.id,input.editionId)).limit(1);
      if (!edition || edition.workId!==input.workId) throw new Error('Rights edition belongs to another work');
    }
    if (input.revisionId) {
      const [revision]=await tx.select().from(schema.contentRevisions).where(eq(schema.contentRevisions.id,input.revisionId)).limit(1);
      if (!revision || revision.editionId!==input.editionId) throw new Error('Rights revision belongs to another edition');
    }
    const [record]=await tx.insert(schema.rightsRecords).values({
      workId:input.workId,editionId:input.editionId??null,revisionId:input.revisionId??null,
      sourceUrl:input.sourceUrl??null,evidence:input.evidence,licenseKind:input.licenseKind,
      territories:input.territories,displayAllowed:input.displayAllowed,
      translationAllowed:input.translationAllowed,audioAllowed:input.audioAllowed,
      sharingAllowed:input.sharingAllowed,expiresAt:input.expiresAt?new Date(input.expiresAt):null,
      reviewStatus:'pending',
    }).returning();
    if (!record) throw new Error('Rights insertion failed');
    await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'rights.evidence.submit',entityType:'rights_record',entityId:record.id,
      ...(traceId?{requestId:traceId}:{}),
      afterJson:{workId:record.workId,editionId:record.editionId,revisionId:record.revisionId,status:record.reviewStatus},
    });
    return record;
  });
}

/** The caller must supply a trusted, RBAC-authorized reviewer. No public HTTP route. */
export async function reviewRightsEvidence(db:RightsDb,reviewerId:string,recordId:string,
  decision:'approved'|'rejected'|'withdrawn',reason:string,requestId?:string) {
  const reviewer=z.uuid().parse(reviewerId);
  const id=z.uuid().parse(recordId);
  const traceId=requestId===undefined?undefined:z.uuid().parse(requestId);
  const rationale=z.string().trim().min(12).max(4000).parse(reason);
  if (!['approved','rejected','withdrawn'].includes(decision)) throw new Error('Invalid rights review decision');
  return db.transaction(async tx=>{
    // Serialize competing reviewers. Once withdrawn, an in-flight approval
    // cannot overwrite withdrawal after reading an obsolete pending status.
    const [old]=await tx.select().from(schema.rightsRecords)
      .where(eq(schema.rightsRecords.id,id)).limit(1).for('update');
    if (!old) throw new Error('Rights record not found');
    if (old.reviewStatus==='withdrawn') throw new Error('Withdrawn rights cannot be restored');
    const [record]=await tx.update(schema.rightsRecords).set({
      reviewStatus:decision,reviewedBy:reviewer,reviewedAt:new Date(),
    }).where(eq(schema.rightsRecords.id,id)).returning();
    await tx.insert(schema.auditEvents).values({
      actorId:reviewer,action:`rights.review.${decision}`,entityType:'rights_record',entityId:id,
      ...(traceId?{requestId:traceId}:{}),
      beforeJson:{reviewStatus:old.reviewStatus,reviewedBy:old.reviewedBy},
      afterJson:{reviewStatus:decision,reviewedBy:reviewer},reason:rationale,
    });
    return record;
  });
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

/** All three scopes must currently permit this action and territory. Default is DENY. */
export async function verifyRightsForAction(db:RightsDb,rawQuery:unknown,now:Date=new Date()):Promise<RightsDecision> {
  const q:RightsDecisionQuery=rightsDecisionQuerySchema.parse(rawQuery);
  const [edition]=await db.select().from(schema.editions).where(eq(schema.editions.id,q.editionId)).limit(1);
  const [revision]=await db.select().from(schema.contentRevisions).where(eq(schema.contentRevisions.id,q.revisionId)).limit(1);
  if (!edition || edition.workId!==q.workId || !revision || revision.editionId!==q.editionId) {
    return {allowed:false,reason:'wrong_scope'};
  }
  const scopes: {kind:Scope;value:string}[]=[
    {kind:'work',value:q.workId},{kind:'edition',value:q.editionId},{kind:'revision',value:q.revisionId},
  ];
  for (const scope of scopes){
    const where=scope.kind==='work'
      ?and(eq(schema.rightsRecords.workId,scope.value),isNull(schema.rightsRecords.editionId),isNull(schema.rightsRecords.revisionId))
      :scope.kind==='edition'
        ?and(eq(schema.rightsRecords.workId,q.workId),eq(schema.rightsRecords.editionId,scope.value),isNull(schema.rightsRecords.revisionId))
        :and(eq(schema.rightsRecords.workId,q.workId),eq(schema.rightsRecords.editionId,q.editionId),eq(schema.rightsRecords.revisionId,scope.value));
    const [record]=await db.select().from(schema.rightsRecords).where(where)
      .orderBy(desc(schema.rightsRecords.createdAt),desc(schema.rightsRecords.id)).limit(1);
    const result=evaluateRecord(record,q.action,q.territory,now);
    if (!result.allowed) return result;
  }
  return {allowed:true,reason:'approved'};
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
