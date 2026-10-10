import {and,asc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const MAX_DIFF_BLOCKS=100000;
const MAX_DIFF_CHAPTERS=10000;
const pageSchema=z.object({
  editionId:z.uuid(),
  fromRevisionId:z.uuid(),
  toRevisionId:z.uuid(),
  cursor:z.uuid().optional(),
  limit:z.number().int().min(1).max(100).default(50),
}).strict();
type DiffInput=z.infer<typeof pageSchema>;
/** Stable block IDs are identity; NEVER infer a textual alignment from order. */
export type SemanticDiffBlock={
  blockId:string;
  chapterId:string;
  ordinal:number;
  parentBlockId:string|null;
  kind:string;
  textSha256:string;
  sourceLocator:unknown;
  includeNormal:boolean;
  includeRsvp:boolean;
  includeAudio:boolean;
};
type DiffKind='added'|'removed'|'text_changed'|'metadata_changed'|'moved';
type PublicPosition={
  chapterId:string;ordinal:number;kind:string;textSha256:string;
  includeNormal:boolean;includeRsvp:boolean;includeAudio:boolean;
};
export type SemanticDiffChange={
  blockId:string;
  kind:DiffKind;
  before:PublicPosition|null;
  after:PublicPosition|null;
};
type Summary={added:number;removed:number;text_changed:number;metadata_changed:number;
  moved:number;unchanged:number};
type Chapter={chapterId:string;ordinal:number;heading:string};
type ChapterKind='added'|'removed'|'renamed'|'moved';
type ChapterChange={chapterId:string;kind:ChapterKind};

/** The source text, edition provenance, raw artifact locator and full heading
 * are intentionally NOT part of the returned diff. Only stable IDs/flags
 * and previously verified hashes are returned. This is not public access. */
function position(block:SemanticDiffBlock):PublicPosition{
  return {
    chapterId:block.chapterId,ordinal:block.ordinal,
    kind:block.kind,textSha256:block.textSha256,
    includeNormal:block.includeNormal,includeRsvp:block.includeRsvp,
    includeAudio:block.includeAudio,
  };
}
function canonicalJson(value:unknown):string{
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(value!==null&&typeof value==='object'){
    const v=value as Record<string,unknown>;
    return '{'+Object.keys(v).sort().map(key=>
      JSON.stringify(key)+':'+canonicalJson(v[key])).join(',')+'}';
  }
  return JSON.stringify(value)??'null';
}

/** Pure, deterministic metadata comparison. Text changes are detected from
 * immutable SHA-256; there is never AI inference, silent reconstruction,
 * word rewriting or heuristic block-to-block correlation. */
export function compareSemanticRevisionMetadata(
  before:readonly SemanticDiffBlock[],
  after:readonly SemanticDiffBlock[],
  beforeChapters:readonly Chapter[],
  afterChapters:readonly Chapter[],
){
  if(before.length>MAX_DIFF_BLOCKS||after.length>MAX_DIFF_BLOCKS||
    beforeChapters.length>MAX_DIFF_CHAPTERS||afterChapters.length>MAX_DIFF_CHAPTERS){
    throw new Error('Revision too large for bounded editorial diff');
  }
  const mapUnique=<T extends{blockId:string}>(items:readonly T[])=>{
    const map=new Map<string,T>();
    for(const item of items){
      if(map.has(item.blockId))throw new Error('Duplicate stable block ID in revision diff');
      map.set(item.blockId,item);
    }
    return map;
  };
  const old=mapUnique(before),next=mapUnique(after);
  const summary:Summary={added:0,removed:0,text_changed:0,
    metadata_changed:0,moved:0,unchanged:0};
  const changes:SemanticDiffChange[]=[];
  const ids=[...new Set([...old.keys(),...next.keys()])].sort();
  for(const blockId of ids){
    const from=old.get(blockId),to=next.get(blockId);
    let kind:DiffKind|'unchanged';
    if(!from)kind='added';
    else if(!to)kind='removed';
    else if(from.textSha256!==to.textSha256)kind='text_changed';
    else if(from.kind!==to.kind||
      from.parentBlockId!==to.parentBlockId||
      from.includeNormal!==to.includeNormal||
      from.includeRsvp!==to.includeRsvp||
      from.includeAudio!==to.includeAudio||
      canonicalJson(from.sourceLocator)!==canonicalJson(to.sourceLocator)){
      kind='metadata_changed';
    }else if(from.chapterId!==to.chapterId||from.ordinal!==to.ordinal){
      kind='moved';
    }else kind='unchanged';
    summary[kind]++;
    if(kind!=='unchanged'){
      changes.push({blockId,kind,before:from?position(from):null,
        after:to?position(to):null});
    }
  }
  const chapterMap=(rows:readonly Chapter[])=>{
    const map=new Map<string,Chapter>();
    for(const row of rows){
      if(map.has(row.chapterId))throw new Error('Duplicate stable chapter ID in diff');
      map.set(row.chapterId,row);
    }
    return map;
  };
  const oldCh=chapterMap(beforeChapters),newCh=chapterMap(afterChapters);
  const chapterChanges:ChapterChange[]=[];
  for(const chapterId of [...new Set([...oldCh.keys(),...newCh.keys()])].sort()){
    const a=oldCh.get(chapterId),b=newCh.get(chapterId);
    if(!a)chapterChanges.push({chapterId,kind:'added'});
    else if(!b)chapterChanges.push({chapterId,kind:'removed'});
    else if(a.heading!==b.heading)chapterChanges.push({chapterId,kind:'renamed'});
    else if(a.ordinal!==b.ordinal)chapterChanges.push({chapterId,kind:'moved'});
  }
  return {summary,changes,chapterChanges};
}

/** INTERNAL canonical revision metadata comparison. No unauthenticated HTTP
 * binding. The caller MUST verify administrator identity and relevant rights
 * before surfacing any diff. Query never selects sourceText or artifact bytes.
 * Every chapter/block SELECT shares a READ ONLY repeatable-read snapshot. */
export async function getInternalRevisionMetadataDiff(
  db:Database,rawInput:unknown,
){
  const input:DiffInput=pageSchema.parse(rawInput);
  return db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const revisions=await tx.select({
      id:schema.contentRevisions.id,
      editionId:schema.contentRevisions.editionId,
    }).from(schema.contentRevisions).where(and(
      eq(schema.contentRevisions.editionId,input.editionId),
      sql`${schema.contentRevisions.id} IN (${input.fromRevisionId}::uuid,${input.toRevisionId}::uuid)`,
    ));
    const found=new Set(revisions.map(row=>row.id));
    if(!found.has(input.fromRevisionId)||!found.has(input.toRevisionId)){
      return null;
    }
    const selectChapters=async(revisionId:string)=>
      tx.select({
        chapterId:schema.contentChapters.chapterId,
        ordinal:schema.contentChapters.ordinal,
        heading:schema.contentChapters.heading,
      }).from(schema.contentChapters).where(eq(schema.contentChapters.revisionId,revisionId))
        .orderBy(asc(schema.contentChapters.ordinal),asc(schema.contentChapters.chapterId))
        .limit(MAX_DIFF_CHAPTERS+1);
    const selectBlocks=async(revisionId:string)=>
      tx.select({
        blockId:schema.contentBlocks.blockId,
        chapterId:schema.contentBlocks.chapterId,
        ordinal:schema.contentBlocks.ordinal,
        parentBlockId:schema.contentBlocks.parentBlockId,
        kind:schema.contentBlocks.kind,
        textSha256:schema.contentBlocks.textSha256,
        sourceLocator:schema.contentBlocks.sourceLocator,
        includeNormal:schema.contentBlocks.includeNormal,
        includeRsvp:schema.contentBlocks.includeRsvp,
        includeAudio:schema.contentBlocks.includeAudio,
      }).from(schema.contentBlocks).where(eq(schema.contentBlocks.revisionId,revisionId))
        .orderBy(asc(schema.contentBlocks.chapterId),asc(schema.contentBlocks.ordinal),
          asc(schema.contentBlocks.blockId)).limit(MAX_DIFF_BLOCKS+1);
    const [beforeChapters,afterChapters,beforeBlocks,afterBlocks]=await Promise.all([
      selectChapters(input.fromRevisionId),
      selectChapters(input.toRevisionId),
      selectBlocks(input.fromRevisionId),
      selectBlocks(input.toRevisionId),
    ]);
    const compared=compareSemanticRevisionMetadata(
      beforeBlocks,afterBlocks,beforeChapters,afterChapters,
    );
    const remaining=compared.changes.filter(row=>
      input.cursor===undefined||row.blockId>input.cursor);
    const page=remaining.slice(0,input.limit);
    return {
      editionId:input.editionId,
      fromRevisionId:input.fromRevisionId,
      toRevisionId:input.toRevisionId,
      summary:compared.summary,
      chapterChanges:compared.chapterChanges,
      items:page,
      nextCursor:remaining.length>input.limit?(page.at(-1)?.blockId??null):null,
      isMetadataOnly:true as const,
    };
  },{isolationLevel:'repeatable read'});
}
