import {createHash} from 'node:crypto';
import {and,asc,eq,gt,inArray,or} from 'drizzle-orm';
import {z} from 'zod';
import {
  adminWorkMatchDecisionSchema,adminWorkMatchProposeSchema,
  adminWorkMatchQuerySchema,
} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import * as schema from './schema.js';

type Db=ReturnType<typeof createFolioDb>['db'];
type Tx=Parameters<Parameters<Db['transaction']>[0]>[0];
type MatchRow=typeof schema.canonicalWorkMatchReviews.$inferSelect;
const uuid=z.uuid();
const MAX_EVIDENCE_ROWS=1000;

const failed=()=>new Error('Canonical work match review is stale or unavailable');
const independent=()=>new Error('Verified independent catalog reviewer required');
type Evidence={workVersion:number;candidateVersion:number;
  evidenceKind:'shared_source_sha256'|'shared_isbn'|'same_title'|'manual';
  evidenceDigest:string};

/**
 * Both works must be existing DRAFTs. SHA-256 equality is only a reviewer
 * signal, never a canonical-equivalence, importer mapping or rights grant.
 * Lock parent rows in canonical UUID order before review row locks.
 */
async function inspectEvidence(tx:Tx,a:string,b:string):Promise<Evidence|null>{
  const works=await tx.select({
    id:schema.works.id,title:schema.works.originalTitle,
    language:schema.works.originalLanguage,
    version:schema.works.metadataVersion,status:schema.works.publicationStatus,
  }).from(schema.works).where(inArray(schema.works.id,[a,b]))
    .orderBy(asc(schema.works.id)).for('share');
  if(works.length!==2)return null;
  const left=works[0]!,right=works[1]!;
  if(left.id!==a||right.id!==b||left.status!=='draft'||right.status!=='draft'){
    throw failed();
  }
  const sources=await tx.select({
    workId:schema.editions.workId,sha:schema.contentRevisions.rawSha256,
  }).from(schema.contentRevisions)
    .innerJoin(schema.editions,eq(schema.contentRevisions.editionId,schema.editions.id))
    .where(inArray(schema.editions.workId,[a,b]))
    .orderBy(asc(schema.editions.workId),asc(schema.contentRevisions.rawSha256))
    .limit(MAX_EVIDENCE_ROWS+1);
  if(sources.length>MAX_EVIDENCE_ROWS)throw failed();
  const leftHashes=[...new Set(sources.filter(row=>row.workId===a).map(row=>row.sha))].sort();
  const rightHashes=[...new Set(sources.filter(row=>row.workId===b).map(row=>row.sha))].sort();
  const common=new Set(leftHashes);
  const hasCommon=rightHashes.some(digest=>common.has(digest));
  // An ISBN is a reviewer clue, NEVER a globally unique canonical work ID.
  // Compare only exact stored kind/value pairs; do not infer normalization.
  const identifiers=await tx.select({
    workId:schema.editions.workId,kind:schema.editionIdentifiers.kind,
    value:schema.editionIdentifiers.value,
  }).from(schema.editionIdentifiers)
    .innerJoin(schema.editions,eq(schema.editionIdentifiers.editionId,schema.editions.id))
    .where(and(inArray(schema.editions.workId,[a,b]),
      inArray(schema.editionIdentifiers.kind,['isbn-10','isbn-13'])))
    .orderBy(asc(schema.editions.workId),asc(schema.editionIdentifiers.kind),
      asc(schema.editionIdentifiers.value))
    .limit(MAX_EVIDENCE_ROWS+1);
  if(identifiers.length>MAX_EVIDENCE_ROWS)throw failed();
  const isbnKey=(row:{kind:string;value:string})=>JSON.stringify([row.kind,row.value]);
  const leftIsbns=[...new Set(identifiers.filter(row=>row.workId===a)
    .map(isbnKey))].sort();
  const rightIsbns=[...new Set(identifiers.filter(row=>row.workId===b)
    .map(isbnKey))].sort();
  const knownIsbns=new Set(leftIsbns);
  const hasCommonIsbn=rightIsbns.some(value=>knownIsbns.has(value));
  const sameTitle=left.title===right.title&&left.language===right.language;
  const evidenceKind=hasCommon?'shared_source_sha256':
    hasCommonIsbn?'shared_isbn':sameTitle?'same_title':'manual';
  // Include both complete bounded inventories in the evidence fingerprint:
  // an edition identifier change invalidates previously recorded judgments
  // even if metadataVersion is not advanced by an internal writer.
  const evidenceDigest=createHash('sha256').update(JSON.stringify({
    left,right,leftHashes,rightHashes,leftIsbns,rightIsbns,
  })).digest('hex');
  return {workVersion:left.version,candidateVersion:right.version,
    evidenceKind,evidenceDigest};
}
function response(row:MatchRow,changed:boolean){
  return {id:row.id,workId:row.workId,candidateWorkId:row.candidateWorkId,
    status:row.status,reviewVersion:row.reviewVersion,changed};
}
function sortedPair(workId:string,candidateId:string){
  const ids=[uuid.parse(workId),uuid.parse(candidateId)].sort();
  if(ids[0]===ids[1])throw new Error('Cannot compare a canonical work to itself');
  return [ids[0]!,ids[1]!] as const;
}

