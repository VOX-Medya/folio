import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {z} from 'zod';

const uuid=z.uuid();
const sha=z.string().regex(/^[0-9a-f]{64}$/);
const language=z.enum(['tr','en']);
const sourceKinds=z.enum(['paragraph','heading','footnote','page_number','running_header','publisher_note','preface','endnote','poetry','quote','list','image_ref']);
const auxiliary=new Set(['footnote','endnote','page_number','running_header','publisher_note','image_ref']);
const author=z.object({id:uuid,canonical_name:z.string().trim().min(1)}).passthrough();
const work=z.object({id:uuid,original_title:z.string().min(1),original_language:language,authors:z.array(uuid).min(1)}).passthrough();
const edition=z.object({id:uuid,work_id:uuid,language}).passthrough();
const revision=z.object({id:uuid,edition_id:uuid,language,source_sha256:sha,status:z.enum(['candidate','imported_draft','draft','needs_rights_review','needs_content_review'])}).passthrough();
const rights=z.object({work_id:uuid,evidence:z.string().trim().min(12),review_status:z.enum(['pending','rejected']).optional(),edition_id:uuid.optional(),revision_id:uuid.optional(),territories:z.array(z.string().regex(/^[A-Z]{2}$/)).optional()}).passthrough();
const block=z.object({revision_id:uuid,chapter_id:uuid,chapter_ordinal:z.number().int().min(0),block_id:uuid,ordinal:z.number().int().min(0),kind:sourceKinds,source_text:z.string().min(1),text_sha256:sha,locator:z.object({format:z.enum(['text','epub','pdf']),path:z.string().min(1)}),include_rsvp:z.boolean().optional(),include_audio:z.boolean().optional(),parent_block_id:uuid.optional()}).passthrough();
const align=z.object({source_revision_id:uuid,target_revision_id:uuid,source_block_id:uuid,target_block_id:uuid,verified:z.literal(false).optional()}).passthrough();
const MAX_JSONL_LINE=2*1024*1024;
const MAX_JSONL_ROWS=500000;
const decoder=new TextDecoder('utf-8',{fatal:true});

export function indexedFileKind(path){
  if(/^metadata\/(authors|works|editions|revisions|rights)\.ndjson$/.test(path))return 'metadata';
  if(/^texts\/[0-9a-f-]{36}\/blocks\.jsonl$/.test(path))return 'text';
  if(/^alignments\/[0-9a-f-]{36}-[0-9a-f-]{36}\.jsonl$/.test(path))return 'alignment';
  if(/^audio\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(m4a|opus)$/.test(path))return 'audio';
  if(/^assets\/[0-9a-f]{64}\.[a-z0-9]{1,12}$/.test(path))return 'asset';
  return null;
}

