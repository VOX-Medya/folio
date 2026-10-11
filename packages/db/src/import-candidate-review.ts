import {and,asc,eq,gt,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import {
  adminImportCandidateProposeSchema,adminWorkMatchDecisionSchema,
  adminWorkMatchQuerySchema,
} from '@folio/contracts';
import type {AdminImportCandidatePropose} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import {payloadHash} from './import-staging.js';
import * as schema from './schema.js';

type Db=ReturnType<typeof createFolioDb>['db'];
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type Case=typeof schema.importCandidateReviews.$inferSelect;
const uuid=z.uuid();
const stale=()=>new Error('Import candidate review stale or evidence unavailable');
const independent=()=>new Error('Independent import candidate reviewer required');
const noEvidence=()=>new Error('Incoming claim does not match canonical title or source digest');
const changedPackage=()=>new Error('Import package UUID reused with different checksum');
const MAX_PACKAGE_REVIEWS=500;

function result(row:Case,changed:boolean){
  return {id:row.id,candidateWorkId:row.candidateWorkId,
    packageId:row.packageId,incomingWorkId:row.incomingWorkId,
    status:row.status,reviewVersion:row.reviewVersion,
    changed,provenanceVerified:false as const};
}
type Evidence={
  candidateWorkVersion:number;candidateWorkStatus:string;
  evidenceKind:'claimed_source_sha256'|'claimed_title';
  evidenceDigest:string;
};
/** An existing catalog candidate is used only as READ-ONLY evidence. The
 * incoming metadata + SHA are CLIENT CLAIMS, not verified package bytes. */
async function inspect(tx:Tx,candidateId:string,input:AdminImportCandidatePropose,
  inputDigest:string,
):Promise<Evidence|null>{
  const [candidate]=await tx.select({
    id:schema.works.id,title:schema.works.originalTitle,
    language:schema.works.originalLanguage,
    status:schema.works.publicationStatus,version:schema.works.metadataVersion,
  }).from(schema.works).where(eq(schema.works.id,candidateId)).limit(1).for('share');
  if(!candidate)return null;
  const [incomingExists]=await tx.select({id:schema.works.id}).from(schema.works)
    .where(eq(schema.works.id,input.incomingWorkId)).limit(1);
  if(incomingExists)throw stale(); // this review can never be an import mapping
  const titleMatch=candidate.title===input.incomingTitle&&
    candidate.language===input.incomingLanguage;
  let sourceMatch=false;
  if(input.sourceSha256){
    const [match]=await tx.select({id:schema.contentRevisions.id})
      .from(schema.contentRevisions)
      .innerJoin(schema.editions,
        eq(schema.contentRevisions.editionId,schema.editions.id))
      .where(and(eq(schema.editions.workId,candidateId),
        eq(schema.contentRevisions.rawSha256,input.sourceSha256))).limit(1);
    sourceMatch=!!match;
  }
  if(!sourceMatch&&!titleMatch)throw noEvidence();
  const evidenceKind=sourceMatch?'claimed_source_sha256':'claimed_title';
  const evidenceDigest=payloadHash({
    candidateId,version:candidate.version,status:candidate.status,
    title:candidate.title,language:candidate.language,
    incomingInputDigest:inputDigest,evidenceKind,
  });
  return {candidateWorkVersion:candidate.version,
    candidateWorkStatus:candidate.status,evidenceKind,evidenceDigest};
}
function fromRow(row:Case):AdminImportCandidatePropose{
  return {
    packageId:row.packageId,manifestChecksum:row.manifestChecksum,
    incomingWorkId:row.incomingWorkId,incomingTitle:row.incomingTitle,
    incomingLanguage:row.incomingLanguage as 'tr'|'en',
    ...(row.claimedSourceSha256?{sourceSha256:row.claimedSourceSha256}:{}),
  };
}
/** An explicit MFA-backed proposal is the ONLY intake mutation.
 * Neither the read-only dry-run nor stage/resume code uses this ledger. */
export async function proposeVerifiedAdminImportCandidateReview(
  db:Db,bearer:string,rawCandidateId:string,raw:unknown,rawRequestId:string,
){
  const candidateId=uuid.parse(rawCandidateId).toLowerCase();
  const parsed=adminImportCandidateProposeSchema.parse(raw);
  const input:AdminImportCandidatePropose={
    ...parsed,packageId:parsed.packageId.toLowerCase(),
    incomingWorkId:parsed.incomingWorkId.toLowerCase(),
  };
  if(input.incomingWorkId===candidateId)throw stale();
  const trace=uuid.parse(rawRequestId),digest=payloadHash(input);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,actor)=>{
    // Same lock name as internal import stage. Proposal cannot race package
    // identity reuse under a concurrent staging transaction.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.packageId}))`);
    const [staged]=await tx.select({
      manifestChecksum:schema.importBatches.manifestChecksum,
    }).from(schema.importBatches)
      .where(eq(schema.importBatches.packageId,input.packageId)).limit(1);
    if(staged&&staged.manifestChecksum!==input.manifestChecksum)throw changedPackage();
    const [priorPackage]=await tx.select({
      manifestChecksum:schema.importCandidateReviews.manifestChecksum,
    }).from(schema.importCandidateReviews)
      .where(eq(schema.importCandidateReviews.packageId,input.packageId)).limit(1);
    if(priorPackage&&priorPackage.manifestChecksum!==input.manifestChecksum){
      throw changedPackage();
    }
    const evidence=await inspect(tx,candidateId,input,digest);
    if(!evidence)return null;
    const [prior]=await tx.select().from(schema.importCandidateReviews)
      .where(and(eq(schema.importCandidateReviews.packageId,input.packageId),
        eq(schema.importCandidateReviews.incomingWorkId,input.incomingWorkId),
        eq(schema.importCandidateReviews.candidateWorkId,candidateId)))
      .limit(1).for('update');
    if(prior){
      if(prior.inputDigest!==digest)throw changedPackage();
      if(prior.evidenceDigest===evidence.evidenceDigest&&
        prior.candidateWorkVersion===evidence.candidateWorkVersion&&
        prior.candidateWorkStatus===evidence.candidateWorkStatus){
        return result(prior,false);
      }
      const [updated]=await tx.update(schema.importCandidateReviews)
        .set({...evidence,status:'pending',reviewVersion:prior.reviewVersion+1,
          proposedBy:actor.userId,reviewedBy:null,rationale:null,updatedAt:new Date()})
        .where(eq(schema.importCandidateReviews.id,prior.id)).returning();
      if(!updated)throw stale();
      await tx.insert(schema.auditEvents).values({
        actorId:actor.userId,requestId:trace,
        action:'import.candidate.review.refreshed',
        entityType:'import_candidate_review',entityId:updated.id,
        beforeJson:{status:prior.status,reviewVersion:prior.reviewVersion,
          evidenceDigest:prior.evidenceDigest},
        afterJson:{status:'pending',reviewVersion:updated.reviewVersion,
          evidenceDigest:updated.evidenceDigest,packageId:updated.packageId,
          noImportApply:true,noRightsGrant:true,noMerge:true},
      });
      return result(updated,true);
    }
    const existingCount=await tx.select({id:schema.importCandidateReviews.id})
      .from(schema.importCandidateReviews)
      .where(eq(schema.importCandidateReviews.packageId,input.packageId))
      .limit(MAX_PACKAGE_REVIEWS);
    if(existingCount.length>=MAX_PACKAGE_REVIEWS)throw stale();
    const [created]=await tx.insert(schema.importCandidateReviews).values({
      packageId:input.packageId,manifestChecksum:input.manifestChecksum,
      incomingWorkId:input.incomingWorkId,incomingTitle:input.incomingTitle,
      incomingLanguage:input.incomingLanguage,
      claimedSourceSha256:input.sourceSha256??null,inputDigest:digest,
      candidateWorkId:candidateId,...evidence,proposedBy:actor.userId,
    }).returning();
    if(!created)throw stale();
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,requestId:trace,
      action:'import.candidate.review.proposed',
      entityType:'import_candidate_review',entityId:created.id,
      afterJson:{packageId:created.packageId,incomingWorkId:created.incomingWorkId,
        candidateWorkId:created.candidateWorkId,status:'pending',
        evidenceKind:created.evidenceKind,evidenceDigest:created.evidenceDigest,
        reviewVersion:0,provenanceVerified:false,noImportApply:true},
    });
    return result(created,true);
  });
}
/** Different human admin, same fresh-MFA / RBAC transaction. 'distinct' only
 * records human evidence; it NEVER changes preview.canStage or stage/apply. */
