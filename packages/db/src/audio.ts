import {and,desc,eq} from 'drizzle-orm';
import {z} from 'zod';
import {audioVariantInputSchema,preparedAudioAssetSchema,audioSegmentInputSchema} from '@folio/contracts';
import type {AudioVariantInput,PreparedAudioAsset} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type AudioDb=ReturnType<typeof createFolioDb>['db'];

/** Metadata-only registration. Actual asset bytes MUST be verified by the private StorageAdapter before playback. */
export async function registerPreparedAudioAsset(db:AudioDb,actorId:string,raw:unknown){
  const actor=z.uuid().parse(actorId);
  const asset:PreparedAudioAsset=preparedAudioAssetSchema.parse(raw);
  return db.transaction(async tx=>{
    const [created]=await tx.insert(schema.mediaAssets).values({
      ownerScope:'catalog',ownerUserId:null,storageKey:asset.storageKey,sha256:asset.sha256,
      sizeBytes:asset.sizeBytes,mime:asset.mime,durationMs:asset.durationMs,status:'pending_verify',
    }).returning();
    if(!created)throw new Error('Asset manifest rejected');
    await tx.insert(schema.auditEvents).values({actorId:actor,action:'audio.asset.submit',
      entityType:'media_asset',entityId:created.id,
      afterJson:{sha256:created.sha256,sizeBytes:created.sizeBytes,mime:created.mime,status:'pending_verify'}});
    return created;
  });
}

async function checkSegmentReferences(tx:Parameters<Parameters<AudioDb['transaction']>[0]>[0],
  revisionId:string,codec:'m4a'|'opus',segments:AudioVariantInput['segments']):Promise<void>{
  const mime=codec==='m4a'?'audio/mp4':'audio/ogg';
  const chapters=await tx.select().from(schema.contentChapters).where(eq(schema.contentChapters.revisionId,revisionId));
  const blocks=await tx.select().from(schema.contentBlocks).where(eq(schema.contentBlocks.revisionId,revisionId));
  const mediaIds=[...new Set(segments.map(s=>s.assetId))];
  for(const segment of segments){
    if(!chapters.some(ch=>ch.chapterId===segment.chapterId))throw new Error('Audio chapter belongs to another revision');
    if(!blocks.some(block=>block.blockId===segment.textBlockId && block.chapterId===segment.chapterId &&
       block.textSha256===segment.textSha256 && block.includeAudio)){
      throw new Error('Audio segment text hash/anchor does not match an audio-included source block');
    }
  }
  for(const assetId of mediaIds){
    const [asset]=await tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id,assetId)).limit(1);
    if(!asset || asset.ownerScope!=='catalog' || asset.mime!==mime || !asset.durationMs){
      throw new Error('Audio asset missing, wrong codec or wrong owner scope');
    }
    const selected=segments.filter(s=>s.assetId===assetId);
    if(selected.some(s=>s.endMs>asset.durationMs!))throw new Error('Audio timestamp exceeds prepared file duration');
  }
}

/** Create a fresh draft variant. Never mark it playable without checksum, rights and editorial approval. */
export async function registerPreparedAudioVariant(db:AudioDb,actorId:string,raw:unknown){
  const actor=z.uuid().parse(actorId);
  const input:AudioVariantInput=audioVariantInputSchema.parse(raw);
  return db.transaction(async tx=>{
    const [revision]=await tx.select().from(schema.contentRevisions)
      .where(eq(schema.contentRevisions.id,input.contentRevisionId)).limit(1);
    if(!revision||revision.language!==input.language)throw new Error('Audio variant revision/language mismatch');
    await checkSegmentReferences(tx,revision.id,input.codec,input.segments);
    const [previous]=await tx.select().from(schema.audioVariants).where(and(
      eq(schema.audioVariants.contentRevisionId,revision.id),eq(schema.audioVariants.language,input.language),
      eq(schema.audioVariants.voiceId,input.voiceId),
    )).orderBy(desc(schema.audioVariants.variantVersion)).limit(1);
    const [variant]=await tx.insert(schema.audioVariants).values({
      contentRevisionId:revision.id,language:input.language,voiceId:input.voiceId,
      sourceLabel:input.sourceLabel,codec:input.codec,
      variantVersion:(previous?.variantVersion??0)+1,supersedesVariantId:previous?.id??null,
      status:'draft',createdBy:actor,
    }).returning();
    if(!variant)throw new Error('Audio variant creation failed');
    await tx.insert(schema.audioSegments).values(input.segments.map(s=>({variantId:variant.id,...s})));
    await tx.insert(schema.auditEvents).values({actorId:actor,action:'audio.variant.create',
      entityType:'audio_variant',entityId:variant.id,
      afterJson:{revisionId:revision.id,voiceId:variant.voiceId,version:variant.variantVersion,
        supersedesVariantId:variant.supersedesVariantId,segmentCount:input.segments.length,status:'draft'}});
    return variant;
  });
}

/** Replacement creates a new variant and leaves every old segment untouched. */
export async function replacePreparedAudioSegment(db:AudioDb,actorId:string,oldVariantId:string,raw:unknown){
  const actor=z.uuid().parse(actorId);
  const id=z.uuid().parse(oldVariantId);
  const replacement=audioSegmentInputSchema.parse(raw);
  const [oldVariant]=await db.select().from(schema.audioVariants).where(eq(schema.audioVariants.id,id)).limit(1);
  if(!oldVariant)throw new Error('Original audio variant not found');
  const oldSegments=await db.select().from(schema.audioSegments).where(eq(schema.audioSegments.variantId,id));
  if(!oldSegments.some(s=>s.chapterId===replacement.chapterId && s.ordinal===replacement.ordinal)){
    throw new Error('Original segment position does not exist');
  }
  return registerPreparedAudioVariant(db,actor,{
    contentRevisionId:oldVariant.contentRevisionId,language:oldVariant.language,
    voiceId:oldVariant.voiceId,sourceLabel:oldVariant.sourceLabel,codec:oldVariant.codec,
    segments:oldSegments.map(s=>s.chapterId===replacement.chapterId&&s.ordinal===replacement.ordinal
      ?replacement:{chapterId:s.chapterId,ordinal:s.ordinal,assetId:s.assetId,textBlockId:s.textBlockId,
        textSha256:s.textSha256,startMs:s.startMs,endMs:s.endMs}),
  });
}

/** Internal metadata inspection; public playback requires later rights/auth/storage verification. */
export async function getPreparedAudioVariant(db:AudioDb,variantId:string){
  const id=z.uuid().parse(variantId);
  const [variant]=await db.select().from(schema.audioVariants).where(eq(schema.audioVariants.id,id)).limit(1);
  if(!variant)return null;
  const segments=await db.select().from(schema.audioSegments).where(eq(schema.audioSegments.variantId,id));
  return {variant,segments:segments.sort((a,b)=>a.chapterId.localeCompare(b.chapterId)||a.ordinal-b.ordinal)};
}
