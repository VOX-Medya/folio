import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {LocalStorageAdapter} from '../src/local-storage.js';
import {ClamAvStdinScanner,PRIVATE_CLAMAV_ARGS} from '../src/quarantine-scanner.js';

function check(ok:unknown,message:string):asserts ok{
  if(!ok)throw new Error(message);
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

/**
 * Runs a REAL ClamAV executable on an ephemeral Ubuntu CI runner, with a
 * synthetic hash-only signature database. This is strictly a process-adapter
 * integration test, NOT verification of official malware definitions,
 * signature freshness, virus detection coverage, nor publishing eligibility.
 * No user content, external volume, key or real threat material is used.
 */
async function main():Promise<void>{
  if(process.env.CI!=='true'||process.env.FOLIO_CLAMAV_TEST_MODE!=='synthetic-only'){
    throw new Error('Native ClamAV fixture runs only in explicitly opted-in synthetic CI');
  }
  const root=await mkdtemp(join(tmpdir(),'folio-clamav-native-'));
  try{
    const payload=Buffer.from('Folio CI synthetic scanned file with no active signature.\n','utf8');
    const flagged=Buffer.from('Folio CI harmless sentinel for test-only hash signature.\n','utf8');
    const md5=createHash('md5').update(flagged).digest('hex');
    const dbFile=join(root,'synthetic-test.hdb');
    await writeFile(dbFile,md5+':'+flagged.length+':FolioSynthetic.TestSentinel\n',{mode:0o600});
    // The ephemeral test database has no official .cvd freshness timestamp.
    // Only this explicit local smoke omits the signature-age switch; the
    // production defaults require recent official definitions.
    const args=[
      ...PRIVATE_CLAMAV_ARGS.slice(0,-1).filter(a=>a!=='--fail-if-cvd-older-than=3'),
      '--database='+dbFile,'-',
    ];
    const scanner=new ClamAvStdinScanner('/usr/bin/clamscan',args,90_000);
    const storage=await LocalStorageAdapter.create(join(root,'vault'));
    const owner={scope:'private-user' as const,ownerUserId:randomUUID()};
    const stage=(bytes:Buffer)=>storage.stage({
      owner,source:Readable.from([bytes]),
      declaredSha256:sha(bytes),declaredMime:'text/plain' as const,maxBytes:1024,
    });
    const clean=await stage(payload);
    const cleanResult=await storage.scanQuarantined(clean,scanner);
    check(cleanResult.verdict==='clean'&&cleanResult.status==='pending_verify',
      'Native clamscan incorrectly rejected clean synthetic data');
    const flaggedAsset=await stage(flagged);
    const flaggedResult=await storage.scanQuarantined(flaggedAsset,scanner);
    check(flaggedResult.verdict==='infected'&&flaggedResult.status==='pending_verify',
      'Native clamscan missed synthetic hash signature');
    check((await storage.inspectQuarantined(clean)).sizeBytes===payload.length,
      'Scanner changed clean bytes');
    check((await storage.inspectQuarantined(flaggedAsset)).sizeBytes===flagged.length,
      'Scanner changed flagged bytes');
    console.log('Native ClamAV stdin PASS: installed ClamAV engine + local synthetic hash-only signature, exact byte stream, clean/infected protocol, SHA integrity, both remain pending_verify. Official signatures and production freshness NOT tested.');
  }finally{await rm(root,{recursive:true,force:true});}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