export async function decideVerifiedAdminImportCandidateReview(
  db:Db,bearer:string,rawCandidateId:string,rawReviewId:string,
  rawDecision:unknown,rawRequestId:string,
){
  const candidateId=uuid.parse(rawCandidateId).toLowerCase();
  const reviewId=uuid.parse(rawReviewId);
  const input=adminWorkMatchDecisionSchema.parse(rawDecision),trace=uuid.parse(rawRequestId);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,actor)=>{
    const [hint]=await tx.select().from(schema.importCandidateReviews)
      .where(and(eq(schema.importCandidateReviews.id,reviewId),
        eq(schema.importCandidateReviews.candidateWorkId,candidateId))).limit(1);
    if(!hint)return null;
    const evidence=await inspect(tx,candidateId,fromRow(hint),hint.inputDigest);
    if(!evidence)throw stale();
    const [row]=await tx.select().from(schema.importCandidateReviews)
      .where(eq(schema.importCandidateReviews.id,reviewId)).limit(1).for('update');
    if(!row||row.candidateWorkId!==candidateId)throw stale();
    if(row.proposedBy===actor.userId)throw independent();
    if(row.status!=='pending'||row.reviewVersion!==input.expectedVersion||
      row.evidenceDigest!==evidence.evidenceDigest||
      row.candidateWorkVersion!==evidence.candidateWorkVersion||
      row.candidateWorkStatus!==evidence.candidateWorkStatus)throw stale();
    const [updated]=await tx.update(schema.importCandidateReviews).set({
      status:input.decision,reviewVersion:row.reviewVersion+1,
      reviewedBy:actor.userId,rationale:input.rationale,updatedAt:new Date(),
    }).where(eq(schema.importCandidateReviews.id,row.id)).returning();
    if(!updated)throw stale();
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,requestId:trace,reason:input.rationale,
      action:'import.candidate.review.decided',
      entityType:'import_candidate_review',entityId:row.id,
      beforeJson:{status:'pending',reviewVersion:row.reviewVersion,
        evidenceDigest:row.evidenceDigest},
      afterJson:{status:updated.status,reviewVersion:updated.reviewVersion,
        packageId:updated.packageId,incomingWorkId:updated.incomingWorkId,
        candidateWorkId:updated.candidateWorkId,noImportApply:true,
        noRightsGrant:true,noMerge:true,noPublication:true},
    });
    return result(updated,true);
  });
}
/** Bounded and sanitized list, no bearer data, source digest, rights text,
 * author/person lookup, provenance claim or raw package payload. */
