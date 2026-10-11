import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {payloadHash} from './import-staging.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import {LocalStorageAdapter} from './local-storage.js';
import type {CandidateMime} from './local-storage.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const source=z.object({
  packageId:z.uuid(),
  title:z.string().min(1).max(400),language:z.enum(['tr','en']),
  editionLabel:z.string().min(1).max(400),
  textSha256:digest,
  audio:z.object({
    sha256:digest,
    sizeBytes:z.number().int().positive().max(200*1024*1024),
    mime:z.enum(['audio/mp4','audio/ogg']),
    durationMs:z.number().int().positive().max(86_400_000),
  }).strict(),
}).strict();

/**
 * A single already-imported folioctl DRAFT can have one external prepared
 * audio file attached. The source was checked on disk by folioctl and will
 * be streamed through the hash-checking 0600 catalog quarantine adapter.
 * No duration, codec, license or human clearance is inferred. The asset and
 * variant remain non-playable drafts until separately approved.
 *
 * The current same-device MFA audio:replace session is checked in the SAME
 * DB transaction as all package, source revision and private asset writes.
 */
export async function attachVerifiedPreparedAudio(
  db:Database,bearer:string,raw:unknown,storageRoot:string,
  preparedBytes:AsyncIterable<Uint8Array>,
){
  const input=source.parse(raw);
  if(typeof storageRoot!=='string'||!storageRoot.startsWith('/')){
    throw new Error('An explicit absolute Folio private storage root is required');
  }
  return withVerifiedAdminPermission(db,bearer,'audio:replace',async(tx,actor)=>{
    await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(hashtext('folioctl-single-audio-attach'))"));
    const [batch]=await tx.select().from(schema.importBatches)
      .where(eq(schema.importBatches.packageId,input.packageId)).limit(1);
    if(!batch||batch.status!=='applied'||batch.isDryRun||batch.expectedItems!==1){
      throw new Error('Prepared audio requires an already applied Folio package');
    }
    const items=await tx.select().from(schema.importItems)
      .where(eq(schema.importItems.batchId,batch.id)).limit(2);
    const record=items[0];
    const identity=z.object({
      workId:z.uuid(),editionId:z.uuid(),revisionId:z.uuid(),
      assetId:z.uuid(),sourceSha256:digest,
    }).strict().safeParse(record?.payload);
    if(items.length!==1||!record||record.kind!=='book'||
       record.status!=='applied'||record.payloadSha256!==payloadHash(record.payload)||
       !identity.success||identity.data.sourceSha256!==input.textSha256){
      throw new Error('Audio source manifest does not match committed import');
    }
    const {workId,editionId,revisionId}=identity.data;
    const [work]=await tx.select().from(schema.works).where(eq(schema.works.id,workId)).limit(1);
    const [edition]=await tx.select().from(schema.editions).where(eq(schema.editions.id,editionId)).limit(1);
    const [revision]=await tx.select().from(schema.contentRevisions)
      .where(eq(schema.contentRevisions.id,revisionId)).limit(1);
    if(!work||!edition||!revision||work.publicationStatus!=='draft'||
       work.originalTitle!==input.title||work.originalLanguage!==input.language||
       edition.workId!==work.id||edition.status!=='draft'||
       edition.label!==input.editionLabel||edition.language!==input.language||
       revision.editionId!==edition.id||revision.status!=='draft'||
       revision.language!==input.language||revision.rawSha256!==input.textSha256){
      throw new Error('Audio work/edition/source identity mismatch or not a draft');
    }
    const [chapter]=await tx.select().from(schema.contentChapters)
      .where(eq(schema.contentChapters.revisionId,revision.id)).limit(2);
    const blocks=await tx.select().from(schema.contentBlocks)
      .where(eq(schema.contentBlocks.revisionId,revision.id)).limit(2);
    const block=blocks[0];
    if(!chapter||blocks.length!==1||!block||block.chapterId!==chapter.chapterId||
       block.textSha256!==input.textSha256||!block.includeAudio){
      throw new Error('Prepared audio requires an audio-addressable source revision');
    }
    const existing=await tx.select({id:schema.audioVariants.id})
      .from(schema.audioVariants)
      .where(and(eq(schema.audioVariants.contentRevisionId,revision.id),
        eq(schema.audioVariants.voiceId,'prepared.manual'))).limit(1);
    if(existing.length)throw new Error('Prepared manual audio already attached; no silent overwrite');

    const storage=await LocalStorageAdapter.create(storageRoot);
    const candidate=await storage.stage({
      owner:{scope:'catalog',ownerUserId:null},source:preparedBytes,
      declaredSha256:input.audio.sha256,declaredMime:input.audio.mime as CandidateMime,
      maxBytes:input.audio.sizeBytes,
    });
    if(candidate.sizeBytes!==input.audio.sizeBytes){
      throw new Error('Audio byte count differs from prepared metadata');
    }
    await storage.inspectQuarantined(candidate);
    const [asset]=await tx.insert(schema.mediaAssets).values({
      ownerScope:'catalog',ownerUserId:null,storageKey:candidate.key,
      sha256:candidate.sha256,sizeBytes:candidate.sizeBytes,mime:input.audio.mime,
      durationMs:input.audio.durationMs,status:'pending_verify',
    }).returning();
    if(!asset)throw new Error('Audio staging record missing');
    const [variant]=await tx.insert(schema.audioVariants).values({
      contentRevisionId:revision.id,language:revision.language,
      voiceId:'prepared.manual',sourceLabel:'Prepared manual file',
      codec:input.audio.mime==='audio/ogg'?'opus':'m4a',
      variantVersion:1,status:'draft',createdBy:actor.userId,
    }).returning();
    if(!variant)throw new Error('Prepared audio variant missing');
    await tx.insert(schema.audioSegments).values({
      variantId:variant.id,chapterId:chapter.chapterId,ordinal:0,
      assetId:asset.id,textBlockId:block.blockId,textSha256:block.textSha256,
      startMs:0,endMs:input.audio.durationMs,
    });
    await tx.insert(schema.auditEvents).values({
      actorId:actor.userId,action:'audio.prepared.attach',
      entityType:'audio_variant',entityId:variant.id,
      afterJson:{revisionId:revision.id,assetId:asset.id,
        sha256:asset.sha256,status:'draft',rights:'unreviewed'},
    });
    return {workId,editionId,revisionId,assetId:asset.id,
      variantId:variant.id,audioStatus:'pending_verify' as const,
      variantStatus:'draft' as const,publication:'draft' as const};
  });
}
