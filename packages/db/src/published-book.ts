import {and,asc,desc,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import {publishedBookDetailSchema,publishedReaderTextSchema} from '@folio/contracts';
import {sha256Text} from './content.js';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type CatalogDb=ReturnType<typeof createFolioDb>['db'];
type Tx=Parameters<Parameters<CatalogDb['transaction']>[0]>[0];
type Grant=typeof schema.rightsRecords.$inferSelect;

export function hasCurrentCatalogGrant(
  record:Grant|undefined,action:'display'|'audio',territory:string,now:Date,
):boolean{
  return !!record&&record.reviewStatus==='approved'&&!!record.reviewedBy&&
    !!record.reviewedAt&&record.territories.includes(territory)&&
    (record.expiresAt===null||record.expiresAt>now)&&
    (action==='display'?record.displayAllowed:record.audioAllowed);
}

/** Latest work, edition AND revision claims must ALL approve this territory/action. */
async function rightsAllowed(
  tx:Tx,workId:string,editionId:string,revisionId:string,
  action:'display'|'audio',territory:string,now:Date,
):Promise<boolean>{
  const filters=[
    and(eq(schema.rightsRecords.workId,workId),isNull(schema.rightsRecords.editionId),isNull(schema.rightsRecords.revisionId)),
    and(eq(schema.rightsRecords.workId,workId),eq(schema.rightsRecords.editionId,editionId),isNull(schema.rightsRecords.revisionId)),
    and(eq(schema.rightsRecords.workId,workId),eq(schema.rightsRecords.editionId,editionId),eq(schema.rightsRecords.revisionId,revisionId)),
  ];
  for(const filter of filters){
    const [grant]=await tx.select().from(schema.rightsRecords).where(filter)
      .orderBy(desc(schema.rightsRecords.createdAt),desc(schema.rightsRecords.id)).limit(1);
    if(!hasCurrentCatalogGrant(grant,action,territory,now))return false;
  }
  return true;
}

/** A prepared variant is advertised only when it can be backed by verified media. */
async function hasVerifiedPreparedAudio(tx:Tx,revisionId:string):Promise<boolean>{
  const variants=await tx.select().from(schema.audioVariants).where(and(
    eq(schema.audioVariants.contentRevisionId,revisionId),
    eq(schema.audioVariants.status,'published'),
  )).limit(25);
  for(const variant of variants){
    const segments=await tx.select({
      asset:schema.mediaAssets,segment:schema.audioSegments,
    }).from(schema.audioSegments)
      .innerJoin(schema.mediaAssets,eq(schema.mediaAssets.id,schema.audioSegments.assetId))
      .where(eq(schema.audioSegments.variantId,variant.id)).limit(501);
    if(segments.length===0||segments.length>500)continue;
    const mime=variant.codec==='m4a'?'audio/mp4':variant.codec==='opus'?'audio/ogg':null;
    if(mime&&segments.every(({asset,segment})=>
      asset.ownerScope==='catalog'&&asset.ownerUserId===null&&
      asset.status==='verified'&&!!asset.verifiedAt&&asset.mime===mime&&
      segment.startMs>=0&&segment.endMs>segment.startMs&&
      asset.durationMs!==null&&segment.endMs<=asset.durationMs
    ))return true;
  }
  return false;
}

/** Public metadata ONLY. Never return source bytes, vault keys, user shelves or pending rights. */
export async function getPublishedBookDetail(
  db:CatalogDb,rawWorkId:unknown,rawTerritory:unknown,
){
  const workId=z.uuid().parse(rawWorkId);
  const territory=z.string().regex(/^[A-Z]{2}$/).parse(rawTerritory);
  return db.transaction(async tx=>{
    const [work]=await tx.select().from(schema.works).where(and(
      eq(schema.works.id,workId),eq(schema.works.publicationStatus,'published'),
    )).limit(1);
    if(!work)return null;
    const revisions=await tx.select({
      editionId:schema.editions.id,language:schema.editions.language,
      label:schema.editions.label,revisionId:schema.contentRevisions.id,
      rawSha256:schema.contentRevisions.rawSha256,
      provenanceId:schema.contentRevisions.provenanceId,
    }).from(schema.editions).innerJoin(schema.contentRevisions,and(
      eq(schema.contentRevisions.editionId,schema.editions.id),
      eq(schema.contentRevisions.status,'published'),
    )).where(and(eq(schema.editions.workId,workId),eq(schema.editions.status,'published')))
      .orderBy(asc(schema.editions.id),asc(schema.contentRevisions.id)).limit(51);
    const now=new Date();
    const editions: {id:string;language:'tr'|'en';label:string;revisionId:string;audioAvailable:boolean}[]=[];
    const selected=new Set<string>();
    for(const row of revisions){
      if(selected.has(row.editionId)||editions.length>=50)continue;
      if(row.language!=='tr'&&row.language!=='en')continue;
      if(!await rightsAllowed(tx,workId,row.editionId,row.revisionId,'display',territory,now))continue;
      const [source]=await tx.select({snapshot:schema.sourceProvenance.sourceSnapshot})
        .from(schema.sourceProvenance).where(eq(schema.sourceProvenance.id,row.provenanceId)).limit(1);
      const claim=z.object({mediaAssetId:z.uuid(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/)})
        .passthrough().safeParse(source?.snapshot);
      if(!claim.success||claim.data.sourceSha256!==row.rawSha256)continue;
      const [asset]=await tx.select({
        ownerScope:schema.mediaAssets.ownerScope,ownerUserId:schema.mediaAssets.ownerUserId,
        status:schema.mediaAssets.status,verifiedAt:schema.mediaAssets.verifiedAt,
        sha256:schema.mediaAssets.sha256,mime:schema.mediaAssets.mime,
      }).from(schema.mediaAssets).where(eq(schema.mediaAssets.id,claim.data.mediaAssetId)).limit(1);
      if(!asset||asset.ownerScope!=='catalog'||asset.ownerUserId!==null||
        asset.status!=='verified'||!asset.verifiedAt||asset.sha256!==row.rawSha256||
        asset.mime!=='text/plain')continue;
      const audioAllowed=await rightsAllowed(tx,workId,row.editionId,row.revisionId,'audio',territory,now);
      editions.push({
        id:row.editionId,language:row.language,label:row.label,revisionId:row.revisionId,
        audioAvailable:audioAllowed&&await hasVerifiedPreparedAudio(tx,row.revisionId),
      });
      selected.add(row.editionId);
    }
    if(editions.length===0)return null;
    const authors=await tx.select({id:schema.authors.id,name:schema.authors.canonicalName})
      .from(schema.workAuthors)
      .innerJoin(schema.authors,eq(schema.authors.id,schema.workAuthors.authorId))
      .where(eq(schema.workAuthors.workId,workId))
      .orderBy(asc(schema.workAuthors.sortOrder),asc(schema.authors.id)).limit(50);
    return publishedBookDetailSchema.parse({
      id:work.id,title:work.originalTitle,originalLanguage:work.originalLanguage,
      authors,editions,
    });
  },{isolationLevel:'repeatable read'});
}

/** #33 Public text requires published revision, current three-scope rights and
 * verified original source in ONE repeatable-read snapshot. No draft/owner body,
 * storage key, raw asset, unverified checksum or rights evidence is serialized. */
export async function getPublishedReaderText(
  db:CatalogDb,rawRevisionId:unknown,rawTerritory:unknown,
){
  const revisionId=z.uuid().parse(rawRevisionId);
  const territory=z.string().regex(/^[A-Z]{2}$/).parse(rawTerritory);
  return db.transaction(async tx=>{
    const [found]=await tx.select({
      revisionId:schema.contentRevisions.id,editionId:schema.editions.id,
      workId:schema.works.id,title:schema.works.originalTitle,
      language:schema.contentRevisions.language,
      provenanceId:schema.contentRevisions.provenanceId,
      rawSha256:schema.contentRevisions.rawSha256,
    }).from(schema.contentRevisions)
      .innerJoin(schema.editions,eq(schema.editions.id,schema.contentRevisions.editionId))
      .innerJoin(schema.works,eq(schema.works.id,schema.editions.workId))
      .where(and(eq(schema.contentRevisions.id,revisionId),
        eq(schema.contentRevisions.status,'published'),
        eq(schema.editions.status,'published'),
        eq(schema.works.publicationStatus,'published'))).limit(1);
    if(!found||(found.language!=='tr'&&found.language!=='en'))return null;
    const now=new Date();
    if(!await rightsAllowed(tx,found.workId,found.editionId,revisionId,'display',territory,now)){
      return null;
    }
    const [source]=await tx.select({snapshot:schema.sourceProvenance.sourceSnapshot})
      .from(schema.sourceProvenance)
      .where(eq(schema.sourceProvenance.id,found.provenanceId)).limit(1);
    const claim=z.object({mediaAssetId:z.uuid(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/)})
      .passthrough().safeParse(source?.snapshot);
    if(!claim.success||claim.data.sourceSha256!==found.rawSha256)return null;
    const [asset]=await tx.select({
      scope:schema.mediaAssets.ownerScope,owner:schema.mediaAssets.ownerUserId,
      status:schema.mediaAssets.status,verifiedAt:schema.mediaAssets.verifiedAt,
      sha256:schema.mediaAssets.sha256,mime:schema.mediaAssets.mime,
    }).from(schema.mediaAssets).where(eq(schema.mediaAssets.id,claim.data.mediaAssetId)).limit(1);
    if(!asset||asset.scope!=='catalog'||asset.owner!==null||
      asset.status!=='verified'||!asset.verifiedAt||
      asset.sha256!==found.rawSha256||asset.mime!=='text/plain')return null;
    // This first reader accepts only a small, complete plaintext catalogue book.
    // Reject oversized/empty revisions rather than return silently truncated text.
    const chapters=await tx.select({
      id:schema.contentChapters.chapterId,ordinal:schema.contentChapters.ordinal,
      heading:schema.contentChapters.heading,
    }).from(schema.contentChapters)
      .where(eq(schema.contentChapters.revisionId,revisionId))
      .orderBy(asc(schema.contentChapters.ordinal)).limit(81);
    if(!chapters.length||chapters.length>80)return null;
    const blocks=await tx.select({
      id:schema.contentBlocks.blockId,chapterId:schema.contentBlocks.chapterId,
      ordinal:schema.contentBlocks.ordinal,kind:schema.contentBlocks.kind,
      text:schema.contentBlocks.sourceText,sha256:schema.contentBlocks.textSha256,
      includeRsvp:schema.contentBlocks.includeRsvp,
    }).from(schema.contentBlocks).where(and(
      eq(schema.contentBlocks.revisionId,revisionId),eq(schema.contentBlocks.includeNormal,true),
    )).orderBy(asc(schema.contentBlocks.chapterId),asc(schema.contentBlocks.ordinal))
      .limit(4001);
    if(!blocks.length||blocks.length>4000)return null;
    if(blocks.some(b=>b.text.length>30000||sha256Text(b.text)!==b.sha256))return null;
    const data={
      workId:found.workId,revisionId:found.revisionId,title:found.title,
      language:found.language,
      chapters:chapters.map(ch=>({
        id:ch.id,heading:ch.heading,
        blocks:blocks.filter(b=>b.chapterId===ch.id).map(b=>({
          id:b.id,kind:b.kind,text:b.text,includeRsvp:b.includeRsvp,
        })),
      })).filter(ch=>ch.blocks.length>0),
    };
    return publishedReaderTextSchema.safeParse(data).success
      ?publishedReaderTextSchema.parse(data):null;
  },{isolationLevel:'repeatable read'});
}