export async function listVerifiedAdminImportCandidateReviews(
  db:Db,bearer:string,rawCandidateId:string,rawQuery:unknown,
){
  const candidateId=uuid.parse(rawCandidateId).toLowerCase();
  const query=adminWorkMatchQuerySchema.parse(rawQuery);
  return withVerifiedAdminPermission(db,bearer,'catalog:read',async tx=>{
    const [candidate]=await tx.select({id:schema.works.id})
      .from(schema.works).where(eq(schema.works.id,candidateId)).limit(1);
    if(!candidate)return null;
    const rows=await tx.select().from(schema.importCandidateReviews)
      .where(and(eq(schema.importCandidateReviews.candidateWorkId,candidateId),
        ...(query.cursor?[gt(schema.importCandidateReviews.id,query.cursor)]:[])))
      .orderBy(asc(schema.importCandidateReviews.id)).limit(21);
    const items=rows.slice(0,20);
    const [current]=await tx.select({
      version:schema.works.metadataVersion,status:schema.works.publicationStatus,
    }).from(schema.works).where(eq(schema.works.id,candidateId)).limit(1);
    if(!current)throw stale();
    const incomingIds=items.map(row=>row.incomingWorkId);
    const alreadyCatalogued=incomingIds.length?await tx.select({id:schema.works.id})
      .from(schema.works).where(inArray(schema.works.id,incomingIds)):[];
    const alreadyCataloguedIds=new Set(alreadyCatalogued.map(row=>row.id));
    return {
      items:items.map(row=>({
        id:row.id,candidateWorkId:row.candidateWorkId,
        packageId:row.packageId,incomingWorkId:row.incomingWorkId,
        incomingTitle:row.incomingTitle,
        incomingLanguage:row.incomingLanguage as 'tr'|'en',
        status:row.status,evidenceKind:row.evidenceKind,
        reviewVersion:row.reviewVersion,
        snapshotCurrent:current.version===row.candidateWorkVersion&&
          current.status===row.candidateWorkStatus&&
          !alreadyCataloguedIds.has(row.incomingWorkId),
        provenanceVerified:false as const,
      })),
      nextCursor:rows.length>20?items[19]!.id:null,
    };
  },{isolationLevel:'repeatable read'});
}
