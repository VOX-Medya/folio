import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {rmSync,symlinkSync,appendFileSync,readFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {manifestSchema,validatePreparedFolder,safeRelPath} from './manifest.mjs';

import {fixture} from './fixtures.mjs';

const cli=new URL('../bin/folioctl.mjs',import.meta.url).pathname;

test('validated prepared folder has checksum for every indexed source and rights evidence',async()=>{
  const {root,manifest}=fixture();
  try{
    const result=await validatePreparedFolder(root);
    assert.equal(result.count,6);
    assert.equal(result.manifest.package_id,manifest.package_id);
    assert.equal(result.checksums.trim().split('\n').length,7);
    const cliResult=JSON.parse(execFileSync(process.execPath,[cli,'pack','validate','--input',root],{encoding:'utf8'}));
    assert.equal(cliResult.valid,true);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('rejects unexpected path, traversal, symlink, digest tampering, stale count and unsupported schema',async()=>{
  const {root}=fixture();
  try{
    for(const path of ['../secrets','.hidden','/etc/passwd','metadata//works.ndjson','x/../y','x\\y'])assert.throws(()=>safeRelPath(path),/Unsafe package path/);
    appendFileSync(join(root,'metadata/works.ndjson'),'tampered');
    await assert.rejects(()=>validatePreparedFolder(root),/Size mismatch/);
    const {root:other}=fixture();
    try{
      symlinkSync('/etc/hosts',join(other,'unexpected-link'));
      await assert.rejects(()=>validatePreparedFolder(other),/Symlinks and special files forbidden/);
    }finally{rmSync(other,{recursive:true,force:true});}
    const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
    manifest.schema_version='2.0.0';
    assert.equal(manifestSchema.safeParse(manifest).success,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('tar.zst output is reproducible, checksum indexed, and no export feature is pretended to exist',async()=>{
  const {root}=fixture();
  const output1=join(dirname(root),'folio-repro-'+randomUUID()+'.tar.zst');
  const output2=join(dirname(root),'folio-repro-'+randomUUID()+'.tar.zst');
  try{
    execFileSync(process.execPath,[cli,'pack','build','--input',root,'--out',output1],{encoding:'utf8'});
    execFileSync(process.execPath,[cli,'pack','build','--input',root,'--out',output2],{encoding:'utf8'});
    const a=createHash('sha256').update(readFileSync(output1)).digest('hex');
    const b=createHash('sha256').update(readFileSync(output2)).digest('hex');
    assert.equal(a,b,'Same source package should have the same tar.zst bytes');
    const listed=execFileSync('tar',['--zstd','-tf',output1],{encoding:'utf8'});
    assert.match(listed,/sha256sums.txt/);
    assert.match(listed,/manifest.json/);
    assert.match(listed,/metadata\/rights.ndjson/);
    const repeat=spawnSync(process.execPath,[cli,'pack','build','--input',root,'--out',output1],{encoding:'utf8'});
    assert.notEqual(repeat.status,0,'Existing archive must never be overwritten');
    const disabled=spawnSync(process.execPath,[cli,'export','--scope','licensed-library'],{encoding:'utf8'});
    assert.notEqual(disabled.status,0,'Rights-aware backend export is not implemented');
  }finally{rmSync(root,{recursive:true,force:true});for(const f of [output1,output2])if(existsSync(f))rmSync(f);}
});
