import {and,desc,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';

type Database=ReturnType<typeof createFolioDb>['db'];
type Transaction=Parameters<Parameters<Database['transaction']>[0]>[0];
type Rights=typeof schema.rightsRecords.$inferSelect;

/** Every scope requires a current reviewed display grant; an absent scope denies publication. */
export function permitsPublication(record:Rights|undefined,territory:string,now:Date):boolean{
  return !!record && record.reviewStatus==='approved' && !!record.reviewedAt &&
    !!record.reviewedBy && record.displayAllowed &&
    record.territories.includes(territory) &&
    (!record.expiresAt || record.expiresAt.getTime()>now.getTime());
}

async function requirePublicationRights(tx:Transaction,workId:string,editionId:string,revisionId:string,territory:string){
  const scopes=[
    and(eq(schema.rightsRecords.workId,workId),isNull(schema.rightsRecords.editionId),isNull(schema.rightsRecords.revisionId)),
    and(eq(schema.rightsRecords.workId,workId),eq(schema.rightsRecords.editionId,editionId),isNull(schema.rightsRecords.revisionId)),
    and(eq(schema.rightsRecords.workId,workId),eq(schema.rightsRecords.editionId,editionId),eq(schema.rightsRecords.revisionId,revisionId)),
  ];
  for(const scope of scopes){
    const [record]=await tx.select().from(schema.rightsRecords).where(scope)
      .orderBy(desc(schema.rightsRecords.createdAt),desc(schema.rightsRecords.id)).limit(1);
    if(!permitsPublication(record,territory,new Date()))throw new Error('Publication requires current approved rights at every scope');
  }
}

/** MFA-bound, audited editorial publication. Never changes rights or exposes raw text. */
export async function setVerifiedAdminPublication(
  db:Database,bearer:string,raw:unknown,requestId:string,
){
  const input=z.object({
    workId:z.uuid(),editionId:z.uuid(),revisionId:z.uuid(),
    action:z.enum(['publish','withdraw']),
    territory:z.string().regex(/^[A-Z]{2}$/),
    reason:z.string().trim().min(8).max(500),
  }).strict().parse(raw);
  const trace=z.uuid().parse(requestId);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,who)=>{
    const [work]=await tx.select().from(schema.works)
      .where(eq(schema.works.id,input.workId)).limit(1).for('update');
    const [edition]=await tx.select().from(schema.editions)
      .where(and(eq(schema.editions.id,input.editionId),eq(schema.editions.workId,input.workId)))
      .limit(1).for('update');
    const [revision]=await tx.select().from(schema.contentRevisions)
      .where(and(eq(schema.contentRevisions.id,input.revisionId),eq(schema.contentRevisions.editionId,input.editionId)))
      .limit(1).for('update');
    if(!work||!edition||!revision)throw new Error('Publication scope not found');
    const target=input.action==='publish'?'published':'withdrawn';
    if(input.action==='publish'){
      if(work.publicationStatus==='withdrawn'||edition.status==='withdrawn'||revision.status==='withdrawn'){
        throw new Error('Withdrawn material requires fresh editorial review');
      }
      await requirePublicationRights(tx,input.workId,input.editionId,input.revisionId,input.territory);
      const [chapter]=await tx.select({id:schema.contentChapters.chapterId}).from(schema.contentChapters)
        .where(eq(schema.contentChapters.revisionId,revision.id)).limit(1);
      const [block]=await tx.select({id:schema.contentBlocks.blockId}).from(schema.contentBlocks)
        .where(eq(schema.contentBlocks.revisionId,revision.id)).limit(1);
      if(!chapter||!block)throw new Error('Publication requires prepared chapter content');
      const [asset]=await tx.select({id:schema.mediaAssets.id}).from(schema.mediaAssets)
        .where(and(eq(schema.mediaAssets.ownerScope,'catalog'),eq(schema.mediaAssets.status,'verified'),
          eq(schema.mediaAssets.sha256,revision.rawSha256))).limit(1);
      if(!asset)throw new Error('Publication requires a verified catalog source asset');
    }else if(revision.status!=='published'){
      throw new Error('Only a published revision may be withdrawn');
    }
    await tx.update(schema.contentRevisions).set({status:target})
      .where(eq(schema.contentRevisions.id,revision.id));
    await tx.update(schema.editions).set({status:target})
      .where(eq(schema.editions.id,edition.id));
    await tx.update(schema.works).set({publicationStatus:target})
      .where(eq(schema.works.id,work.id));
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,requestId:trace,action:'catalog.publication.'+input.action,
      entityType:'content_revision',entityId:revision.id,
      beforeJson:{workStatus:work.publicationStatus,editionStatus:edition.status,revisionStatus:revision.status},
      afterJson:{workStatus:target,editionStatus:target,revisionStatus:target,territory:input.territory},
      reason:input.reason,
    });
    return {workId:work.id,editionId:edition.id,revisionId:revision.id,status:target};
  });
}
