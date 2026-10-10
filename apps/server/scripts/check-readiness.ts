import { createFolioApp } from '../src/main.js';
async function check(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('Folio lab DATABASE_URL required');
  const app = await createFolioApp();
  try {
    const server = await app.listen(0, '127.0.0.1');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid loopback listener');
    const result = await fetch(`http://127.0.0.1:${address.port}/v1/ready`);
    if (result.status !== 200 || (await result.json()).status !== 'ready') throw new Error('Database readiness HTTP smoke failed');
    console.log('Folio API PostgreSQL readiness returned HTTP 200 on a real loopback server.');
  } finally { await app.close(); }
}
void check().catch(error => {console.error(error);process.exitCode = 1;});
