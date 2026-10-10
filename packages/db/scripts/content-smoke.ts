import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {
  createFolioDb,createCanonicalAuthor,createCanonicalWork,getCanonicalWorkDetails,
  createContentRevision,getRevisionBlocks,sha256Text,schema,
} from '../src/index.js';

function block(text:string, id:string, order:number,kind:string,rsvp:boolean,audio:boolean) {
  return {blockId:id,ordinal:order,kind,locator:{format:'text',path:`synthetic/${order}`},
    sourceText:text,textSha256:sha256Text(text),includeNormal:true,includeRsvp:rsvp,includeAudio:audio};
}
async function main(): Promise<void> {
  const url=process.env.DATABASE_URL;
  if (!url || !url.endsWith('/folio_test')) throw new Error('Content smoke only allowed on folio_test DB');
  const {db,pool}=createFolioDb(url);
  const actor=randomUUID();
  try {
    const author=await createCanonicalAuthor(db,actor,{canonicalName:`Content Fixture ${randomUUID()}`});
    const work=await createCanonicalWork(db,actor,{originalTitle:'Verbatim Lab Text',originalLanguage:'en',authors:[{authorId:author.id}],editions:[{language:'en',label:'Verbatim Lab Edition'}]});
    const details=await getCanonicalWorkDetails(db,work.id);
    const editionId=details?.editions[0]?.id;
    if (!editionId) throw new Error('Missing test edition');
    const chA=randomUUID(),chB=randomUUID(),headingId=randomUUID(),paraId=randomUUID(),noteId=randomUUID(),nextId=randomUUID();
    const firstText='An exact source sentence, with punctuation.\n Second line stays intact.';
    const data={editionId,language:'en',rawArtifactKey:`private/lab/${randomUUID()}`,rawSha256:'a'.repeat(64),parserVersion:'manual-fixture-1',
      provenance:{sourceName:'manual_local_pkg'},
      chapters:[
        {chapterId:chA,ordinal:0,heading:'Opening',blocks:[
          block('Opening',headingId,0,'heading',false,false),
          block(firstText,paraId,1,'paragraph',true,true),
          block('A footnote, outside speed/audio flow.',noteId,2,'footnote',false,false),
        ]},
        {chapterId:chB,ordinal:1,heading:'Next',blocks:[block('Another retained sentence.',nextId,0,'paragraph',true,true)]},
      ],
    };
    const first=await createContentRevision(db,actor,data);
    const reading=await getRevisionBlocks(db,first.revision.id,'normal');
    const fast=await getRevisionBlocks(db,first.revision.id,'rsvp');
    if (reading.length!==4 || fast.length!==2 || fast[0]?.blockId!==paraId || fast[1]?.blockId!==nextId) throw new Error('Semantic reading order/flags incorrect');
    const laterText='Updated text belongs ONLY to a second immutable revision.';
    const secondData={...data,rawArtifactKey:`private/lab/${randomUUID()}`,rawSha256:'b'.repeat(64),parentRevisionId:first.revision.id,
      chapters:data.chapters.map(c=>({...c,blocks:c.blocks.map(b=>b.blockId===paraId?{...b,sourceText:laterText,textSha256:sha256Text(laterText)}:b)}))};
    const second=await createContentRevision(db,actor,secondData);
    if (second.revision.id===first.revision.id) throw new Error('Revisions were overwritten');
    const firstBlock=(await getRevisionBlocks(db,first.revision.id,'rsvp'))[0];
    const secondBlock=(await getRevisionBlocks(db,second.revision.id,'rsvp'))[0];
    if (firstBlock?.sourceText!==firstText || secondBlock?.sourceText!==laterText) throw new Error('Original source was silently rewritten');
    let immutable=false;
    try { await db.update(schema.contentBlocks).set({sourceText:'tampered'}).where(and(eq(schema.contentBlocks.revisionId,first.revision.id),eq(schema.contentBlocks.blockId,paraId))); }
    catch {immutable=true;}
    if (!immutable) throw new Error('DB content immutability trigger did not run');
    let provenanceLocked=false;
    try {await db.update(schema.sourceProvenance).set({sourceName:'tampered'}).where(eq(schema.sourceProvenance.id,first.revision.provenanceId));}
    catch {provenanceLocked=true;}
    if (!provenanceLocked) throw new Error('Source provenance was mutable');
    let mismatchRejected=false;
    try {await createContentRevision(db,actor,{...data,rawArtifactKey:`private/lab/${randomUUID()}`,chapters:[{...data.chapters[0],blocks:[{...data.chapters[0]!.blocks[0],textSha256:'0'.repeat(64)}]}]});}
    catch {mismatchRejected=true;}
    if (!mismatchRejected) throw new Error('Bad source hash accepted');
    const audit=await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId,first.revision.id));
    if (!audit.some(e=>e.action==='content.revision.create')) throw new Error('Revision audit missing');
    console.log('Content revisions PASS: verbatim text/hash, stable IDs, source order, RSVP exclusions, parent revision, DB immutability, audit and corruption reject.');
  } finally {await pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
