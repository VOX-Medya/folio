import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {createFolioDb, createCanonicalAuthor, createCanonicalWork, getCanonicalWorkDetails, schema} from '../src/index.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !url.endsWith('/folio_test')) throw new Error('Catalog integration test requires explicitly isolated folio_test DB');
  const {db, pool} = createFolioDb(url);
  const actor = randomUUID();
  const suffix = randomUUID().slice(0,8);
  try {
    const writer = await createCanonicalAuthor(db, actor, {
      canonicalName: `Lab Author ${suffix}`, aliases: [{name:`Alias ${suffix}`,locale:'en'}],
      externalIds:[{source:'folio_test',externalId:`lab-${suffix}`}],
    });
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
    const work = await createCanonicalWork(db, actor, input);
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
    if (!audit.some(e=>e.action==='work.create')) throw new Error('Work creation was not audited');
    console.log('Canonical catalog PASS: aliases/IDs, N:M authors, 2 language editions/contributors, repeated ISBN/title, FK rollback and audit; all unpublished draft.');
  } finally {await pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
