import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {constants} from 'node:fs';
import {lstat,readFile,realpath,open} from 'node:fs/promises';
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
function requireKnownKeys(record,keys,label){
  for(const key of Object.keys(record)){
    if(!keys.includes(key))throw new Error('Disallowed '+label+' field: '+key);
  }
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
  requireKnownKeys(manifest,['schemaVersion','packageId','book','files'],'manifest');
  if(manifest.schemaVersion!=='1.0.0')throw new Error('Unsupported manifest version');
  if(typeof manifest.packageId!=='string'||!UUID.test(manifest.packageId)){
    throw new Error('Invalid manifest packageId');
  }
  const book=requireObject(manifest.book,'book');
  requireKnownKeys(book,['title','language','authors','editionLabel'],'book');
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
    requireKnownKeys(file,['path','kind','sha256','sizeBytes'],'asset');
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
/**
 * The manifest was checked against actual disk bytes. Recheck text after read,
 * too, so a replacement between validation and staging cannot enter the DB.
 * Other prepared media is deliberately deferred to #16/#26.
 */
export async function prepareVerifiedSingleBook(manifestPath){
  const result=await validatePackage(manifestPath);
  const input=resolve(manifestPath);
  const manifestBytes=await readFile(input);
  if(createHash('sha256').update(manifestBytes).digest('hex')!==result.manifestSha256){
    throw new Error('Manifest changed after its initial validation');
  }
  const manifest=validateManifestShape(JSON.parse(manifestBytes.toString('utf8')));
  if(manifest.files.length!==1||manifest.files[0].kind!=='text'){
    throw new Error('Initial draft import supports one text asset; audio/cover require #16/#26');
  }
  const file=manifest.files[0],bytes=await readFile(resolve(dirname(input),file.path));
  if(bytes.length>1024*1024||bytes.length!==file.sizeBytes||
    createHash('sha256').update(bytes).digest('hex')!==file.sha256){
    throw new Error('Draft source size/SHA-256 mismatch after read');
  }
  const sourceText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(!sourceText||sourceText.includes(String.fromCharCode(0)))throw new Error('Invalid UTF-8 prepared text');
  return {packageId:manifest.packageId,manifestSha256:result.manifestSha256,
    schemaVersion:manifest.schemaVersion,book:manifest.book,
    source:{path:file.path,sha256:file.sha256,sizeBytes:file.sizeBytes,sourceText}};
}
/**
 * A second, manually prepared version of the same package manifest may add
 * exactly ONE audio asset. The unchanged text SHA-256 anchors the existing
 * imported draft. The new audio file is checked twice, including while being
 * written to Folio's 0600 private quarantine. No auto-generation or TTS.
 */
export async function prepareVerifiedAudioAttachment(manifestPath,durationMs){
  if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>86_400_000){
    throw new Error('Explicit prepared audio durationMs required (1..86400000)');
  }
  const result=await validatePackage(manifestPath);
  const raw=await readFile(resolve(manifestPath));
  if(createHash('sha256').update(raw).digest('hex')!==result.manifestSha256){
    throw new Error('Prepared audio manifest changed after validation');
  }
  const manifest=validateManifestShape(JSON.parse(raw.toString('utf8')));
  const text=manifest.files.filter(file=>file.kind==='text');
  const audio=manifest.files.filter(file=>file.kind==='audio');
  if(text.length!==1||audio.length!==1||manifest.files.length!==2){
    throw new Error('Attach requires one original text and one prepared audio asset');
  }
  const file=audio[0];
  const mime=file.path.endsWith('.ogg')?'audio/ogg':
    file.path.endsWith('.m4a')?'audio/mp4':null;
  if(!mime)throw new Error('Prepared audio must be .ogg or .m4a');
  return {
    prepared:{packageId:manifest.packageId,title:manifest.book.title,
      language:manifest.book.language,editionLabel:manifest.book.editionLabel,
      textSha256:text[0].sha256,audio:{sha256:file.sha256,
        sizeBytes:file.sizeBytes,mime,durationMs}},
    audioPath:resolve(dirname(manifestPath),file.path),
  };
}
function folioTestDatabaseUrl(){
  const raw=process.env.DATABASE_URL;
  if(!raw)throw new Error('Explicit isolated Folio DATABASE_URL required');
  const url=new URL(raw);
  if(url.protocol!=='postgresql:'&&url.protocol!=='postgres:'){
    throw new Error('Only PostgreSQL Folio development URLs are allowed');
  }
  if(!['127.0.0.1','localhost'].includes(url.hostname)||
    url.port!==(process.env.FOLIO_DB_PORT??'55432')||
    !['/folio_test','/folio_lab'].includes(url.pathname)){
    throw new Error('folioctl may connect only to the isolated Folio loopback database');
  }
  return raw;
}
async function main(){
  const [command,path,...extra]=process.argv.slice(2);
  if(!['validate','dry-run','apply','attach-audio'].includes(command)||!path||
     (command==='attach-audio'?extra.length!==1:extra.length!==0)){
    throw new Error('Usage: pnpm folioctl {validate|dry-run|apply} <manifest.json> OR attach-audio <manifest.json> <durationMs>');
  }
  if(command==='validate'){
    const result=await validatePackage(path);
    console.log('folioctl validated '+result.packageId+
      ' version '+result.schemaVersion+' files '+result.fileCount+
      ' bytes '+result.verifiedBytes+' manifest SHA-256 '+result.manifestSha256);
    return;
  }
  const audioJob=command==='attach-audio'
    ?await prepareVerifiedAudioAttachment(path,Number(extra[0]))
    :null;
  const input=audioJob?null:await prepareVerifiedSingleBook(path);
  const url=folioTestDatabaseUrl();
  // This entry point runs from tools/, without assuming a root workspace package
  // symlink. The @folio/db build must exist (CI and the documented workflow).
  const {createFolioDb,previewVerifiedSingleBookImport,applyVerifiedSingleBookImport,
    attachVerifiedPreparedAudio}=
    await import('../packages/db/dist/index.js');
  const {db,pool}=createFolioDb(url);
  try {
    if(command==='attach-audio'&&audioJob){
      const bearer=process.env.FOLIO_ADMIN_BEARER;
      const root=process.env.FOLIO_PRIVATE_STORAGE_ROOT;
      if(!bearer||!root){
        throw new Error('Audio attach requires active MFA FOLIO_ADMIN_BEARER and FOLIO_PRIVATE_STORAGE_ROOT');
      }
      const handle=await open(audioJob.audioPath,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const stat=await handle.stat();
        if(!stat.isFile()||stat.size!==audioJob.prepared.audio.sizeBytes){
          throw new Error('Prepared audio source changed after validation');
        }
        const linked=await attachVerifiedPreparedAudio(db,bearer,
          audioJob.prepared,root,handle.createReadStream({autoClose:false}));
        process.stdout.write(JSON.stringify(linked)+String.fromCharCode(10));
      }finally{await handle.close();}
      return;
    }
    if(command==='dry-run'){
      const report=await previewVerifiedSingleBookImport(db,input);
      process.stdout.write(JSON.stringify(report) + String.fromCharCode(10));
      return;
    }
    const bearer=process.env.FOLIO_ADMIN_BEARER;
    const root=process.env.FOLIO_PRIVATE_STORAGE_ROOT;
    if(!bearer||!root){
      throw new Error('Apply requires FOLIO_ADMIN_BEARER (active MFA admin) and FOLIO_PRIVATE_STORAGE_ROOT');
    }
    const applied=await applyVerifiedSingleBookImport(db,bearer,input,root);
    process.stdout.write(JSON.stringify(applied) + String.fromCharCode(10));
  }finally{
    await pool.end();
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{
    console.error('folioctl: '+(error instanceof Error?error.message:'Validation failed'));
    process.exitCode=1;
  });
}
