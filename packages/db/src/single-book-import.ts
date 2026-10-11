import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import {LocalStorageAdapter} from './local-storage.js';
import {payloadHash} from './import-staging.js';
import * as schema from './schema.js';

type Database=ReturnType<typeof createFolioDb>['db'];
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
const MAX_TEXT_BYTES=1024*1024;
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const book=z.object({
  title:z.string().trim().min(1).max(400),
  language:z.enum(['tr','en']),
  authors:z.array(z.string().trim().min(1).max(240)).min(1).max(10),
  editionLabel:z.string().trim().min(1).max(400),
}).strict();
const prepared=z.object({
  packageId:z.uuid(),
  manifestSha256:sha,
  schemaVersion:z.literal('1.0.0'),
  book,
  source:z.object({
    path:z.string().min(1).max(200),
    sha256:sha,
    sizeBytes:z.number().int().positive().max(MAX_TEXT_BYTES),
    sourceText:z.string().min(1),
  }).strict(),
}).strict();
export type VerifiedSingleBook=z.infer<typeof prepared>;

function parseVerified(raw:unknown):VerifiedSingleBook {
  const input=prepared.parse(raw);
  const bytes=Buffer.from(input.source.sourceText,'utf8');
  if(bytes.length!==input.source.sizeBytes||bytes.length>MAX_TEXT_BYTES||
    input.source.sourceText.includes('\0')||
    createHash('sha256').update(bytes).digest('hex')!==input.source.sha256){
    throw new Error('Prepared text bytes/size/SHA-256 mismatch');
  }
  if(new Set(input.book.authors.map(name=>name.toLocaleLowerCase('en'))).size!==input.book.authors.length){
    throw new Error('Ambiguous repeated package authors');
  }
  return input;
}
type Check={action:'create'|'noop'|'conflict';reason:string;batchId?:string;workId?:string;
  editionId?:string;revisionId?:string;assetId?:string};

async function checkPackage(tx:Tx,input:VerifiedSingleBook):Promise<Check>{
  const [batch]=await tx.select().from(schema.importBatches)
    .where(eq(schema.importBatches.packageId,input.packageId)).limit(1);
  if(batch){
    if(batch.manifestChecksum!==input.manifestSha256||batch.status!=='applied'||
      batch.isDryRun||batch.expectedItems!==1){
      return {action:'conflict',reason:'package_identity_or_status_conflict'};
    }
    const items=await tx.select().from(schema.importItems)
      .where(eq(schema.importItems.batchId,batch.id)).limit(2);
    const row=items[0];
    const identity=z.object({workId:z.uuid(),editionId:z.uuid(),revisionId:z.uuid(),
      assetId:z.uuid(),sourceSha256:sha}).strict().safeParse(row?.payload);
    if(items.length!==1||!row||row.kind!=='book'||row.status!=='applied'||!identity.success||
      row.payloadSha256!==payloadHash(row.payload)||
      identity.data.sourceSha256!==input.source.sha256){
      return {action:'conflict',reason:'stored_import_integrity_conflict'};
    }
    const id=identity.data;
    const [work]=await tx.select().from(schema.works).where(eq(schema.works.id,id.workId)).limit(1);
    const [edition]=await tx.select().from(schema.editions).where(eq(schema.editions.id,id.editionId)).limit(1);
    const [revision]=await tx.select().from(schema.contentRevisions)
      .where(eq(schema.contentRevisions.id,id.revisionId)).limit(1);
    const [asset]=await tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id,id.assetId)).limit(1);
    const [block]=await tx.select().from(schema.contentBlocks)
      .where(eq(schema.contentBlocks.revisionId,id.revisionId)).limit(1);
    if(!work||!edition||!revision||!asset||!block||
      work.originalTitle!==input.book.title||work.originalLanguage!==input.book.language||
      edition.workId!==work.id||edition.language!==input.book.language||
      revision.editionId!==edition.id||revision.rawSha256!==input.source.sha256||
      block.textSha256!==input.source.sha256||block.sourceText!==input.source.sourceText||
      asset.ownerScope!=='catalog'||asset.ownerUserId!==null||asset.sha256!==input.source.sha256||
      asset.status==='rejected'||asset.status==='deleted'){
      return {action:'conflict',reason:'stored_import_rows_changed'};
    }
    return {action:'noop',reason:'identical_verified_package_already_applied',
      batchId:batch.id,workId:work.id,editionId:edition.id,revisionId:revision.id,assetId:asset.id};
  }
  for(const name of input.book.authors){
    const [other]=await tx.select({id:schema.authors.id}).from(schema.authors)
      .where(eq(schema.authors.canonicalName,name)).limit(1);
    if(other)return {action:'conflict',reason:'author_identity_requires_review'};
  }
  const [sameTitle]=await tx.select({id:schema.works.id}).from(schema.works)
    .where(and(eq(schema.works.originalTitle,input.book.title),
      eq(schema.works.originalLanguage,input.book.language))).limit(1);
  if(sameTitle)return {action:'conflict',reason:'work_title_requires_review'};
  const [sameSource]=await tx.select({id:schema.contentRevisions.id})
    .from(schema.contentRevisions).where(eq(schema.contentRevisions.rawSha256,input.source.sha256)).limit(1);
  if(sameSource)return {action:'conflict',reason:'source_sha256_requires_review'};
  return {action:'create',reason:'new_draft_no_rights_granted'};
}

