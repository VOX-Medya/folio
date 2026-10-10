import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {rmSync,readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import tar from 'tar-stream';
import {fixture} from './fixtures.mjs';
import {validatePreparedArchive} from './archive.mjs';

const cli=new URL('../bin/folioctl.mjs',import.meta.url).pathname;
const archiveName=()=>join(tmpdir(),`folio-archive-attack-${randomUUID()}.tar.zst`);
async function maliciousArchive(entries){
  const pack=tar.pack();
  const chunks=[];
  const collecting=(async()=>{for await(const chunk of pack)chunks.push(chunk);})();
  for(const entry of entries){
    const data=entry.data??Buffer.alloc(0);
    await new Promise((resolve,reject)=>pack.entry({name:entry.path,type:entry.type??'file',size:data.length,linkname:entry.linkname},data,error=>error?reject(error):resolve()));
  }
  pack.finalize();
  await collecting;
  const packed=Buffer.concat(chunks);
  const compressed=spawnSync('zstd',['-q','-c'],{input:packed,maxBuffer:1024*1024*8});
  if(compressed.status!==0)throw new Error(`Test zstd failed: ${compressed.stderr}`);
  const path=archiveName();
  writeFileSync(path,compressed.stdout);
  return path;
}

async function builtFixture(){
  const {root,manifest}=fixture();
  const archive=archiveName();
  execFileSync(process.execPath,[cli,'pack','build','--input',root,'--out',archive],{encoding:'utf8'});
  return {root,manifest,archive};
}

test('safe archive verifies bitwise reproducible GNU tar.zst without extracting to filesystem',async()=>{
  const {root,manifest,archive}=await builtFixture();
  try{
    const validated=await validatePreparedArchive(archive);
    assert.equal(validated.count,6);
    assert.equal(validated.manifest.package_id,manifest.package_id);
    const result=JSON.parse(execFileSync(process.execPath,[cli,'pack','validate','--input',archive],{encoding:'utf8'}));
    assert.equal(result.valid,true);
    assert.equal(result.package_id,manifest.package_id);
    assert.equal(existsSync(join(root,'sha256sums.txt')),false,'Validating archive should not touch input files');
  }finally{rmSync(root,{recursive:true,force:true});rmSync(archive,{force:true});}
});

test('rejects links, path traversal, absolute names, duplicated records and unsupported special types',async()=>{
  const variants=[
    {label:'symlink',entries:[{path:'escape',type:'symlink',linkname:'/etc/passwd'}],pattern:/Forbidden tar entry type/},
    {label:'hardlink',entries:[{path:'escape',type:'link',linkname:'../../etc/passwd'}],pattern:/Forbidden tar entry type/},
    {label:'absolute',entries:[{path:'/etc/passwd',data:Buffer.from('test')}],pattern:/Unsafe package path/},
    {label:'relative escape',entries:[{path:'../../etc/passwd',data:Buffer.from('test')}],pattern:/Unsafe package path/},
    {label:'duplicate',entries:[{path:'manifest.json',data:Buffer.from('{}')},{path:'manifest.json',data:Buffer.from('{}')}],pattern:/Duplicate\/colliding tar file/},
    {label:'unindexed',entries:[{path:'rogue.txt',data:Buffer.from('test')}],pattern:/Missing manifest.json/},
  ];
  for(const variant of variants){
    const archive=await maliciousArchive(variant.entries);
    try{await assert.rejects(()=>validatePreparedArchive(archive),variant.pattern,variant.label);}
    finally{rmSync(archive,{force:true});}
  }
});

test('rejects compressed decompression bomb, oversized per-file header, oversized archive metadata',async()=>{
  const {root,archive}=await builtFixture();
  try{
    await assert.rejects(()=>validatePreparedArchive(archive,{maxInflatedBytes:1000}),/Archive decompression limit exceeded/);
    await assert.rejects(()=>validatePreparedArchive(archive,{maxFileBytes:32}),/Tar file exceeds size limit/);
  }finally{rmSync(root,{recursive:true,force:true});rmSync(archive,{force:true});}
  const invalid=await maliciousArchive([{path:'manifest.json',data:Buffer.alloc(256*1024,65)}]);
  try{await assert.rejects(()=>validatePreparedArchive(invalid),/Unexpected token|is not valid JSON|position/);}
  finally{rmSync(invalid,{force:true});}
});

test('rejects tampered payload and truncated/invalid zstd archive',async()=>{
  const {root,archive}=await builtFixture();
  const tampered=archiveName();
  try{
    appendFileSync(join(root,'metadata/works.ndjson'),'\nunauthorized');
    const t=spawnSync('tar',['-c','--zstd','-f',tampered,'-C',root,'.'],{encoding:'utf8'});
    assert.equal(t.status,0,t.stderr);
    await assert.rejects(()=>validatePreparedArchive(tampered),/Archive SHA-256\/size mismatch/);
    const raw=readFileSync(archive);
    writeFileSync(archive,raw.subarray(0,Math.floor(raw.length/2)));
    await assert.rejects(()=>validatePreparedArchive(archive));
  }finally{rmSync(root,{recursive:true,force:true});rmSync(archive,{force:true});rmSync(tampered,{force:true});}
});

test('PAX long paths are constrained to manifest, and unexpected directories fail closed',async()=>{
  const longPath=`texts/${'x'.repeat(115)}/blocks.jsonl`;
  const archive=await maliciousArchive([{path:longPath,data:Buffer.from('{}\n')}]);
  try{await assert.rejects(()=>validatePreparedArchive(archive),/Missing manifest.json/);}
  finally{rmSync(archive,{force:true});}
  const dirOnly=await maliciousArchive([{path:'ghost/',type:'directory'}]);
  try{await assert.rejects(()=>validatePreparedArchive(dirOnly),/Missing manifest.json/);}
  finally{rmSync(dirOnly,{force:true});}
});

async function packageEntries(root){
  const {validatePreparedFolder}=await import('./manifest.mjs');
  const checked=await validatePreparedFolder(root);
  const entries=[{path:'manifest.json',data:readFileSync(join(root,'manifest.json'))},
    {path:'sha256sums.txt',data:Buffer.from(checked.checksums)}];
  for(const asset of checked.manifest.files){
    entries.push({path:asset.path,data:readFileSync(join(root,asset.path))});
  }
  return entries;
}

test('fully indexed archive rejects injected unindexed files and checksum index tampering',async()=>{
  const {root}=fixture();
  const entries=await packageEntries(root);
  const unindexed=await maliciousArchive([...entries,{path:'assets/unknown.txt',data:Buffer.from('injected')}]);
  const sumIndex=entries.find(item=>item.path==='sha256sums.txt');
  const tampered=await maliciousArchive(entries.map(item=>item.path==='sha256sums.txt'
    ?{...item,data:Buffer.from('0'.repeat(64)+'  manifest.json\n')}:item));
  const valid=await maliciousArchive(entries);
  try{
    const result=await validatePreparedArchive(valid);
    assert.equal(result.count,6,'A hand-built tar-stream archive must also validate');
    await assert.rejects(()=>validatePreparedArchive(unindexed),/Archive contains missing\/unindexed entries/);
    await assert.rejects(()=>validatePreparedArchive(tampered),/Checksum index differs from archive entries/);
    assert.ok(sumIndex,'Fixture must include checksums');
  }finally{rmSync(root,{recursive:true,force:true});for(const file of [unindexed,tampered,valid])rmSync(file,{force:true});}
});

test('repeated archive roots and output symlinks never replace a caller file',async()=>{
  const {root}=fixture();
  const target=archiveName();
  const link=archiveName();
  try{
    writeFileSync(target,'do not modify');
    const {symlinkSync}=await import('node:fs');
    symlinkSync(target,link);
    const run=spawnSync(process.execPath,[cli,'pack','build','--input',root,'--out',link],{encoding:'utf8'});
    assert.notEqual(run.status,0,'Output symlinks must be rejected');
    assert.equal(readFileSync(target,'utf8'),'do not modify');
  }finally{rmSync(root,{recursive:true,force:true});rmSync(link,{force:true});rmSync(target,{force:true});}
});

test('recalculated archive outer hash cannot conceal invalid inner source text SHA',async()=>{
  const {root,manifest}=fixture();
  const textFile=manifest.files.find(file=>file.kind==='text').path;
  const record=JSON.parse(readFileSync(join(root,textFile),'utf8'));
  record.text_sha256='a'.repeat(64);
  const data=JSON.stringify(record)+'\n';
  writeFileSync(join(root,textFile),data);
  const manifestFile=join(root,'manifest.json');
  const outer=JSON.parse(readFileSync(manifestFile,'utf8'));
  const textEntry=outer.files.find(file=>file.path===textFile);
  const {createHash}=await import('node:crypto');
  textEntry.sha256=createHash('sha256').update(data).digest('hex');
  textEntry.size_bytes=Buffer.byteLength(data);
  writeFileSync(manifestFile,JSON.stringify(outer));
  const entries=[];
  const sumLines=[];
  for(const file of ['manifest.json',...outer.files.map(f=>f.path).sort()]){
    const body=readFileSync(join(root,file));
    entries.push({path:file,data:body});
    sumLines.push(`${createHash('sha256').update(body).digest('hex')}  ${file}`);
  }
  entries.push({path:'sha256sums.txt',data:Buffer.from(sumLines.sort((a,b)=>{
    const pa=a.slice(66),pb=b.slice(66);
    return pa<pb?-1:pa>pb?1:0;
  }).join('\n')+'\n')});
  const archive=await maliciousArchive(entries);
  try{await assert.rejects(()=>validatePreparedArchive(archive),/Source text checksum mismatch/);}
  finally{rmSync(root,{recursive:true,force:true});rmSync(archive,{force:true});}
});
