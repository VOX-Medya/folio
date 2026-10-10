import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFolioApp, createOpenApiDocument } from '../src/main.js';

async function main(): Promise<void> {
  const app = await createFolioApp();
  try {
    await app.init();
    const spec = JSON.stringify(createOpenApiDocument(app), null, 2) + '\n';
    const target = resolve(process.cwd(), '../../docs/api/openapi.v1.json');
    if (process.argv.includes('--check')) {
      if (readFileSync(target, 'utf8') !== spec) {
        console.error('FOLIO_OPENAPI_GENERATED_START');
        console.error(spec);
        console.error('FOLIO_OPENAPI_GENERATED_END');
        throw new Error('OpenAPI contract changed: regenerate and review docs/api/openapi.v1.json');
      }
      console.log('OpenAPI snapshot unchanged.');
    } else {
      writeFileSync(target, spec);
      console.log(`OpenAPI snapshot written: ${target}`);
    }
  } finally { await app.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