export function createJsonlScanner(path,rowBudget){
  const kind=indexedFileKind(path);
  if(!['text','alignment'].includes(kind))throw new Error(`Not a JSONL text/alignment path: ${path}`);
  const revisionId=kind==='text'?path.slice('texts/'.length,-'/blocks.jsonl'.length):null;
  let pending=Buffer.alloc(0),rows=0;
  const chapters=new Map(),blockIds=new Set(),parents=[];
  const edges=[],edgeKeys=new Set();
  const processLine=(buf)=>{
    if(!buf.length)return;
    if(buf.length>MAX_JSONL_LINE)throw new Error(`Oversized JSONL record in ${path}`);
    rows++;if(rows>MAX_JSONL_ROWS)throw new Error(`Too many JSONL records in ${path}`);
    if(rowBudget){rowBudget.rows++;if(rowBudget.rows>1000000)throw new Error('Package exceeds total JSONL record limit');}
    const record=JSON.parse(decoder.decode(buf));
    if(kind==='alignment'){
      const row=align.parse(record);
      if(row.source_revision_id===row.target_revision_id)throw new Error('Self translation alignment forbidden');
      const key=`${row.source_revision_id}:${row.target_revision_id}:${row.source_block_id}:${row.target_block_id}`;
      if(edgeKeys.has(key))throw new Error('Duplicate source-target alignment');
      edgeKeys.add(key);edges.push({...row,key});return;
    }
    const row=block.parse(record);
    if(row.revision_id!==revisionId)throw new Error(`Text revision scope mismatch: ${path}`);
    if(createHash('sha256').update(row.source_text,'utf8').digest('hex')!==row.text_sha256)throw new Error(`Source text checksum mismatch in ${path}`);
    if(auxiliary.has(row.kind)&&(row.include_rsvp||row.include_audio))throw new Error(`Auxiliary text cannot enter RSVP or audio: ${row.kind}`);
    if(blockIds.has(row.block_id))throw new Error('Duplicate stable block identifier');
    blockIds.add(row.block_id);
    const ch=chapters.get(row.chapter_id)??{ordinal:row.chapter_ordinal,blocks:new Set()};
    if(ch.ordinal!==row.chapter_ordinal||ch.blocks.has(row.ordinal))throw new Error('Duplicate or ambiguous chapter/block order');
    ch.blocks.add(row.ordinal);chapters.set(row.chapter_id,ch);
    if(row.parent_block_id)parents.push(row.parent_block_id);
  };
  return {
    push(chunk){
      const data=Buffer.concat([pending,chunk]);
      let cursor=0;
      while(true){
        const end=data.indexOf(10,cursor);
        if(end<0)break;
        processLine(data.subarray(cursor,end));cursor=end+1;
      }
      pending=Buffer.from(data.subarray(cursor));
      if(pending.length>MAX_JSONL_LINE)throw new Error(`Oversized JSONL record in ${path}`);
    },
    finish(){
      if(pending.length)processLine(pending);
      if(!rows)throw new Error(`Empty JSONL content: ${path}`);
      if(kind==='alignment')return {kind,edges};
      for(const parent of parents)if(!blockIds.has(parent))throw new Error('Parent block not found in revision');
      const chapterOrders=[...chapters.values()].map(c=>c.ordinal).sort((a,b)=>a-b);
      if(chapterOrders.some((n,i)=>n!==i))throw new Error('Unreliable chapter order');
      for(const chapter of chapters.values()){
        const orders=[...chapter.blocks].sort((a,b)=>a-b);
        if(orders.some((n,i)=>n!==i))throw new Error('Unreliable semantic block order');
      }
      return {kind,revisionId,blockIds,rows};
    },
  };
}
function parseRows(file,readBuffer,schema){
  const body=readBuffer(file);
  if(!Buffer.isBuffer(body))throw new Error(`Required metadata file absent: ${file}`);
  const lines=decoder.decode(body).split('\n').filter(line=>line.trim());
  return lines.map(line=>schema.parse(JSON.parse(line)));
}
export function validateSemanticPackage(manifest,readBuffer,summaries){
  const authors=parseRows('metadata/authors.ndjson',readBuffer,author);
  const works=parseRows('metadata/works.ndjson',readBuffer,work);
  const editions=parseRows('metadata/editions.ndjson',readBuffer,edition);
  const revisions=parseRows('metadata/revisions.ndjson',readBuffer,revision);
  const rightsRecords=parseRows('metadata/rights.ndjson',readBuffer,rights);
  for(const [key,rows] of Object.entries({authors,works,editions,revisions})){
    if(rows.length!==manifest.declared_counts[key])throw new Error(`Declared ${key} count mismatch`);
    if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error(`Duplicate ${key} ID`);
  }
  const authorIds=new Set(authors.map(a=>a.id)),workIds=new Set(works.map(w=>w.id));
  const editionMap=new Map(editions.map(e=>[e.id,e]));
  const revisionMap=new Map(revisions.map(r=>[r.id,r]));
  for(const w of works){
    if(w.authors.length!==new Set(w.authors).size||w.authors.some(id=>!authorIds.has(id)))throw new Error(`Work has missing or duplicate authors: ${w.id}`);
  }
  for(const e of editions)if(!workIds.has(e.work_id))throw new Error(`Edition refers to a different/missing work: ${e.id}`);
  for(const r of revisions){
    const e=editionMap.get(r.edition_id);
    if(!e||e.language!==r.language)throw new Error(`Revision edition/language mismatch: ${r.id}`);
    const content=summaries.get(`texts/${r.id}/blocks.jsonl`);
    if(!content||content.kind!=='text'||content.revisionId!==r.id)throw new Error(`Missing semantic text for prepared revision: ${r.id}`);
  }
  for(const [path,summary] of summaries){
    if(summary.kind==='text'&&!revisionMap.has(summary.revisionId))throw new Error(`Orphan text file: ${path}`);
    if(summary.kind!=='alignment')continue;
    for(const edge of summary.edges){
      const source=summaries.get(`texts/${edge.source_revision_id}/blocks.jsonl`);
      const target=summaries.get(`texts/${edge.target_revision_id}/blocks.jsonl`);
      if(!source?.blockIds?.has(edge.source_block_id)||!target?.blockIds?.has(edge.target_block_id))throw new Error(`Alignment references an absent prepared block: ${path}`);
      if(editionMap.get(revisionMap.get(edge.source_revision_id)?.edition_id)?.work_id!==editionMap.get(revisionMap.get(edge.target_revision_id)?.edition_id)?.work_id)throw new Error('Alignment mixes unrelated works');
    }
  }
  for(const record of rightsRecords){
    if(!workIds.has(record.work_id))throw new Error('Rights evidence refers to missing work');
    if(record.edition_id&&editionMap.get(record.edition_id)?.work_id!==record.work_id)throw new Error('Rights evidence references an unrelated edition');
    if(record.revision_id&&revisionMap.get(record.revision_id)?.edition_id!==record.edition_id)throw new Error('Rights evidence references an unrelated revision');
    if(record.review_status==='approved'||record.publication_status==='published')throw new Error('Package cannot self-approve rights/publication');
  }
  return {authors:authors.length,works:works.length,editions:editions.length,revisions:revisions.length,rightsRecords:rightsRecords.length,
    records:{authors,works,editions,revisions,rightsRecords}};
}
