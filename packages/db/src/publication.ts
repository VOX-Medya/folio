import {and,desc,eq,isNull} from 'drizzle-orm';
import {LocalStorageAdapter} from './local-storage.js';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';

type Database=ReturnType<typeof createFolioDb>['db'];
type Transaction=Parameters<Parameters<Database['transaction']>[0]>[0];
type Rights=typeof schema.rightsRecords.$inferSelect;

/** Every scope requires a current reviewed display grant; an absent scope denies publication. */
export function permitsPublication(record:Rights|undefined,territory:string,now:Date,
  action:'display'|'audio'='display'):boolean{
  return !!record && record.reviewStatus==='approved' && !!record.reviewedAt &&
    !!record.reviewedBy &&
    (action==='display'?record.displayAllowed:record.audioAllowed) &&
    record.territories.includes(territory) &&
    (!record.expiresAt || record.expiresAt.getTime()>now.getTime());
}

async function publicationRightsAllowed(tx:Transaction,workId:string,editionId:string,
  revisionId:string,territory:string,action:'display'|'audio'){
  const scopes=[
    and(eq(schema.rightsRecords.workId,workId),isNull(schema.rightsRecords.editionId),isNull(schema.rightsRecords.revisionId)),
    and(eq(schema.rightsRecords.workId,workId),eq(schema.rightsRecords.editionId,editionId),isNull(schema.rightsRecords.revisionId)),
    and(eq(schema.rightsRecords.workId,workId),eq(schema.rightsRecords.editionId,editionId),eq(schema.rightsRecords.revisionId,revisionId)),
  ];
  for(const scope of scopes){
    const [record]=await tx.select().from(schema.rightsRecords).where(scope)
      .orderBy(desc(schema.rightsRecords.createdAt),desc(schema.rightsRecords.id)).limit(1).for('share');
    if(!permitsPublication(record,territory,new Date(),action))return false;
  }
  return true;
}