/** Propose or explicitly REFRESH a persisted review. No merge path exists. */
export async function proposeVerifiedAdminWorkMatchReview(
  db:Db,bearer:string,workId:string,raw:unknown,requestId:string,
){
  const input=adminWorkMatchProposeSchema.parse(raw);
  const [a,b]=sortedPair(workId,input.candidateWorkId);
  const trace=uuid.parse(requestId);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,actor)=>{
    const evidence=await inspectEvidence(tx,a,b);
    if(!evidence)return null;
    const [existing]=await tx.select().from(schema.canonicalWorkMatchReviews)
      .where(and(eq(schema.canonicalWorkMatchReviews.workId,a),
        eq(schema.canonicalWorkMatchReviews.candidateWorkId,b)))
      .limit(1).for('update');
    if(existing){
      if(existing.evidenceDigest===evidence.evidenceDigest&&
        existing.workVersion===evidence.workVersion&&
        existing.candidateVersion===evidence.candidateVersion){
        return response(existing,false);
      }
      const [refreshed]=await tx.update(schema.canonicalWorkMatchReviews).set({
        ...evidence,status:'pending',reviewVersion:existing.reviewVersion+1,
        proposedBy:actor.userId,reviewedBy:null,rationale:null,updatedAt:new Date(),
      }).where(eq(schema.canonicalWorkMatchReviews.id,existing.id)).returning();
      if(!refreshed)throw failed();
      await tx.insert(schema.auditEvents).values({
        actorId:actor.userId,requestId:trace,
        action:'catalog.work.match_review.refreshed',
        entityType:'canonical_work_match_review',entityId:refreshed.id,
        beforeJson:{status:existing.status,reviewVersion:existing.reviewVersion,
          evidenceDigest:existing.evidenceDigest},
        afterJson:{status:'pending',reviewVersion:refreshed.reviewVersion,
          evidenceDigest:refreshed.evidenceDigest,
          workId:a,candidateWorkId:b},
      });
      return response(refreshed,true);
    }
    const [created]=await tx.insert(schema.canonicalWorkMatchReviews).values({
      workId:a,candidateWorkId:b,...evidence,proposedBy:actor.userId,
    }).onConflictDoNothing().returning();
    if(!created){
      const [competing]=await tx.select().from(schema.canonicalWorkMatchReviews)
        .where(and(eq(schema.canonicalWorkMatchReviews.workId,a),
          eq(schema.canonicalWorkMatchReviews.candidateWorkId,b))).limit(1);
      if(!competing||competing.evidenceDigest!==evidence.evidenceDigest)throw failed();
      return response(competing,false);
    }
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,requestId:trace,
      action:'catalog.work.match_review.proposed',
      entityType:'canonical_work_match_review',entityId:created.id,
      afterJson:{workId:a,candidateWorkId:b,status:'pending',
        evidenceKind:evidence.evidenceKind,evidenceDigest:evidence.evidenceDigest,
        reviewVersion:0},
    });
    return response(created,true);
  });
}

/** A separate current-device MFA catalog editor may ONLY say 'distinct' or
 * 'deferred'. Even 'distinct' does NOT unblock a conflicting import or publish. */
