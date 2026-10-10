import {createHash} from 'node:crypto';
import {and,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const uuid=z.uuid();
const language=z.enum(['tr','en']);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const authorSchema=z.object({id:uuid,canonical_name:z.string().trim().min(1)}).passthrough();
const workSchema=z.object({id:uuid,original_title:z.string().min(1),original_language:language,authors:z.array(uuid).min(1)}).passthrough();
const editionSchema=z.object({id:uuid,work_id:uuid,language,label:z.string().min(1).optional(),publisher:z.string().optional()}).passthrough();
const revisionSchema=z.object({id:uuid,edition_id:uuid,language,source_sha256:sha}).passthrough();
const rightsSchema=z.object({work_id:uuid,evidence:z.string().trim().min(12),edition_id:uuid.optional(),revision_id:uuid.optional()}).passthrough();
export const preparedImportSchema=z.object({
  packageId:uuid,
  manifestChecksum:sha,
  schemaVersion:z.literal('1.0.0'),
  records:z.object({authors:z.array(authorSchema).max(10000),works:z.array(workSchema).max(10000),
    editions:z.array(editionSchema).max(20000),revisions:z.array(revisionSchema).max(20000),
    rightsRecords:z.array(rightsSchema).max(20000)}).strict(),
}).strict().superRefine((data,ctx)=>{
  const {authors,works,editions,revisions,rightsRecords}=data.records;
  const idSet=(rows:readonly {id:string}[])=>new Set(rows.map(r=>r.id));
  for(const [kind,rows] of [['author',authors],['work',works],['edition',editions],['revision',revisions]] as const){
    if(idSet(rows).size!==rows.length)ctx.addIssue({code:'custom',message:`Repeated ${kind} identity`});
  }
  const ai=idSet(authors),wi=idSet(works),ei=idSet(editions),ri=idSet(revisions);
  const editionById=new Map(editions.map(e=>[e.id,e]));
  const revisionById=new Map(revisions.map(r=>[r.id,r]));
  for(const w of works){
    if(w.authors.some(id=>!ai.has(id))||new Set(w.authors).size!==w.authors.length){
      ctx.addIssue({code:'custom',message:'Work refers to missing or duplicate package author'});
    }
  }
  for(const e of editions)if(!wi.has(e.work_id))ctx.addIssue({code:'custom',message:'Edition must reference work within package'});
  for(const r of revisions){
    const edition=editionById.get(r.edition_id);
    if(!edition)ctx.addIssue({code:'custom',message:'Revision must reference edition within package'});
    else if(edition.language!==r.language)ctx.addIssue({code:'custom',message:'Revision language differs from its edition'});
  }
  for(const r of rightsRecords){
    const revision=r.revision_id?revisionById.get(r.revision_id):undefined;
    const editionId=r.edition_id??revision?.edition_id;
    const edition=editionId?editionById.get(editionId):undefined;
    if(!wi.has(r.work_id)||(r.edition_id&&!ei.has(r.edition_id))||(r.revision_id&&!ri.has(r.revision_id))){
      ctx.addIssue({code:'custom',message:'Rights evidence references missing in-package scope'});
    }
    if(edition&&edition.work_id!==r.work_id){
      ctx.addIssue({code:'custom',message:'Rights evidence mixes two canonical works'});
    }
    if(revision&&r.edition_id&&revision.edition_id!==r.edition_id){
      ctx.addIssue({code:'custom',message:'Rights evidence revision/edition mismatch'});
    }
    if(r.review_status==='approved'||r.publication_status==='published'){
      ctx.addIssue({code:'custom',message:'Import package cannot self-approve rights or publication'});
    }
  }
});
export type PreparedImport=z.infer<typeof preparedImportSchema>;
export type ImportKind='author'|'work'|'edition'|'revision'|'rights';
export type ImportAction='create'|'noop'|'conflict'|'deferred';
export type ImportPlanItem={kind:ImportKind;externalId:string;action:ImportAction;reason:string};

/** Hash canonical JSON without depending on JSONB key order across process restarts. */
export function canonicalJson(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value!==null&&typeof value==='object'){
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).filter(key=>object[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value)??'null';
}
export const payloadHash=(value:unknown):string=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export const preparedImportItemCount=(item:PreparedImport):number=>Object.values(item.records).reduce((n,rows)=>n+rows.length,0);
const authorTitle='Imported prepared edition';
const importedEditionLabel=(e:z.infer<typeof editionSchema>):string=>e.label??authorTitle;

type RowMap<T extends{id:string}>=Map<string,T>;
const mapRows=<T extends{id:string}>(rows:T[]):RowMap<T>=>new Map(rows.map(row=>[row.id,row]));

/** Purely READ ONLY: no audit, batch, asset, author, revision, or catalog changes. */
export async function previewPreparedCatalogImport(db:Database,raw:unknown){
  const input=preparedImportSchema.parse(raw);
  return db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const [older]=await tx.select().from(schema.importBatches).where(eq(schema.importBatches.packageId,input.packageId)).limit(1);
    if(older&&older.manifestChecksum!==input.manifestChecksum)throw new Error('Package UUID reused with different checksum');
    const {authors,works,editions,revisions,rightsRecords}=input.records;
    const lookup=async <T extends{id:string}>(table:typeof schema.authors|typeof schema.works|typeof schema.editions|typeof schema.contentRevisions,ids:string[]):Promise<RowMap<T>>=>{
      if(!ids.length)return new Map();
      const rows=[] as T[];
      for(let i=0;i<ids.length;i+=200){
        const batch=ids.slice(i,i+200);
        // Each table's identity is a UUID. Do not issue unbounded SQL IN lists.
        const fetched=table===schema.authors
          ?await tx.select().from(schema.authors).where(inArray(schema.authors.id,batch))
          :table===schema.works
            ?await tx.select().from(schema.works).where(inArray(schema.works.id,batch))
            :table===schema.editions
              ?await tx.select().from(schema.editions).where(inArray(schema.editions.id,batch))
              :await tx.select().from(schema.contentRevisions).where(inArray(schema.contentRevisions.id,batch));
        rows.push(...fetched as T[]);
      }
      return mapRows(rows);
    };
    const existingAuthors=await lookup<typeof schema.authors.$inferSelect>(schema.authors,authors.map(x=>x.id));
    const existingWorks=await lookup<typeof schema.works.$inferSelect>(schema.works,works.map(x=>x.id));
    const existingEditions=await lookup<typeof schema.editions.$inferSelect>(schema.editions,editions.map(x=>x.id));
    const existingRevisions=await lookup<typeof schema.contentRevisions.$inferSelect>(schema.contentRevisions,revisions.map(x=>x.id));
    const allAuthorRows=await tx.select({id:schema.authors.id,name:schema.authors.canonicalName}).from(schema.authors);
    const authorsByName=new Map(allAuthorRows.map(a=>[a.name,a.id]));
    const titles=[...new Set(works.map(w=>w.original_title))];
    const sameTitles=[] as {id:string;title:string;language:string}[];
    for(let i=0;i<titles.length;i+=200){
      const rows=await tx.select({id:schema.works.id,title:schema.works.originalTitle,language:schema.works.originalLanguage})
        .from(schema.works).where(inArray(schema.works.originalTitle,titles.slice(i,i+200)));
      sameTitles.push(...rows);
    }
    const existingWorkLinks=existingWorks.size?await tx.select().from(schema.workAuthors)
      .where(inArray(schema.workAuthors.workId,[...existingWorks.keys()])):[];
    const items=[] as ImportPlanItem[];
    for(const a of authors){
      const existing=existingAuthors.get(a.id);
      const nameMatch=authorsByName.get(a.canonical_name);
      items.push({kind:'author',externalId:a.id,
        action:existing?(existing.canonicalName===a.canonical_name?'noop':'conflict'):(nameMatch&&nameMatch!==a.id?'conflict':'create'),
        reason:existing?(existing.canonicalName===a.canonical_name?'same_uuid_same_name':'same_uuid_changed_name'):(nameMatch&&nameMatch!==a.id?'possible_author_match_requires_review':'new_uuid'),
      });
    }
    for(const w of works){
      const existing=existingWorks.get(w.id);
      const sameName=sameTitles.some(row=>row.id!==w.id&&row.title===w.original_title&&row.language===w.original_language);
      const existingAuthorsForWork=existingWorkLinks.filter(link=>link.workId===w.id).map(link=>link.authorId).sort();
      const same=!!existing&&existing.originalTitle===w.original_title&&existing.originalLanguage===w.original_language&&
        canonicalJson(existingAuthorsForWork)===canonicalJson([...w.authors].sort());
      items.push({kind:'work',externalId:w.id,action:existing?(same?'noop':'conflict'):(sameName?'conflict':'create'),
        reason:existing?(same?'same_uuid_same_authors':'same_uuid_changed_canonical_work'):(sameName?'possible_title_match_requires_review':'new_uuid')});
    }
    for(const e of editions){
      const existing=existingEditions.get(e.id);
      const same=!!existing&&existing.workId===e.work_id&&existing.language===e.language&&existing.label===importedEditionLabel(e);
      items.push({kind:'edition',externalId:e.id,action:existing?(same?'noop':'conflict'):'create',
        reason:existing?(same?'same_uuid_same_edition':'same_uuid_changed_edition'):'new_uuid'});
    }
    for(const r of revisions){
      const existing=existingRevisions.get(r.id);
      const same=!!existing&&existing.editionId===r.edition_id&&existing.language===r.language&&existing.rawSha256===r.source_sha256;
      items.push({kind:'revision',externalId:r.id,action:existing?(same?'noop':'conflict'):'deferred',
        reason:existing?(same?'immutable_revision_already_exists':'immutable_revision_collision'):'requires_verified_private_artifact_storage'});
    }
    for(const [i,r] of rightsRecords.entries())items.push({kind:'rights',externalId:`${r.work_id}:${i}`,action:'deferred',reason:'manual_country_and_action_rights_review_required'});
    const totals={create:0,noop:0,conflict:0,deferred:0};
    for(const item of items)totals[item.action]++;
    return {packageId:input.packageId,manifestChecksum:input.manifestChecksum,existingBatchId:older?.id??null,
      batchStatus:older?.status??null,canStage:totals.conflict===0,totals,items};
  });
}

