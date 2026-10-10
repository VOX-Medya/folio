import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createFolioDb,createCanonicalAuthor,createCanonicalWork,getCanonicalWorkDetails,
  createContentRevision,sha256Text,createPreparedTranslationLink,verifyPreparedTranslationEdges,
  resolveTranslationSwitch,schema} from '../src/index.js';

async function main():Promise<void>{
  const url=process.env.DATABASE_URL;
  if(!url || !url.endsWith('/folio_test'))throw new Error('Translation integration needs isolated folio_test');
  const {db,pool}=createFolioDb(url);const actor=randomUUID();
  try{
    const author=await createCanonicalAuthor(db,actor,{canonicalName:`Translator Source ${randomUUID()}`});
    const translator=await createCanonicalAuthor(db,actor,{canonicalName:`Manual Translator ${randomUUID()}`});
    const work=await createCanonicalWork(db,actor,{originalTitle:'Fixture for manual translation',originalLanguage:'en',
      authors:[{authorId:author.id}],editions:[
        {language:'en',label:'Source EN'},
        {language:'tr',label:'Prepared TR',contributors:[{authorId:translator.id,role:'translator',sortOrder:0}]},
      ]});
    const detail=await getCanonicalWorkDetails(db,work.id);
    const enEdition=detail?.editions.find(e=>e.language==='en')?.id;
    const trEdition=detail?.editions.find(e=>e.language==='tr')?.id;
    if(!enEdition || !trEdition)throw new Error('Missing target/source test editions');
    const sourceChapter=randomUUID(),targetChapter=randomUUID();
    const s1=randomUUID(),s2=randomUUID(),s3=randomUUID();
    const t1=randomUUID(),t2=randomUUID(),t3=randomUUID();
    const makeBlock=(id:string,ordinal:number,body:string)=>({
      blockId:id,ordinal,kind:'paragraph',locator:{format:'text',path:`fixture/${ordinal}`},
      sourceText:body,textSha256:sha256Text(body),includeRsvp:true,includeAudio:true,
    });
    const create=(editionId:string,language:string,chapterId:string,blocks:ReturnType<typeof makeBlock>[])=>createContentRevision(db,actor,{
      editionId,language,rawArtifactKey:`private/translation-test/${randomUUID()}`,
      rawSha256:sha256Text(blocks.map(b=>b.sourceText).join('')),
      parserVersion:'manual-prepared-fixture',provenance:{sourceName:'manual_local_pkg'},
      chapters:[{chapterId,ordinal:0,heading:'Section I',blocks}],
    });
    const source=await create(enEdition,'en',sourceChapter,[
      makeBlock(s1,0,'One source passage is translated into two target passages.'),
      makeBlock(s2,1,'Second source passage joins target passage two.'),
      makeBlock(s3,2,'Unmapped source retains chapter fallback.'),
    ]);
    const target=await create(trEdition,'tr',targetChapter,[
      makeBlock(t1,0,'Birinci hedef paragraf.'),
      makeBlock(t2,1,'İkinci hedef paragraf, iki kaynakla eşleşir.'),
      makeBlock(t3,2,'Diğer hedef paragraf.'),
    ]);
    const link=await createPreparedTranslationLink(db,actor,{
      sourceRevisionId:source.revision.id,targetRevisionId:target.revision.id,translatorId:translator.id,
      provenance:{kind:'manual_import',packageId:'synthetic-manual-translation'},
      alignments:[{sourceBlockId:s1,targetBlockId:t1},{sourceBlockId:s1,targetBlockId:t2},
        {sourceBlockId:s2,targetBlockId:t2}],
    });
    const initial=await resolveTranslationSwitch(db,{linkId:link.id,sourceBlockId:s1});
    if(initial.mode!=='chapter-fallback' || initial.targetChapterId!==targetChapter || initial.targetBlockIds.length)throw new Error('Unverified mapping incorrectly used');
    await verifyPreparedTranslationEdges(db,actor,link.id,'Synthetic manual reviewer verification only.');
    const oneToMany=await resolveTranslationSwitch(db,{linkId:link.id,sourceBlockId:s1});
    const manyToOne=await resolveTranslationSwitch(db,{linkId:link.id,sourceBlockId:s2});
    const unmapped=await resolveTranslationSwitch(db,{linkId:link.id,sourceBlockId:s3});
    if(oneToMany.mode!=='verified-blocks'||JSON.stringify(oneToMany.targetBlockIds)!==JSON.stringify([t1,t2]))throw new Error('1:N mapping order incorrect');
    if(manyToOne.mode!=='verified-blocks'||JSON.stringify(manyToOne.targetBlockIds)!==JSON.stringify([t2]))throw new Error('N:1 mapping incorrect');
    if(unmapped.mode!=='chapter-fallback'||unmapped.targetChapterId!==targetChapter)throw new Error('Unmapped fallback failure');
    let wrongEdgeRejected=false;
    try{await createPreparedTranslationLink(db,actor,{
      sourceRevisionId:target.revision.id,targetRevisionId:source.revision.id,
      provenance:{kind:'manual_import',packageId:'invalid-edge-test'},
      alignments:[{sourceBlockId:s1,targetBlockId:t1}],
    });}catch{wrongEdgeRejected=true;}
    if(!wrongEdgeRejected)throw new Error('Wrong revision block ownership accepted');
    if(source.revision.id===target.revision.id||source.revision.language===target.revision.language)throw new Error('Translation revisions were conflated');
    const audit=await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId,link.id));
    if(!audit.some(x=>x.action==='translation.alignments.review'))throw new Error('Manual review audit missing');
    const [workState]=await db.select().from(schema.works).where(eq(schema.works.id,work.id));
    if(workState?.publicationStatus!=='draft')throw new Error('Prepared translation accidentally published');
    console.log('Prepared TR/EN translation PASS: separate editions/revisions, 1:N + N:1 verified mapping, unverified/unmapped chapter fallback, cross-revision FK, review audit; no generation or publication.');
  }finally{await pool.end();}
}
void main().catch(err=>{console.error(err);process.exitCode=1;});
