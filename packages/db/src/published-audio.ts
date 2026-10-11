import {and,desc,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {sha256Text} from './content.js';
import {hasCurrentCatalogGrant} from './published-book.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const uuid=z.uuid();
const sha=z.string().regex(/^[a-f0-9]{64}$/);

/**
 * #35 Server-internal audio descriptor, NEVER serialized as JSON.
 * A fresh repeatable-read transaction checks published work/edition/revision,
 * BOTH display and audio permission at all three rights scopes, immutable
 * source provenance, verified catalog ownership and exact chapter/block SHA.
 * The caller must subsequently read and rehash the private inode.
 */
export async function getAuthorizedPublishedAudio(
  db:Database,rawRevisionId:unknown,rawChapterId:unknown,rawTerritory:unknown,
){
  const revisionId=uuid.parse(rawRevisionId),chapterId=uuid.parse(rawChapterId);
  const territory=z.string().regex(/^[A-Z]{2}$/).parse(rawTerritory);
  return db.transaction(async tx=>{
    const [source]=await tx.select({
      workId:schema.works.id,editionId:schema.editions.id,
      provenanceId:schema.contentRevisions.provenanceId,
      rawSha256:schema.contentRevisions.rawSha256,
      language:schema.contentRevisions.language,
    }).from(schema.contentRevisions)
      .innerJoin(schema.editions,eq(schema.editions.id,schema.contentRevisions.editionId))
      .innerJoin(schema.works,eq(schema.works.id,schema.editions.workId))
      .where(and(eq(schema.contentRevisions.id,revisionId),
        eq(schema.contentRevisions.status,'published'),
        eq(schema.editions.status,'published'),
        eq(schema.works.publicationStatus,'published'))).limit(1);
    if(!source)return null;
    const scopes=[
      and(eq(schema.rightsRecords.workId,source.workId),isNull(schema.rightsRecords.editionId),
        isNull(schema.rightsRecords.revisionId)),
      and(eq(schema.rightsRecords.workId,source.workId),
        eq(schema.rightsRecords.editionId,source.editionId),isNull(schema.rightsRecords.revisionId)),
      and(eq(schema.rightsRecords.workId,source.workId),
        eq(schema.rightsRecords.editionId,source.editionId),
        eq(schema.rightsRecords.revisionId,revisionId)),
    ];
    const now=new Date();
    for(const condition of scopes){
      const [grant]=await tx.select().from(schema.rightsRecords).where(condition)
        .orderBy(desc(schema.rightsRecords.createdAt),desc(schema.rightsRecords.id)).limit(1);
      if(!hasCurrentCatalogGrant(grant,'display',territory,now)||
         !hasCurrentCatalogGrant(grant,'audio',territory,now))return null;
    }
    const [provenance]=await tx.select({claim:schema.sourceProvenance.sourceSnapshot})
      .from(schema.sourceProvenance)
      .where(eq(schema.sourceProvenance.id,source.provenanceId)).limit(1);
    const claim=z.object({mediaAssetId:uuid,sourceSha256:sha})
      .passthrough().safeParse(provenance?.claim);
    if(!claim.success||claim.data.sourceSha256!==source.rawSha256)return null;
    const [original]=await tx.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,claim.data.mediaAssetId)).limit(1);
    if(!original||original.ownerScope!=='catalog'||original.ownerUserId!==null||
       original.status!=='verified'||!original.verifiedAt||
       original.mime!=='text/plain'||original.sha256!==source.rawSha256)return null;
    const [chapter]=await tx.select({id:schema.contentChapters.chapterId})
      .from(schema.contentChapters)
      .where(and(eq(schema.contentChapters.revisionId,revisionId),
        eq(schema.contentChapters.chapterId,chapterId))).limit(1);
    if(!chapter)return null;
    const variants=await tx.select().from(schema.audioVariants)
      .where(and(eq(schema.audioVariants.contentRevisionId,revisionId),
        eq(schema.audioVariants.status,'published')))
      .orderBy(desc(schema.audioVariants.variantVersion),desc(schema.audioVariants.id)).limit(10);
    for(const variant of variants){
      if(variant.language!==source.language)continue;
      const [segment]=await tx.select().from(schema.audioSegments).where(and(
        eq(schema.audioSegments.variantId,variant.id),
        eq(schema.audioSegments.chapterId,chapterId),
        eq(schema.audioSegments.ordinal,0),
      )).limit(1);
      if(!segment||segment.startMs!==0||segment.endMs<=0)continue;
      const [block]=await tx.select().from(schema.contentBlocks).where(and(
        eq(schema.contentBlocks.revisionId,revisionId),
        eq(schema.contentBlocks.chapterId,chapterId),
        eq(schema.contentBlocks.blockId,segment.textBlockId),
      )).limit(1);
      if(!block||!block.includeAudio||block.textSha256!==segment.textSha256||
         sha256Text(block.sourceText)!==block.textSha256)continue;
      const [asset]=await tx.select().from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id,segment.assetId)).limit(1);
      const mime:'audio/ogg'|'audio/mp4'|null=variant.codec==='opus'?'audio/ogg':variant.codec==='m4a'?'audio/mp4':null;
      if(!mime||!asset||asset.ownerScope!=='catalog'||asset.ownerUserId!==null||
         asset.status!=='verified'||!asset.verifiedAt||asset.mime!==mime||
         !uuid.safeParse(asset.storageKey).success||
         !sha.safeParse(asset.sha256).success||
         asset.sizeBytes<1||asset.sizeBytes>16*1024*1024||
         !asset.durationMs||segment.endMs>asset.durationMs)continue;
      return {revisionId,chapterId,mime,sizeBytes:asset.sizeBytes,
        asset:{scope:'catalog' as const,ownerUserId:null,status:'verified' as const,
          key:asset.storageKey,sha256:asset.sha256,
          sizeBytes:asset.sizeBytes,mime}};
    }
    return null;
  },{isolationLevel:'repeatable read'});
}
