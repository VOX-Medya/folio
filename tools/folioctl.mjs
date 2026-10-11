import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_MANIFEST_BYTES=256*1024;
const MAX_FILE_BYTES=200*1024*1024;

function requireObject(value,name){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    throw new Error(name+' must be an object');
  }
  return value;
}
function requireString(value,name,max){
  if(typeof value!=='string'||!value.trim()||value.length>max){
    throw new Error('Invalid '+name);
  }
  return value;
}
function safeFilePath(value){
  const path=requireString(value,'asset path',200);
  if(path.startsWith('/')||path.includes('\\')||path.includes(':')||
    path.includes('\0')||path.split('/').some(s=>s===''||s==='.'||s==='..')){
    throw new Error('Asset path must be a safe package-relative POSIX path');
  }
  return path;
}
function validateManifestShape(raw){
  const manifest=requireObject(raw,'Manifest');
  if(manifest.schemaVersion!=='1.0.0')throw new Error('Unsupported manifest version');
  if(typeof manifest.packageId!=='string'||!UUID.test(manifest.packageId)){
    throw new Error('Invalid manifest packageId');
  }
  const book=requireObject(manifest.book,'book');
  requireString(book.title,'book title',400);
  if(!['tr','en'].includes(book.language))throw new Error('Unsupported book language');
  requireString(book.editionLabel,'edition label',400);
  if(!Array.isArray(book.authors)||book.authors.length<1||book.authors.length>10){
    throw new Error('A book needs 1-10 named authors');
  }
  book.authors.forEach(name=>requireString(name,'author name',240));
  if(!Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>50){
    throw new Error('Expected 1-50 prepared assets');
  }
  const seen=new Set();
  let textFiles=0;
  for(const rawFile of manifest.files){
    const file=requireObject(rawFile,'asset');
    const path=safeFilePath(file.path);
    if(seen.has(path))throw new Error('Repeated asset path');
    seen.add(path);
    if(!['text','audio','cover'].includes(file.kind)){
      throw new Error('Invalid prepared asset kind');
    }
    if(file.kind==='text')textFiles++;
    if(typeof file.sha256!=='string'||!SHA.test(file.sha256)){
      throw new Error('Invalid asset SHA-256');
    }
    if(!Number.isSafeInteger(file.sizeBytes)||
      file.sizeBytes<1||file.sizeBytes>MAX_FILE_BYTES){
      throw new Error('Invalid asset size');
    }
  }
  if(textFiles!==1)throw new Error('Exactly one prepared text source required');
  return manifest;
}
async function readVerifiedAsset(root,rootReal,file){
  const parts=file.path.split('/');
  let path=root;
  for(let i=0;i<parts.length;i++){
    path=resolve(path,parts[i]);
    const stat=await lstat(path);
    if(stat.isSymbolicLink())throw new Error('Symbolic links are forbidden in packages');
    if(i<parts.length-1&&!stat.isDirectory()){
      throw new Error('Asset parent is not a directory');
    }
    if(i===parts.length-1&&(!stat.isFile()||stat.size!==file.sizeBytes)){
      throw new Error('Prepared asset missing or size mismatch: '+file.path);
    }
  }
  const actual=await realpath(path);
  if(!actual.startsWith(rootReal+sep)){
    throw new Error('Asset escapes the package root');
  }
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  if(hash.digest('hex')!==file.sha256){
    throw new Error('Asset SHA-256 mismatch: '+file.path);
  }
}
/** Read-only validation: no database writes, rights approval, import or publication. */
export async function validatePackage(manifestPath){
  const input=resolve(manifestPath);
  const stat=await lstat(input);
  if(!stat.isFile()||stat.isSymbolicLink()||
    stat.size<1||stat.size>MAX_MANIFEST_BYTES){
    throw new Error('Invalid manifest file');
  }
  const bytes=await readFile(input);
  const parsed=validateManifestShape(JSON.parse(bytes.toString('utf8')));
  const root=dirname(input),rootReal=await realpath(root);
  for(const file of parsed.files){
    await readVerifiedAsset(root,rootReal,file);
  }
  return {
    packageId:parsed.packageId,schemaVersion:parsed.schemaVersion,
    manifestSha256:createHash('sha256').update(bytes).digest('hex'),
    fileCount:parsed.files.length,
    verifiedBytes:parsed.files.reduce((n,file)=>n+file.sizeBytes,0),
  };
}
async function main(){
  const [command,path,...extra]=process.argv.slice(2);
  if(command!=='validate'||!path||extra.length){
    throw new Error('Usage: pnpm folioctl validate <package/manifest.json>');
  }
  const result=await validatePackage(path);
  console.log('folioctl validated '+result.packageId+
    ' version '+result.schemaVersion+' files '+result.fileCount+
    ' bytes '+result.verifiedBytes+' manifest SHA-256 '+result.manifestSha256);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{
    console.error('folioctl: '+(error instanceof Error?error.message:'Validation failed'));
    process.exitCode=1;
  });
}