/** MFA-bound, audited editorial publication. Never changes rights or exposes raw text. */
export async function setVerifiedAdminPublication(
  db:Database,bearer:string,raw:unknown,requestId:string,privateStorageRoot:string,
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
    if(input.action==='publish'&&[work.publicationStatus,edition.status,revision.status].some(x=>x!=='draft')){
      throw new Error('Publication requires an unpublished draft');
    }
    if(input.action==='publish'){
      if(work.publicationStatus==='withdrawn'||edition.status==='withdrawn'||revision.status==='withdrawn'){
        throw new Error('Withdrawn material requires fresh editorial review');
      }
      if(!await publicationRightsAllowed(tx,input.workId,input.editionId,input.revisionId,
        input.territory,'display')){
        throw new Error('Publication requires current approved rights at every scope');
      }
      const [chapter]=await tx.select({id:schema.contentChapters.chapterId}).from(schema.contentChapters)
        .where(eq(schema.contentChapters.revisionId,revision.id)).limit(1);
      const [block]=await tx.select({id:schema.contentBlocks.blockId}).from(schema.contentBlocks)
        .where(eq(schema.contentBlocks.revisionId,revision.id)).limit(1);
      if(!chapter||!block)throw new Error('Publication requires prepared chapter content');
      // Source provenance, catalog ownership, disk inode and actual bytes MUST match
      // the immutable revision. Folioctl imports stay pending until this authorized review.
      const [provenance]=await tx.select({snapshot:schema.sourceProvenance.sourceSnapshot})
        .from(schema.sourceProvenance).where(eq(schema.sourceProvenance.id,revision.provenanceId)).limit(1);
      const source=z.object({
        mediaAssetId:z.uuid(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
      }).passthrough().safeParse(provenance?.snapshot);
      if(!source.success||source.data.sourceSha256!==revision.rawSha256){
        throw new Error('Publication requires a verified catalog source asset');
      }
      const [asset]=await tx.select().from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id,source.data.mediaAssetId)).limit(1).for('update');
      if(!asset||asset.ownerScope!=='catalog'||asset.ownerUserId!==null||
        asset.status!=='pending_verify'||asset.mime!=='text/plain'||
        asset.sha256!==revision.rawSha256||
        revision.rawArtifactKey!=='quarantine/catalog/'+asset.storageKey+'.blob'){
        throw new Error('Publication requires a verified catalog source asset');
      }
      if(!privateStorageRoot||!privateStorageRoot.startsWith('/')){
        throw new Error('Private catalog vault is not configured');
      }
      try {
        await (await LocalStorageAdapter.create(privateStorageRoot))
          .readAdminCatalogQuarantinedText({
            scope:'catalog',ownerUserId:null,status:'pending_verify',
            key:asset.storageKey,sha256:asset.sha256,
            sizeBytes:asset.sizeBytes,mime:'text/plain',
          });
      } catch {
        throw new Error('Publication requires a verified catalog source asset');
      }
      await tx.update(schema.mediaAssets).set({
        status:'verified',verifiedAt:new Date(),
      }).where(eq(schema.mediaAssets.id,asset.id));
      // #35: one manually attached, immutable prepared voice can become playable
      // in this SAME MFA-reviewed publication transaction only if independently
      // approved audio rights exist at all three scopes. Without audio grants,
      // the TEXT may publish, but the voice must remain a private draft.
      const variants=await tx.select().from(schema.audioVariants).where(and(
        eq(schema.audioVariants.contentRevisionId,revision.id),
        eq(schema.audioVariants.status,'draft'),
        eq(schema.audioVariants.voiceId,'prepared.manual'),
      )).limit(2);
      if(variants.length===1&&await publicationRightsAllowed(
        tx,input.workId,input.editionId,input.revisionId,input.territory,'audio')){
        const variant=variants[0]!;
        const segments=await tx.select().from(schema.audioSegments)
          .where(eq(schema.audioSegments.variantId,variant.id)).limit(2);
        const segment=segments[0];
        if(segments.length!==1||!segment||segment.ordinal!==0||segment.startMs!==0||
           segment.endMs<=0||variant.language!==revision.language){
          throw new Error('Prepared audio segment metadata is not reviewable');
        }
        const [textBlock]=await tx.select().from(schema.contentBlocks).where(and(
          eq(schema.contentBlocks.revisionId,revision.id),
          eq(schema.contentBlocks.chapterId,segment.chapterId),
          eq(schema.contentBlocks.blockId,segment.textBlockId),
        )).limit(1);
        if(!textBlock||!textBlock.includeAudio||
           textBlock.textSha256!==segment.textSha256){
          throw new Error('Prepared voice is not anchored to approved text');
        }
        const [voiceAsset]=await tx.select().from(schema.mediaAssets)
          .where(eq(schema.mediaAssets.id,segment.assetId)).limit(1).for('update');
        const expectedMime=variant.codec==='opus'?'audio/ogg':
          variant.codec==='m4a'?'audio/mp4':null;
        if(!voiceAsset||!expectedMime||voiceAsset.ownerScope!=='catalog'||
           voiceAsset.ownerUserId!==null||voiceAsset.status!=='pending_verify'||
           voiceAsset.mime!==expectedMime||
           !voiceAsset.durationMs||segment.endMs>voiceAsset.durationMs||
           voiceAsset.sizeBytes<1||voiceAsset.sizeBytes>16*1024*1024||
           !z.uuid().safeParse(voiceAsset.storageKey).success){
          throw new Error('Prepared voice requires verified catalog quarantine');
        }
        // Actual private bytes, size, owner, inode and SHA-256 are verified.
        // Metadata alone and a mere rights claim NEVER authorize playback.
        await (await LocalStorageAdapter.create(privateStorageRoot)).inspectQuarantined({
          scope:'catalog',ownerUserId:null,status:'pending_verify',
          key:voiceAsset.storageKey,sha256:voiceAsset.sha256,
          sizeBytes:voiceAsset.sizeBytes,mime:expectedMime,
        });
        await tx.update(schema.mediaAssets).set({status:'verified',verifiedAt:new Date()})
          .where(eq(schema.mediaAssets.id,voiceAsset.id));
        await tx.update(schema.audioVariants).set({status:'published'})
          .where(eq(schema.audioVariants.id,variant.id));
        await tx.insert(schema.auditEvents).values({
          actorId:who.userId,requestId:trace,action:'audio.prepared.publish',
          entityType:'audio_variant',entityId:variant.id,
          afterJson:{revisionId:revision.id,assetId:voiceAsset.id,
            sha256:voiceAsset.sha256,territory:input.territory},
          reason:input.reason,
        });
      }
    }else if(revision.status!=='published'||edition.status!=='published'||
      work.publicationStatus!=='published'){
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
