import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validatePackage,prepareVerifiedSingleBook,prepareVerifiedAudioAttachment} from '../folioctl.mjs';

const fixture=resolve(dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/folioctl/single-book');
const manifestPath=join(fixture,'manifest.json');

async function isolatedCopy(run){
  const temp=await mkdtemp(join(tmpdir(),'folioctl-test-'));
  try{
    const meta=JSON.parse(await readFile(manifestPath,'utf8'));
    const input=join(temp,'manifest.json');
    await mkdir(join(temp,'content'),{recursive:true});
    return await run({temp,meta,input,save:async()=>writeFile(input,JSON.stringify(meta))});
  }finally{
    await rm(temp,{recursive:true,force:true});
  }
}

test('valid synthetic package is verified without DB mutation',async()=>{
  const result=await validatePackage(manifestPath);
  assert.equal(result.packageId,'11111111-1111-4111-8111-111111111118');
  assert.equal(result.schemaVersion,'1.0.0');
  assert.equal(result.fileCount,1);
  assert.equal(result.verifiedBytes,3);
  assert.match(result.manifestSha256,/^[a-f0-9]{64}$/);
});

test('same size altered bytes are rejected by SHA-256',()=>isolatedCopy(async x=>{
  await x.save();
  await writeFile(join(x.temp,'content/source.txt'),'abd');
  await assert.rejects(validatePackage(x.input),/SHA-256 mismatch/);
}));

test('declared but missing source is rejected',()=>isolatedCopy(async x=>{
  await x.save();
  await assert.rejects(validatePackage(x.input),/ENOENT/);
}));

test('bad claimed SHA, unsafe path and unsupported manifest version reject',()=>isolatedCopy(async x=>{
  await writeFile(join(x.temp,'content/source.txt'),'abc');
  x.meta.files[0].sha256='0'.repeat(64);
  await x.save();
  await assert.rejects(validatePackage(x.input),/SHA-256 mismatch/);
  x.meta.files[0].sha256='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  x.meta.files[0].path='../other.txt';
  await x.save();
  await assert.rejects(validatePackage(x.input),/safe package-relative/);
  x.meta.files[0].path='content/source.txt';
  x.meta.schemaVersion='2.0.0';
  await x.save();
  await assert.rejects(validatePackage(x.input),/Unsupported manifest version/);
}));

test('symbolic link package asset cannot escape private package root',()=>isolatedCopy(async x=>{
  await x.save();
  await symlink(join(fixture,'content/source.txt'),join(x.temp,'content/source.txt'));
  await assert.rejects(validatePackage(x.input),/Symbolic links are forbidden/);
}));

test('validated text becomes the exact source text for one draft block',async()=>{
  const input=await prepareVerifiedSingleBook(manifestPath);
  assert.equal(input.source.sourceText,'abc');
  assert.equal(input.source.sha256,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('manifest cannot claim approved rights or private-user ownership',()=>isolatedCopy(async x=>{
  await writeFile(join(x.temp,'content/source.txt'),'abc');
  x.meta.book.rights={reviewStatus:'approved'};
  await x.save();
  await assert.rejects(validatePackage(x.input),/Disallowed book field/);
  delete x.meta.book.rights;
  x.meta.files[0].ownerUserId='33333333-3333-4333-8333-333333333333';
  await x.save();
  await assert.rejects(validatePackage(x.input),/Disallowed asset field/);
}));

test('prepared voice manifest is linked to original text digest without rights claims',()=>isolatedCopy(async x=>{
  await writeFile(join(x.temp,'content/source.txt'),'abc');
  const audio=Buffer.from('OggS synthetic source for attach','utf8');
  await writeFile(join(x.temp,'content/audio.ogg'),audio);
  x.meta.files.push({path:'content/audio.ogg',kind:'audio',
    sha256:createHash('sha256').update(audio).digest('hex'),
    sizeBytes:audio.length});
  await x.save();
  const result=await prepareVerifiedAudioAttachment(x.input,8000);
  assert.equal(result.prepared.packageId,x.meta.packageId);
  assert.equal(result.prepared.textSha256,x.meta.files[0].sha256);
  assert.equal(result.prepared.audio.mime,'audio/ogg');
  assert.equal(result.prepared.audio.durationMs,8000);
  await assert.rejects(prepareVerifiedAudioAttachment(x.input,0),/durationMs/);
  await assert.rejects(prepareVerifiedSingleBook(x.input),/one text asset/);
  await writeFile(join(x.temp,'content/audio.ogg'),Buffer.from('XggS synthetic source for attach'));
  await assert.rejects(prepareVerifiedAudioAttachment(x.input,8000),/SHA-256 mismatch/);
}));
