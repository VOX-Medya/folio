import {readFileSync,writeFileSync} from 'node:fs';
import {z} from 'zod';
import {manifestSchema} from './manifest.mjs';
const path=new URL('../manifest-v1.schema.json',import.meta.url);
const content=JSON.stringify(z.toJSONSchema(manifestSchema,{target:'draft-2020-12'}),null,2)+'\n';
if(process.argv.includes('--check')){
  if(readFileSync(path,'utf8')!==content)throw new Error('Manifest JSON Schema drift; regenerate via pnpm schema:write');
  console.log('Folio manifest v1 JSON Schema unchanged.');
}else writeFileSync(path,content);