function stagedPayloads(input:PreparedImport){
  const rows=[] as {kind:ImportKind;externalId:string;payload:unknown;payloadSha256:string;status:string}[];
  for(const [kind,records] of [['author',input.records.authors],['work',input.records.works],
    ['edition',input.records.editions],['revision',input.records.revisions]] as const){
    for(const record of records){rows.push({kind,externalId:record.id,payload:record,payloadSha256:payloadHash(record),
      status:kind==='revision'?'deferred_asset':'staged'});}
  }
  for(const [index,record] of input.records.rightsRecords.entries()){
    rows.push({kind:'rights',externalId:`${record.work_id}:${index}`,payload:record,
      payloadSha256:payloadHash(record),status:'deferred_review'});
  }
  return rows;
}

/** Stage only a validated internal snapshot. Never turns metadata into public content. */
export async function stagePreparedCatalogImport(db:Database,actorId:string,raw:unknown){
  const actor=uuid.parse(actorId),input=preparedImportSchema.parse(raw);
  const preview=await previewPreparedCatalogImport(db,input);
  if(!preview.canStage)throw new Error('Conflicting package must be reviewed before staging');
  const snapshots=stagedPayloads(input);
  return db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.packageId}))`);
    const [existing]=await tx.select().from(schema.importBatches).where(eq(schema.importBatches.packageId,input.packageId)).limit(1);
    if(existing){
      if(existing.manifestChecksum!==input.manifestChecksum||existing.expectedItems!==snapshots.length)throw new Error('Package identity reused with altered snapshot');
      const staged=await tx.select().from(schema.importItems).where(eq(schema.importItems.batchId,existing.id));
      if(staged.length!==snapshots.length||staged.some(row=>{
        const match=snapshots.find(item=>item.kind===row.kind&&item.externalId===row.externalId);
        return !match||match.payloadSha256!==row.payloadSha256;
      }))throw new Error('Stored import snapshot does not match validated package');
      return {batchId:existing.id,status:existing.status,alreadyStaged:true,itemCount:existing.expectedItems};
    }
    const [batch]=await tx.insert(schema.importBatches).values({packageId:input.packageId,
      manifestChecksum:input.manifestChecksum,schemaVersion:input.schemaVersion,
      actorId:actor,isDryRun:false,status:'staged',expectedItems:snapshots.length}).returning();
    if(!batch)throw new Error('Cannot create import stage');
    for(let i=0;i<snapshots.length;i+=200){
      await tx.insert(schema.importItems).values(snapshots.slice(i,i+200).map(record=>({...record,batchId:batch.id})));
    }
    await tx.insert(schema.auditEvents).values({actorId:actor,action:'import.stage',entityType:'import_batch',entityId:batch.id,
      afterJson:{packageId:input.packageId,manifestChecksum:input.manifestChecksum,items:snapshots.length,status:'staged'}});
    return {batchId:batch.id,status:'staged',alreadyStaged:false,itemCount:snapshots.length};
  });
}

/** Staged DB-only metadata apply, one small transaction per author/work/edition. */
export async function resumeStagedCatalogMetadata(db:Database,actorId:string,batchId:string,maxItems=Number.MAX_SAFE_INTEGER){
  const actor=uuid.parse(actorId),id=uuid.parse(batchId);
  if(!Number.isSafeInteger(maxItems)||maxItems<1)throw new Error('Invalid checkpoint limit');
  const [batch]=await db.select().from(schema.importBatches).where(eq(schema.importBatches.id,id)).limit(1);
  if(!batch)throw new Error('Unknown import stage');
  const items=await db.select().from(schema.importItems).where(eq(schema.importItems.batchId,id));
  if(items.length!==batch.expectedItems)throw new Error('Import stage is incomplete');
  const order:Record<string,number>={author:0,work:1,edition:2,revision:3,rights:4};
  const sorted=items.filter(item=>item.status==='staged').sort((a,b)=>(order[a.kind]??99)-(order[b.kind]??99)||a.externalId.localeCompare(b.externalId));
  let applied=0;
  for(const item of sorted){
    if(applied>=maxItems)break;
    const didApply=await db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
      const [current]=await tx.select().from(schema.importItems).where(eq(schema.importItems.id,item.id)).limit(1);
      if(!current||current.status!=='staged')return false;
      if(payloadHash(current.payload)!==current.payloadSha256)throw new Error('Staged payload was altered');
      let outcome:'applied'|'noop'='applied';
      if(current.kind==='author'){
        const incoming=authorSchema.parse(current.payload);
        const [existing]=await tx.select().from(schema.authors).where(eq(schema.authors.id,incoming.id)).limit(1);
        if(existing){
          if(existing.canonicalName!==incoming.canonical_name)throw new Error('Author UUID collision during apply');
          outcome='noop';
        }else {
          const [similar]=await tx.select().from(schema.authors).where(eq(schema.authors.canonicalName,incoming.canonical_name)).limit(1);
          if(similar)throw new Error('Author name requires manual matching');
          await tx.insert(schema.authors).values({id:incoming.id,canonicalName:incoming.canonical_name,sortName:incoming.canonical_name});
        }
      }else if(current.kind==='work'){
        const incoming=workSchema.parse(current.payload);
        const [existing]=await tx.select().from(schema.works).where(eq(schema.works.id,incoming.id)).limit(1);
        if(existing){
          const links=await tx.select().from(schema.workAuthors).where(eq(schema.workAuthors.workId,incoming.id));
          if(existing.originalTitle!==incoming.original_title||existing.originalLanguage!==incoming.original_language||
            canonicalJson(links.map(link=>link.authorId).sort())!==canonicalJson([...incoming.authors].sort())){
            throw new Error('Immutable work identity collision during apply');
          }
          outcome='noop';
        }else{
          const referenced=await tx.select().from(schema.authors).where(inArray(schema.authors.id,incoming.authors));
          if(referenced.length!==incoming.authors.length)throw new Error('Staged work authors not yet available');
          const [possibleMatch]=await tx.select().from(schema.works).where(and(
            eq(schema.works.originalTitle,incoming.original_title),eq(schema.works.originalLanguage,incoming.original_language))).limit(1);
          if(possibleMatch)throw new Error('Possible existing work requires human matching');
          await tx.insert(schema.works).values({id:incoming.id,originalTitle:incoming.original_title,originalLanguage:incoming.original_language,publicationStatus:'draft'});
          await tx.insert(schema.workAuthors).values(incoming.authors.map((authorId,index)=>({workId:incoming.id,authorId,sortOrder:index,contribution:'author'})));
          await tx.insert(schema.workTitles).values({workId:incoming.id,language:incoming.original_language,title:incoming.original_title,kind:'original'});
        }
      }else if(current.kind==='edition'){
        const incoming=editionSchema.parse(current.payload),label=importedEditionLabel(incoming);
        const [existing]=await tx.select().from(schema.editions).where(eq(schema.editions.id,incoming.id)).limit(1);
        if(existing){
          if(existing.workId!==incoming.work_id||existing.language!==incoming.language||existing.label!==label)throw new Error('Immutable edition identity collision during apply');
          outcome='noop';
        }else{
          const [work]=await tx.select().from(schema.works).where(eq(schema.works.id,incoming.work_id)).limit(1);
          if(!work)throw new Error('Staged edition work not yet available');
          await tx.insert(schema.editions).values({id:incoming.id,workId:incoming.work_id,language:incoming.language,label,publisher:incoming.publisher??null,status:'draft'});
        }
      }else throw new Error('Only draft catalog metadata may be applied');
      await tx.update(schema.importItems).set({status:outcome,appliedAt:new Date()}).where(eq(schema.importItems.id,current.id));
      await tx.insert(schema.auditEvents).values({actorId:actor,action:outcome==='noop'?'import.item.noop':'import.item.applied',
        entityType:current.kind,entityId:uuid.parse(current.externalId),
        afterJson:{batchId:id,kind:current.kind,checksum:current.payloadSha256,public:false}});
      return true;
    });
    if(didApply)applied++;
  }
  // Same batch lock as per-item commits: concurrent workers cannot regress the
  // final status from metadata_applied back to paused using stale snapshots.
  const final=await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
    const stateRows=await tx.select({status:schema.importItems.status})
      .from(schema.importItems).where(eq(schema.importItems.batchId,id));
    if(stateRows.length!==batch.expectedItems)throw new Error('Import stage became incomplete');
    const pending=stateRows.filter(item=>item.status==='staged').length;
    const newStatus=pending?'paused':'metadata_applied';
    await tx.update(schema.importBatches).set({status:newStatus,updatedAt:new Date()})
      .where(eq(schema.importBatches.id,id));
    return {newStatus,pending};
  });
  return {batchId:id,status:final.newStatus,processedThisRun:applied,pending:final.pending,
    deferredContent:items.filter(item=>item.status==='deferred_asset').length,
    deferredRights:items.filter(item=>item.status==='deferred_review').length};
}

export async function getStagedCatalogImportStatus(db:Database,batchId:string){
  const id=uuid.parse(batchId);
  const [batch]=await db.select().from(schema.importBatches).where(eq(schema.importBatches.id,id)).limit(1);
  if(!batch)return null;
  const rows=await db.select({kind:schema.importItems.kind,status:schema.importItems.status}).from(schema.importItems)
    .where(eq(schema.importItems.batchId,id));
  if(rows.length!==batch.expectedItems)throw new Error('Incomplete staged package');
  const counts:Record<string,number>={};
  for(const row of rows){const key=`${row.kind}:${row.status}`;counts[key]=(counts[key]??0)+1;}
  return {batchId:id,packageId:batch.packageId,manifestChecksum:batch.manifestChecksum,status:batch.status,
    expectedItems:batch.expectedItems,counts};
}
