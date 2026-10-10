import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {resolve} from 'node:path';
import tar from 'tar-stream';
import {MAX_FILE_BYTES,MAX_PACKAGE_BYTES,MAX_ITEMS,META_LIMIT,manifestSchema,safeRelPath} from './manifest.mjs';
import {indexedFileKind,createJsonlScanner,validateSemanticPackage} from './semantics.mjs';

const MAX_TAR_ENTRIES=MAX_ITEMS*4+100;
const MAX_ARCHIVE_BYTES=MAX_PACKAGE_BYTES;
const MAX_INFLATED_BYTES=MAX_PACKAGE_BYTES+MAX_TAR_ENTRIES*1024+64*1024;
const METADATA_FILES=['authors','works','editions','revisions','rights'].map(name=>`metadata/${name}.ndjson`);

function archivePath(name,type){
  if(typeof name!=='string')throw new Error('Invalid tar path');
  if((name==='.'||name==='./')&&type==='directory')return null;
  const cleaned=name.startsWith('./')?name.slice(2):name;
  const stripped=type==='directory'&&cleaned.endsWith('/')?cleaned.slice(0,-1):cleaned;
  return safeRelPath(stripped);
}
function lowerBound(max,requested){
  if(requested===undefined)return max;
  if(!Number.isSafeInteger(requested)||requested<1||requested>max)throw new Error('Test limit must be a positive, tighter bound');
  return requested;
}
function validateArchiveRecords(records,dirs){
  const manifestRecord=records.get('manifest.json');
  if(!manifestRecord?.data)throw new Error('Missing manifest.json in compressed archive');
  const manifest=manifestSchema.parse(JSON.parse(manifestRecord.data.toString('utf8')));
  const index=new Map(manifest.files.map(file=>[file.path,file]));
  const files=[...records.values()].filter(file=>!['manifest.json','sha256sums.txt'].includes(file.path));
  if(files.length!==index.size)throw new Error('Archive contains missing/unindexed entries');
  for(const file of files){
    const expected=index.get(file.path);
    if(!expected)throw new Error(`Unindexed file: ${file.path}`);
    if(expected.size_bytes!==file.size||expected.sha256!==file.sha256)throw new Error(`Archive SHA-256/size mismatch: ${file.path}`);
    const kind=indexedFileKind(file.path);
    if(!kind||kind!==expected.kind)throw new Error(`Unsupported file path/kind: ${file.path}`);
  }
  const sums=records.get('sha256sums.txt');
  if(!sums?.data)throw new Error('Missing sha256sums.txt');
  const expectedSums=[manifestRecord,...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(file=>`${file.sha256}  ${file.path}`).join('\n')+'\n';
  if(sums.data.toString('utf8')!==expectedSums)throw new Error('Checksum index differs from archive entries');
  for(const path of dirs){
    if(!files.some(file=>file.path.startsWith(path+'/')))throw new Error(`Directory contains no indexed file: ${path}`);
  }
  const countNames=['authors','works','editions','revisions'];
  for(const name of METADATA_FILES){
    const file=records.get(name);
    if(!file?.data)throw new Error(`Missing indexed metadata: ${name}`);
    const lines=file.data.toString('utf8').split('\n').filter(Boolean);
    const category=name.slice('metadata/'.length,-'.ndjson'.length);
    if(countNames.includes(category)&&lines.length!==manifest.declared_counts[category])throw new Error(`Declared ${category} count mismatch`);
    for(const line of lines){
      const entry=JSON.parse(line);
      if(!entry||typeof entry!=='object'||Array.isArray(entry))throw new Error(`Invalid metadata object: ${name}`);
      if(category==='rights'&&typeof entry.evidence!=='string')throw new Error('Missing manual rights evidence');
    }
  }
  const summaries=new Map(files.filter(file=>file.summary).map(file=>[file.path,file.summary]));
  const semantic=validateSemanticPackage(manifest,path=>records.get(path)?.data??null,summaries);
  return {manifest, count:files.length, totalBytes:files.reduce((sum,file)=>sum+file.size,0),checksums:expectedSums,semantic};
}

/**
 * NEVER extracts anything: no tar path ever reaches filesystem operations.
 * Reject links/devices/duplicate entries, enforce compressed + inflated byte caps,
 * and verify every declared file/checksum before accepting the package.
 */
export async function validatePreparedArchive(input,limits={}){
  if(!input.endsWith('.tar.zst'))throw new Error('Archive must end with .tar.zst');
  const archive=resolve(input);
  const st=lstatSync(archive);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_ARCHIVE_BYTES)throw new Error('Archive must be a bounded regular file');
  const maximumInflated=lowerBound(MAX_INFLATED_BYTES,limits.maxInflatedBytes);
  const maximumFile=lowerBound(MAX_FILE_BYTES,limits.maxFileBytes);
  const maximumEntries=lowerBound(MAX_TAR_ENTRIES,limits.maxEntries);
  const records=new Map(),dirs=new Set();
  let expandedBytes=0,entries=0;
  const rowBudget={rows:0};
  const unpack=tar.extract();
  const child=spawn('zstd',['-d','--stdout','--',archive],{stdio:['ignore','pipe','pipe']});
  let stderr='';
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-1500);});
  const childExit=new Promise((done,reject)=>{
    child.once('error',reject);
    child.once('close',code=>code===0?done():reject(new Error(`zstd decoding failed: ${stderr.slice(-240)}`)));
  });
  const counter=new Transform({transform(chunk,_encoding,callback){
    expandedBytes+=chunk.length;
    if(expandedBytes>maximumInflated)callback(new Error('Archive decompression limit exceeded'));
    else callback(null,chunk);
  }});
  unpack.on('entry',(header,stream,next)=>{
    void (async()=>{
      entries++;
      if(entries>maximumEntries)throw new Error('Too many tar entries');
      const type=header.type;
      if(!['file','directory'].includes(type)||header.linkname)throw new Error(`Forbidden tar entry type: ${type}`);
      const path=archivePath(header.name,type);
      if(type==='directory'){
        if(header.size!==0)throw new Error('Nonempty directory tar entry');
        if(path){if(dirs.has(path)||records.has(path))throw new Error(`Duplicate/colliding directory: ${path}`);dirs.add(path);}
        for await(const chunk of stream){if(chunk.length)throw new Error('Directory contains unexpected data');}
        return;
      }
      if(!path)throw new Error('Tar file with empty path');
      if(records.has(path)||dirs.has(path))throw new Error(`Duplicate/colliding tar file: ${path}`);
      if(!Number.isSafeInteger(header.size)||header.size<0||header.size>maximumFile)throw new Error(`Tar file exceeds size limit: ${path}`);
      if(path.startsWith('metadata/')||path==='manifest.json'||path==='sha256sums.txt'){
        if(header.size>META_LIMIT)throw new Error(`Oversized metadata in tar: ${path}`);
      }
      const bufferData=path.startsWith('metadata/')||path==='manifest.json'||path==='sha256sums.txt';
      const chunks=[];const sha=createHash('sha256');let size=0;
      const kind=indexedFileKind(path);
      const scanner=['text','alignment'].includes(kind)?createJsonlScanner(path,rowBudget):null;
      for await(const chunk of stream){
        size+=chunk.length;
        if(size>maximumFile||size>header.size)throw new Error(`Tar stream overrun for ${path}`);
        sha.update(chunk);
        if(scanner)scanner.push(chunk);
        if(bufferData)chunks.push(chunk);
      }
      if(size!==header.size)throw new Error(`Truncated tar file: ${path}`);
      records.set(path,{path,size,sha256:sha.digest('hex'),data:bufferData?Buffer.concat(chunks):null,summary:scanner?.finish()});
    })().then(()=>next(),error=>next(error));
  });
  try{
    await Promise.all([pipeline(child.stdout,counter,unpack),childExit]);
    return validateArchiveRecords(records,dirs);
  }catch(error){
    child.kill('SIGKILL');
    unpack.destroy(error);
    throw error;
  }
}