/** Transaction is READ ONLY, including imports and audit. The CLI requires a
 * local Folio DB connection; no user-facing preview route is exposed. */
export async function previewVerifiedSingleBookImport(db:Database,raw:unknown){
  const input=parseVerified(raw);
  return db.transaction(async tx=>{
    await tx.execute(sql.raw('SET TRANSACTION READ ONLY'));
    const check=await checkPackage(tx,input);
    return {...check,packageId:input.packageId,manifestSha256:input.manifestSha256,
      readOnly:true,publication:'draft',rights:'unreviewed'};
  },{isolationLevel:'repeatable read'});
}

/** One atomic, MFA-gated import. Catalog-owned text is held in quarantine:
 * never served publicly until separate verification, rights and publication. */
export async function applyVerifiedSingleBookImport(
  db:Database,bearer:string,raw:unknown,storageRoot:string,
){
  const input=parseVerified(raw);
  if(typeof storageRoot!=='string'||!storageRoot.startsWith('/')){
    throw new Error('Explicit absolute private storage root required');
  }
  return withVerifiedAdminPermission(db,bearer,'import:apply',async(tx,who)=>{
    await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(hashtext('folioctl-single-book-apply'))"));
    const check=await checkPackage(tx,input);
    if(check.action==='noop')return {...check,packageId:input.packageId,alreadyApplied:true};
    if(check.action==='conflict')throw new Error('Import requires manual review: '+check.reason);

    const storage=await LocalStorageAdapter.create(storageRoot);
    const bytes=Buffer.from(input.source.sourceText,'utf8');
    const quarantined=await storage.stage({
      owner:{scope:'catalog',ownerUserId:null},
      source:(async function*(){yield bytes;})(),
      declaredSha256:input.source.sha256,declaredMime:'text/plain',
      maxBytes:MAX_TEXT_BYTES,
    });
    const inspected=await storage.inspectQuarantined(quarantined);
    if(inspected.sha256!==input.source.sha256||inspected.sizeBytes!==bytes.length){
      throw new Error('Staged private source integrity mismatch');
    }
    const [asset]=await tx.insert(schema.mediaAssets).values({
      ownerScope:'catalog',ownerUserId:null,storageKey:quarantined.key,
      sha256:input.source.sha256,sizeBytes:input.source.sizeBytes,
      mime:'text/plain',status:'pending_verify',
    }).returning();
    if(!asset)throw new Error('Private source asset metadata failed');

    const authors=await tx.insert(schema.authors).values(input.book.authors.map(name=>({
      canonicalName:name,sortName:name,
    }))).returning();
    const [work]=await tx.insert(schema.works).values({
      originalTitle:input.book.title,originalLanguage:input.book.language,publicationStatus:'draft',
    }).returning();
    if(!work)throw new Error('Draft work creation failed');
    await tx.insert(schema.workAuthors).values(authors.map((author,index)=>({
      workId:work.id,authorId:author.id,sortOrder:index,contribution:'author',
    })));
    await tx.insert(schema.workTitles).values({
      workId:work.id,title:input.book.title,language:input.book.language,kind:'original',
    });
    const [edition]=await tx.insert(schema.editions).values({
      workId:work.id,language:input.book.language,label:input.book.editionLabel,status:'draft',
    }).returning();
    if(!edition)throw new Error('Draft edition creation failed');

    const [provenance]=await tx.insert(schema.sourceProvenance).values({
      sourceName:'folioctl prepared text package',licenseClaim:null,
      sourceSnapshot:{packageId:input.packageId,manifestSha256:input.manifestSha256,
        sourcePath:input.source.path,sourceSha256:input.source.sha256,
        mediaAssetId:asset.id,rights:'unreviewed'},
    }).returning();
    if(!provenance)throw new Error('Source provenance creation failed');

    const chapterId=randomUUID(),blockId=randomUUID();
    const normalizedSha256=createHash('sha256').update(JSON.stringify([{
      chapterId,ordinal:0,heading:'Full text',
      blocks:[{id:blockId,ordinal:0,kind:'paragraph',textSha256:input.source.sha256}],
    }])).digest('hex');
    const [revision]=await tx.insert(schema.contentRevisions).values({
      editionId:edition.id,language:input.book.language,
      rawArtifactKey:'quarantine/catalog/'+asset.storageKey+'.blob',
      rawSha256:input.source.sha256,normalizedSha256,
      parserVersion:'folioctl-plain-text-v1',provenanceId:provenance.id,
      status:'draft',createdBy:who.userId,
    }).returning();
    if(!revision)throw new Error('Draft content revision creation failed');
    await tx.insert(schema.contentChapters).values({
      revisionId:revision.id,chapterId,ordinal:0,heading:'Full text',
    });
    await tx.insert(schema.contentBlocks).values({
      revisionId:revision.id,chapterId,blockId,ordinal:0,
      kind:'paragraph',sourceLocator:{kind:'plain-text',sourcePath:input.source.path},
      sourceText:input.source.sourceText,textSha256:input.source.sha256,
      includeNormal:true,includeRsvp:true,includeAudio:false,
    });
    const [batch]=await tx.insert(schema.importBatches).values({
      packageId:input.packageId,manifestChecksum:input.manifestSha256,
      schemaVersion:input.schemaVersion,actorId:who.userId,status:'applied',
      expectedItems:1,isDryRun:false,
    }).returning();
    if(!batch)throw new Error('Import batch creation failed');
    const payload={workId:work.id,editionId:edition.id,
      revisionId:revision.id,assetId:asset.id,sourceSha256:input.source.sha256};
    await tx.insert(schema.importItems).values({
      batchId:batch.id,kind:'book',externalId:work.id,payload,
      payloadSha256:payloadHash(payload),status:'applied',appliedAt:new Date(),
    });
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,action:'import.single_book.applied',
      entityType:'import_batch',entityId:batch.id,
      afterJson:{workId:work.id,editionId:edition.id,revisionId:revision.id,
        mediaAssetId:asset.id,manifestSha256:input.manifestSha256,
        publication:'draft',rights:'unreviewed'},
    });
    return {action:'create' as const,packageId:input.packageId,batchId:batch.id,
      workId:work.id,editionId:edition.id,revisionId:revision.id,
      assetId:asset.id,alreadyApplied:false,publication:'draft' as const,rights:'unreviewed' as const};
  });
}
