import {and,eq,isNull} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import {LocalStorageAdapter} from './local-storage.js';
import * as schema from './schema.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const inputSchema=z.object({
  workId:z.uuid(),editionId:z.uuid(),revisionId:z.uuid(),
}).strict();
const sourceRef=z.object({
  mediaAssetId:z.uuid(),
  sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
}).passthrough();

/**
 * Editorial read only: the bearer must be a live same-device MFA catalog
 * reader. Never infer approval from a package manifest, a source path or
 * a media row. An unapproved draft stays entirely outside public routes.
 *
 * The database identity, imported source snapshot and private inode/hash
 * are checked on every read. No storage path/key is returned to the caller.
 */
export async function readVerifiedAdminPreparedText(
  db:Database,bearer:string,rawInput:unknown,privateRoot:string,
){
  const input=inputSchema.parse(rawInput);
  if(typeof privateRoot!=='string'||!privateRoot.startsWith('/')){
    throw new Error('Private Folio storage is not configured');
  }
  return withVerifiedAdminPermission(db,bearer,'catalog:read',async tx=>{
    const [row]=await tx.select({
      id:schema.contentRevisions.id,
      rawSha256:schema.contentRevisions.rawSha256,
      rawArtifactKey:schema.contentRevisions.rawArtifactKey,
      revisionStatus:schema.contentRevisions.status,
      workStatus:schema.works.publicationStatus,
      editionStatus:schema.editions.status,
      sourceSnapshot:schema.sourceProvenance.sourceSnapshot,
    }).from(schema.contentRevisions)
      .innerJoin(schema.editions,and(
        eq(schema.editions.id,schema.contentRevisions.editionId),
        eq(schema.editions.id,input.editionId),
        eq(schema.editions.workId,input.workId),
      ))
      .innerJoin(schema.works,eq(schema.works.id,schema.editions.workId))
      .innerJoin(schema.sourceProvenance,
        eq(schema.sourceProvenance.id,schema.contentRevisions.provenanceId))
      .where(eq(schema.contentRevisions.id,input.revisionId)).limit(1);
    if(!row||row.workStatus!=='draft'||row.editionStatus!=='draft'||
       row.revisionStatus!=='draft')return null;
    const claimed=sourceRef.safeParse(row.sourceSnapshot);
    if(!claimed.success||claimed.data.sourceSha256!==row.rawSha256)return null;
    const [asset]=await tx.select().from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.id,claimed.data.mediaAssetId),
      eq(schema.mediaAssets.ownerScope,'catalog'),
      isNull(schema.mediaAssets.ownerUserId),
      eq(schema.mediaAssets.status,'pending_verify'),
      eq(schema.mediaAssets.mime,'text/plain'),
    )).limit(1);
    if(!asset||asset.sha256!==row.rawSha256||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.storageKey)||
       row.rawArtifactKey!==`quarantine/catalog/${asset.storageKey}.blob`){
      return null;
    }
    const sourceText=await (await LocalStorageAdapter.create(privateRoot))
      .readAdminCatalogQuarantinedText({
        scope:'catalog',ownerUserId:null,status:'pending_verify',
        key:asset.storageKey,sha256:asset.sha256,sizeBytes:asset.sizeBytes,
        mime:'text/plain',
      });
    return {revisionId:row.id,sha256:asset.sha256,
      sizeBytes:asset.sizeBytes,sourceText};
  },{isolationLevel:'repeatable read'});
}
