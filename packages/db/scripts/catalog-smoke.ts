import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createFolioDb, createCanonicalAuthor, createCanonicalWork, getCanonicalWorkDetails, searchCanonicalWorksForAdmin, searchCanonicalAuthorsForAdmin, schema} from '../src/index.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !url.endsWith('/folio_test')) throw new Error('Catalog integration test requires explicitly isolated folio_test DB');
  const {db, pool} = createFolioDb(url);
  const actor = randomUUID();
  const suffix = randomUUID().slice(0,8);
  try {
    const authorRequestId=randomUUID();
    const workRequestId=randomUUID();
    const writer = await createCanonicalAuthor(db, actor, {
      canonicalName: `Lab Author ${suffix}`, aliases: [{name:`Alias ${suffix}`,locale:'en'}],
      externalIds:[{source:'folio_test',externalId:`lab-${suffix}`}],
    },authorRequestId);
    const translator = await createCanonicalAuthor(db, actor, {canonicalName:`Lab Translator ${suffix}`});
    const commonTitle = `Synthetic Draft ${suffix}`;
    const input = {
      originalTitle: commonTitle,
      originalLanguage:'tr', authors:[{authorId: writer.id, contribution:'author', sortOrder:0}],
      titles:[{language:'en', title:`Translation ${suffix}`,kind:'translation'}],
      editions: [
        {language:'tr',label:'Original',identifiers:[{kind:'isbn-13',value:'9780000000001'}], contributors:[{authorId:writer.id,role:'author',sortOrder:0}]},
        {language:'en',label:'Translated',identifiers:[{kind:'isbn-13',value:'9780000000001'}],contributors:[{authorId:translator.id,role:'translator',sortOrder:0}]},
      ],
    } as const;
    const work = await createCanonicalWork(db, actor, input,workRequestId);
    const duplicateTitle = await createCanonicalWork(db, actor, {...input, editions: []});
    if (work.id === duplicateTitle.id) throw new Error('Works were falsely merged by identical title');
    const details = await getCanonicalWorkDetails(db, work.id);
    if (!details || details.work.publicationStatus !== 'draft' || details.authors.length !== 1 || details.editions.length !== 2) throw new Error('Canonical relationships incorrect');
    if (!details.editions.some(e=>e.language==='en'&&e.contributors.some(c=>c.authorId===translator.id))) throw new Error('Translation contributor relationship missing');
    const storedAliases = await db.select().from(schema.authorAliases).where(eq(schema.authorAliases.authorId,writer.id));
    if (storedAliases.length!==1) throw new Error('Author alias not persisted');
    const storedExternalIds = await db.select().from(schema.authorExternalIds).where(eq(schema.authorExternalIds.authorId,writer.id));
    if (storedExternalIds.length!==1) throw new Error('Author external ID not persisted');
    const beforeCount = (await db.select().from(schema.works).where(eq(schema.works.originalTitle,`Invalid Work ${suffix}`))).length;
    let rejected=false;
    try {await createCanonicalWork(db,actor,{originalTitle:`Invalid Work ${suffix}`,originalLanguage:'tr',authors:[{authorId:randomUUID()}]});}
    catch {rejected=true;}
    const afterCount = (await db.select().from(schema.works).where(eq(schema.works.originalTitle,`Invalid Work ${suffix}`))).length;
    if (!rejected || beforeCount!==afterCount) throw new Error('Broken author reference was not atomically rolled back');
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId,work.id));
    if (!audit.some(e=>e.action==='work.create'&&e.requestId===workRequestId)){
      throw new Error('Canonical work audit missed trusted request ID correlation');
    }
    const authorAudit=await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId,writer.id));
    if(!authorAudit.some(e=>e.action==='author.create'&&e.requestId===authorRequestId)){
      throw new Error('Canonical author audit missed trusted request ID correlation');
    }
    const translatorAudit=await db.select().from(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId,translator.id));
    if(translatorAudit.length!==1||translatorAudit[0]?.requestId!==null){
      throw new Error('Non-HTTP draft command fabricated a request ID');
    }
    const malformedAuthor=`Bad Audit Author ${suffix}`;
    let malformedAuthorRejected=false;
    try{
      await createCanonicalAuthor(db,actor,{canonicalName:malformedAuthor},'attacker-request-id');
    }catch{malformedAuthorRejected=true;}
    if(!malformedAuthorRejected)throw new Error('Malformed catalog author trace was accepted');
    const fakeAuthorRows=await db.select().from(schema.authors)
      .where(eq(schema.authors.canonicalName,malformedAuthor));
    if(fakeAuthorRows.length!==0)throw new Error('Bad trace wrote draft author before validation');
    const malformedTitle=`Bad Audit Work ${suffix}`;
    let malformedWorkRejected=false;
    try{
      await createCanonicalWork(db,actor,{...input,originalTitle:malformedTitle},'attacker-request-id');
    }catch{malformedWorkRejected=true;}
    if(!malformedWorkRejected)throw new Error('Malformed catalog work trace was accepted');
    const fakeWorkRows=await db.select().from(schema.works)
      .where(eq(schema.works.originalTitle,malformedTitle));
    if(fakeWorkRows.length!==0)throw new Error('Bad trace wrote draft work before validation');
    // Internal searches MUST never expose drafts through an unguarded HTTP route.
    // Test canonical title, alternate title, alias author and edition contributor.
    const pageOne=await searchCanonicalWorksForAdmin(db,{query:commonTitle,limit:1});
    if(pageOne.items.length!==1||!pageOne.nextCursor)throw new Error('Draft search cursor page missing');
    const pageTwo=await searchCanonicalWorksForAdmin(db,{query:commonTitle,limit:1,cursor:pageOne.nextCursor});
    if(pageTwo.items.length!==1||pageTwo.items[0]?.id===pageOne.items[0]?.id||pageTwo.nextCursor!==null){
      throw new Error('Draft catalog UUID cursor repeated or dropped a work');
    }
    const english=await searchCanonicalWorksForAdmin(db,{query:`Translation ${suffix}`});
    if(!english.items.some(i=>i.id===work.id))throw new Error('Translated title search missing canonical work');
    const viaAlias=await searchCanonicalWorksForAdmin(db,{query:`Alias ${suffix}`});
    if(!viaAlias.items.some(i=>i.id===work.id))throw new Error('Writer alias failed to find work');
    const viaContributor=await searchCanonicalWorksForAdmin(db,{query:`Lab Translator ${suffix}`});
    if(!viaContributor.items.some(i=>i.id===work.id))throw new Error('Edition contributor failed to find work');
    const matchedAuthor=await searchCanonicalAuthorsForAdmin(db,{query:`Alias ${suffix}`});
    if(!matchedAuthor.items.some(i=>i.id===writer.id))throw new Error('Author alias lookup failed');

    const literal=await createCanonicalWork(db,actor,{...input,
      originalTitle:`Percent % ${suffix}`,titles:[],editions:[]});
    const exactLike=await searchCanonicalWorksForAdmin(db,{query:`% ${suffix}`,limit:50});
    if(exactLike.items.length!==1||exactLike.items[0]?.id!==literal.id){
      throw new Error('A literal SQL LIKE wildcard broadened the catalog search');
    }
    let invalidSearch=false;
    try{await searchCanonicalWorksForAdmin(db,{query:'',limit:99});}
    catch{invalidSearch=true;}
    if(!invalidSearch)throw new Error('Unbounded/empty admin catalog search was accepted');
    if(pageOne.items[0]?.publicationStatus!=='draft')throw new Error('Catalog preview misrepresented a draft work');
    console.log('Internal work/author search PASS: UUID cursor, aliases, translators, alternate title, literal LIKE escape, bounded paging; draft never made public.');
    console.log('Canonical catalog PASS: aliases/IDs, N:M authors, 2 language editions/contributors, repeated ISBN/title, FK rollback, trusted request-ID audit and malformed trace rollback; all unpublished draft.');
  } finally {await pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
