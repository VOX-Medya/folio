import {randomUUID} from 'node:crypto';
import {PgBoss} from 'pg-boss';
import {eq} from 'drizzle-orm';
import {createFolioDb, schema} from '../src/index.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Explicit DATABASE_URL required for Folio-only integration test');
  const {pool, db} = createFolioDb(url);
  const marker = randomUUID();
  try {
    const extension = await pool.query("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'");
    if (extension.rowCount !== 1) throw new Error('pg_trgm extension missing');
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    for (const table of ['works','authors','work_authors','audit_events','import_batches']) {
      if (!tables.rows.some(row => row.tablename === table)) throw new Error(`Missing table ${table}`);
    }
    // Test a relational and audit write but force a rollback: no generated content persists.
    class IntentionalRollback extends Error {}
    try {
      await db.transaction(async tx => {
        const [author] = await tx.insert(schema.authors).values({canonicalName: marker, sortName: marker}).returning();
        const [work] = await tx.insert(schema.works).values({originalTitle: marker, originalLanguage: 'tr'}).returning();
        if (!author || !work) throw new Error('Failed to return inserted IDs');
        await tx.insert(schema.workAuthors).values({workId: work.id, authorId: author.id});
        await tx.insert(schema.auditEvents).values({action:'lab.rollback',entityType:'work',entityId:work.id, afterJson:{id:work.id},reason:'test'});
        throw new IntentionalRollback('Prove rollback');
      });
    } catch (error) { if (!(error instanceof IntentionalRollback)) throw error; }
    const found = await db.select().from(schema.works).where(eq(schema.works.originalTitle, marker));
    if (found.length !== 0) throw new Error('Rollback leaked test data');
    console.log('Database tables, pg_trgm, FK and rollback verified without persistent test records.');
  } finally { await pool.end(); }

  // pg-boss queue persists through boss process restart and blocks duplicate singleton requests.
  const queue = 'folio.lab.smoke';
  const bossOne = new PgBoss({connectionString: url, schema: 'folio_boss'});
  await bossOne.start();
  let jobId: string | null | undefined;
  try {
    await bossOne.createQueue(queue);
    jobId = await bossOne.send(queue, {marker}, {singletonKey: marker, singletonSeconds: 90});
    const duplicate = await bossOne.send(queue, {marker}, {singletonKey: marker, singletonSeconds: 90});
    if (!jobId || duplicate) throw new Error('Singleton request did not prevent duplicate job');
  } finally { await bossOne.stop(); }

  const bossTwo = new PgBoss({connectionString: url, schema: 'folio_boss'});
  await bossTwo.start();
  try {
    const observed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Job was not resumed after boss restart')), 20000);
      void bossTwo.work(queue, async jobs => {
        if (jobs.some(job => job.id === jobId && (job.data as {marker:string}).marker === marker)) {
          clearTimeout(timer);
          resolve();
        }
      }).catch(reject);
    });
    await observed;
    console.log('pg-boss persistent job survived restart and singleton deduplication was enforced.');
  } finally { await bossTwo.stop(); }
}
void main().catch(error => {console.error(error); process.exitCode = 1;});
