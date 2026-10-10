import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {resolve} from 'node:path';
import {createFolioDb} from '../src/index.js';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required; never migrate an unspecified database');
  const {pool, db} = createFolioDb(url);
  try {
    await migrate(db, {migrationsFolder: resolve(process.cwd(), 'drizzle')});
    console.log('Folio Drizzle migrations applied without destructive resets.');
  } finally {await pool.end();}
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
