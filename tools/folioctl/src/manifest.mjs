import {z} from 'zod';
import {lstatSync,readFileSync,readdirSync,statSync,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,join,sep,posix} from 'node:path';

export const MAX_FILE_BYTES=512*1024*1024;
export const MAX_PACKAGE_BYTES=4*1024*1024*1024;
export const MAX_ITEMS=10000;
export const META_LIMIT=8*1024*1024;

export function safeRelPath(input){
  if(typeof input!=='string'||!input||input.length>500||input.includes('\\')||input.includes('\0')||input.includes('\n')||input.includes('\r')||input.startsWith('/')||input.startsWith('./')||input.endsWith('/')||input.includes('//'))throw new Error(`Unsafe package path: ${String(input).slice(0,100)}`);
  const normalized=posix.normalize(input);
  if(normalized!==input||input.split('/').some(p=>p==='..'||p==='.'||!p||p.startsWith('.')))throw new Error(`Unsafe package path: ${input}`);
  return input;
}
const pathSchema=z.string().min(1).max(500).superRefine((value,ctx)=>{
  try {safeRelPath(value);}catch{ctx.addIssue({code:'custom',message:'Unsafe package path'});}
});
export const manifestSchema=z.object({
  schema_version:z.literal('1.0.0'),
  package_id:z.uuid(),
  created_at:z.iso.datetime({offset:true}),
  source:z.literal('local-editorial'),
  scope:z.literal('licensed-library'),
  declared_counts:z.object({authors:z.number().int().min(0),works:z.number().int().min(0),editions:z.number().int().min(0),revisions:z.number().int().min(0)}).strict(),
  tool:z.object({name:z.string().min(1).max(100),version:z.string().min(1).max(60)}).strict(),
  files:z.array(z.object({path:pathSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/),size_bytes:z.number().int().min(0).max(MAX_FILE_BYTES),kind:z.enum(['metadata','text','alignment','audio','asset'])}).strict()).min(1).max(MAX_ITEMS),
}).strict().superRefine((m,ctx)=>{
  const paths=m.files.map(f=>f.path);
  if(new Set(paths).size!==paths.length)ctx.addIssue({code:'custom',message:'Duplicate indexed path'});
  for(const required of ['metadata/authors.ndjson','metadata/works.ndjson','metadata/editions.ndjson','metadata/revisions.ndjson','metadata/rights.ndjson']){
    if(!paths.includes(required))ctx.addIssue({code:'custom',message:`Missing required metadata: ${required}`});
  }
  if(paths.some(path=>path==='manifest.json'||path==='sha256sums.txt'))ctx.addIssue({code:'custom',message:'Manifest or checksums must not be self-indexed'});
});

export async function hashFile(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
function listSafe(root){
  const files=[];
  const visit=(dir)=>{
    for(const entry of readdirSync(dir,{withFileTypes:true})){
      const absolute=join(dir,entry.name);
      const st=lstatSync(absolute);
      const rel=relative(root,absolute).split(sep).join('/');
      safeRelPath(rel);
      if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory()))throw new Error(`Symlinks and special files forbidden: ${rel}`);
      if(st.isDirectory()){visit(absolute);continue;}
      if(st.size>MAX_FILE_BYTES)throw new Error(`File exceeds limit: ${rel}`);
      files.push({path:rel,absolute,size:st.size});
      if(files.length>MAX_ITEMS+2)throw new Error('Package has too many files');
    }
  };
  visit(root);
  return files;
}

/** Validate a prepared DIRECTORY without archive extraction or external data access. */
export async function validatePreparedFolder(input){
  const root=resolve(input);
  if(lstatSync(root).isSymbolicLink()||!statSync(root).isDirectory())throw new Error('Only a real prepared directory can be validated');
  const files=listSafe(root);
  let total=0;
  for(const file of files){total+=file.size;if(total>MAX_PACKAGE_BYTES)throw new Error('Total package size exceeds limit');}
  const manifestFile=files.find(file=>file.path==='manifest.json');
  if(!manifestFile||manifestFile.size>META_LIMIT)throw new Error('Missing or oversized manifest.json');
  const manifest=manifestSchema.parse(JSON.parse(readFileSync(manifestFile.absolute,'utf8')));
  const indexed=new Map(manifest.files.map(file=>[file.path,file]));
  const physical=files.filter(f=>!['manifest.json','sha256sums.txt'].includes(f.path));
  if(physical.length!==indexed.size)throw new Error('Unindexed or missing package files');
  for(const file of physical){
    const expected=indexed.get(file.path);
    if(!expected)throw new Error(`Unindexed package file: ${file.path}`);
    if(expected.size_bytes!==file.size)throw new Error(`Size mismatch: ${file.path}`);
    if(await hashFile(file.absolute)!==expected.sha256)throw new Error(`SHA-256 mismatch: ${file.path}`);
    if((file.path.startsWith('metadata/') && expected.kind!=='metadata') || (file.path.startsWith('texts/') && expected.kind!=='text'))throw new Error(`Incorrect file kind: ${file.path}`);
  }
  for(const name of ['authors','works','editions','revisions']){
    const file=files.find(f=>f.path===`metadata/${name}.ndjson`);
    if(!file||file.size>META_LIMIT)throw new Error(`Missing/oversized metadata file: ${name}`);
    const lines=readFileSync(file.absolute,'utf8').split('\n').filter(line=>line.trim());
    if(lines.length!==manifest.declared_counts[name])throw new Error(`Declared ${name} count mismatch`);
    for(const line of lines){const record=JSON.parse(line);if(!record||typeof record!=='object'||Array.isArray(record))throw new Error(`Invalid metadata ${name} object`);}
  }
  const rights=files.find(f=>f.path==='metadata/rights.ndjson');
  if(!rights||rights.size>META_LIMIT)throw new Error('Missing/oversized rights evidence file');
  for(const line of readFileSync(rights.absolute,'utf8').split('\n').filter(line=>line.trim())){
    const record=JSON.parse(line);
    if(!record||typeof record!=='object'||Array.isArray(record)||!('evidence' in record))throw new Error('Missing rights evidence record');
  }
  const sum=files.find(f=>f.path==='sha256sums.txt');
  const checksums=[manifestFile,...physical].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(async f=>`${await hashFile(f.absolute)}  ${f.path}`);
  const checksumText=(await Promise.all(checksums)).join('\n')+'\n';
  if(sum){
    if(sum.size>META_LIMIT)throw new Error('Oversized sha256sums.txt');
    if(readFileSync(sum.absolute,'utf8')!==checksumText)throw new Error('Checksum index differs from files');
  }
  return {manifest,checksums:checksumText,count:physical.length,totalBytes:total};
}
