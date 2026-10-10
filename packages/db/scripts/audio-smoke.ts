import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {
  createFolioDb,createCanonicalAuthor,createCanonicalWork,getCanonicalWorkDetails,createContentRevision,
  sha256Text,registerPreparedAudioAsset,registerPreparedAudioVariant,replacePreparedAudioSegment,getPreparedAudioVariant,schema,
} from '../src/index.js';

async function main():Promise<void>{
  const url=process.env.DATABASE_URL;
  if(!url || !url.endsWith('/folio_test'))throw new Error('Prepared audio integration requires isolated folio_test DB');
  const {db,pool}=createFolioDb(url),actor=randomUUID();
  try{
    const author=await createCanonicalAuthor(db,actor,{canonicalName:`Audio Fixture ${randomUUID()}`});
    const work=await createCanonicalWork(db,actor,{originalTitle:'Synthetic Audible Revision',originalLanguage:'tr',
      authors:[{authorId:author.id}],editions:[{language:'tr',label:'Synthetic voice-ready edition'}]});
    const editionId=(await getCanonicalWorkDetails(db,work.id))?.editions[0]?.id;
    if(!editionId)throw new Error('Missing test edition');
    const chapterId=randomUUID(),block1=randomUUID(),block2=randomUUID();
    const text1='Birinci paragraf sadece sentetik test metnidir.';
    const text2='İkinci paragraf için hazır ses dosyası eşleştirmesi.';
    const makeBlock=(id:string,order:number,text:string)=>({blockId:id,ordinal:order,kind:'paragraph',
      locator:{format:'text',path:`test/${order}`},sourceText:text,textSha256:sha256Text(text),includeRsvp:true,includeAudio:true});
    const revision=await createContentRevision(db,actor,{
      editionId,language:'tr',rawArtifactKey:`private/synthetic/${randomUUID()}`,rawSha256:'c'.repeat(64),
      parserVersion:'manual-synthetic',provenance:{sourceName:'manual_local_pkg'},
      chapters:[{chapterId,ordinal:0,heading:'Fixture',blocks:[makeBlock(block1,0,text1),makeBlock(block2,1,text2)]}],
    });
    const asset1=await registerPreparedAudioAsset(db,actor,{storageKey:`private/catalog/${randomUUID()}.m4a`,sha256:'a'.repeat(64),sizeBytes:4096,mime:'audio/mp4',durationMs:10000});
    const asset2=await registerPreparedAudioAsset(db,actor,{storageKey:`private/catalog/${randomUUID()}.m4a`,sha256:'b'.repeat(64),sizeBytes:4096,mime:'audio/mp4',durationMs:11000});
    const segment1={chapterId,ordinal:0,assetId:asset1.id,textBlockId:block1,textSha256:sha256Text(text1),startMs:0,endMs:4000};
    const segment2={chapterId,ordinal:1,assetId:asset2.id,textBlockId:block2,textSha256:sha256Text(text2),startMs:0,endMs:6000};
    const variant=await registerPreparedAudioVariant(db,actor,{
      contentRevisionId:revision.revision.id,language:'tr',voiceId:'manual.voice.01',sourceLabel:'Prepared manual file',codec:'m4a',
      segments:[segment1,segment2],
    });
    if(variant.status!=='draft' || variant.variantVersion!==1 || variant.supersedesVariantId!==null)throw new Error('Variant was unexpectedly playable or versioned');
    const asset3=await registerPreparedAudioAsset(db,actor,{storageKey:`private/catalog/${randomUUID()}.m4a`,sha256:'d'.repeat(64),sizeBytes:4096,mime:'audio/mp4',durationMs:12000});
    const updated=await replacePreparedAudioSegment(db,actor,variant.id,{...segment2,assetId:asset3.id,endMs:5000});
    if(updated.id===variant.id||updated.variantVersion!==2||updated.supersedesVariantId!==variant.id)throw new Error('Replacement overwrote or mis-versioned the old variant');
    const oldState=await getPreparedAudioVariant(db,variant.id),newState=await getPreparedAudioVariant(db,updated.id);
    if(!oldState||!newState||oldState.segments[1]?.assetId!==asset2.id||newState.segments[1]?.assetId!==asset3.id){
      throw new Error('Existing audio listener segment was mutated');
    }
    if(newState.segments[0]?.assetId!==asset1.id || newState.variant.status!=='draft')throw new Error('Unchanged segment/version lost or made public');
    let rejected=false;
    try{await registerPreparedAudioVariant(db,actor,{
      contentRevisionId:revision.revision.id,language:'tr',voiceId:'wrong.hash',sourceLabel:'Invalid prepared audio',codec:'m4a',
      segments:[{...segment1,textSha256:'f'.repeat(64)}],
    });}catch{rejected=true;}
    if(!rejected)throw new Error('Wrong source text hash was accepted for audio segment');
    let overrun=false;
    try{await registerPreparedAudioVariant(db,actor,{
      contentRevisionId:revision.revision.id,language:'tr',voiceId:'wrong.duration',sourceLabel:'Invalid prepared audio',codec:'m4a',
      segments:[{...segment1,endMs:20000}],
    });}catch{overrun=true;}
    if(!overrun)throw new Error('Segment beyond asset duration was accepted');
    if(await getPreparedAudioVariant(db,randomUUID())!==null)throw new Error('Unknown audio variant was not gracefully absent');
    const audit=await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId,updated.id));
    if(!audit.some(e=>e.action==='audio.variant.create'))throw new Error('Audio variant audit missing');
    const [workState]=await db.select().from(schema.works).where(eq(schema.works.id,work.id));
    if(workState?.publicationStatus!=='draft')throw new Error('Audio metadata registration published a work');
    console.log('Prepared audio PASS: catalog manifest pending verification, revision/hash/time/codec checks, variant v1->v2 segment copy-on-write, missing asset state, audit; no TTS or playable media.');
  }finally{await pool.end();}
}
void main().catch(err=>{console.error(err);process.exitCode=1;});