export async function decideVerifiedAdminWorkMatchReview(
  db:Db,bearer:string,workId:string,reviewId:string,raw:unknown,requestId:string,
){
  const id=uuid.parse(reviewId),parent=uuid.parse(workId),
    input=adminWorkMatchDecisionSchema.parse(raw),trace=uuid.parse(requestId);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,actor)=>{
    // Lock order: account/session/MFA/role -> canonical works -> review.
    const [hint]=await tx.select({
      workId:schema.canonicalWorkMatchReviews.workId,
      candidateWorkId:schema.canonicalWorkMatchReviews.candidateWorkId,
    }).from(schema.canonicalWorkMatchReviews)
      .where(eq(schema.canonicalWorkMatchReviews.id,id)).limit(1);
    if(!hint||![hint.workId,hint.candidateWorkId].includes(parent))return null;
    const evidence=await inspectEvidence(tx,hint.workId,hint.candidateWorkId);
    if(!evidence)throw failed();
    const [review]=await tx.select().from(schema.canonicalWorkMatchReviews)
      .where(eq(schema.canonicalWorkMatchReviews.id,id)).limit(1).for('update');
    if(!review||review.workId!==hint.workId||
      review.candidateWorkId!==hint.candidateWorkId)throw failed();
    if(review.proposedBy===actor.userId)throw independent();
    if(review.status!=='pending'||review.reviewVersion!==input.expectedVersion||
      review.evidenceDigest!==evidence.evidenceDigest||
      review.workVersion!==evidence.workVersion||
      review.candidateVersion!==evidence.candidateVersion)throw failed();
    const [updated]=await tx.update(schema.canonicalWorkMatchReviews).set({
      status:input.decision,reviewVersion:review.reviewVersion+1,
      reviewedBy:actor.userId,rationale:input.rationale,updatedAt:new Date(),
    }).where(eq(schema.canonicalWorkMatchReviews.id,id)).returning();
    if(!updated)throw failed();
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,requestId:trace,reason:input.rationale,
      action:'catalog.work.match_review.decided',
      entityType:'canonical_work_match_review',entityId:id,
      beforeJson:{status:'pending',reviewVersion:review.reviewVersion,
        evidenceDigest:review.evidenceDigest},
      afterJson:{status:updated.status,reviewVersion:updated.reviewVersion,
        workId:updated.workId,candidateWorkId:updated.candidateWorkId,
        noMerge:true,noPublishing:true,noImportBypass:true},
    });
    return response(updated,true);
  });
}

/** Only admin catalog metadata and review workflow state, no raw sources,
 * rights evidence, reviewer user IDs, source hashes or private content. */
export async function listVerifiedAdminWorkMatchReviews(
  db:Db,bearer:string,workId:string,rawQuery:unknown,
){
  const id=uuid.parse(workId),query=adminWorkMatchQuerySchema.parse(rawQuery);
  return withVerifiedAdminPermission(db,bearer,'catalog:read',async tx=>{
    const [work]=await tx.select({id:schema.works.id}).from(schema.works)
      .where(eq(schema.works.id,id)).limit(1);
    if(!work)return null;
    const pairs=await tx.select().from(schema.canonicalWorkMatchReviews)
      .where(and(or(eq(schema.canonicalWorkMatchReviews.workId,id),
        eq(schema.canonicalWorkMatchReviews.candidateWorkId,id)),
      ...(query.cursor?[gt(schema.canonicalWorkMatchReviews.id,query.cursor)]:[])))
      .orderBy(asc(schema.canonicalWorkMatchReviews.id)).limit(21);
    const page=pairs.slice(0,20);
    const workIds=[...new Set(page.flatMap(row=>[row.workId,row.candidateWorkId]))];
    const entities=workIds.length?await tx.select({
      id:schema.works.id,title:schema.works.originalTitle,
      metadataVersion:schema.works.metadataVersion,
    }).from(schema.works).where(inArray(schema.works.id,workIds)):[];
    const lookup=new Map(entities.map(row=>[row.id,row]));
    return {
      items:page.map(row=>{
        const peerWorkId=row.workId===id?row.candidateWorkId:row.workId;
        const peer=lookup.get(peerWorkId),left=lookup.get(row.workId),
          right=lookup.get(row.candidateWorkId);
        if(!peer||!left||!right)throw failed();
        return {id:row.id,workId:row.workId,candidateWorkId:row.candidateWorkId,
          peerWorkId,peerTitle:peer.title,
          status:row.status,evidenceKind:row.evidenceKind,
          reviewVersion:row.reviewVersion,
          snapshotCurrent:left.metadataVersion===row.workVersion&&
            right.metadataVersion===row.candidateVersion};
      }),
      nextCursor:pairs.length>20?page[19]!.id:null,
    };
  },{isolationLevel:'repeatable read'});
}
