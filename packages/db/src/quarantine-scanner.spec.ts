import {createHash} from 'node:crypto';
import {chmod,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {describe,expect,it} from 'vitest';
import {ClamAvStdinScanner,PRIVATE_CLAMAV_ARGS,PRIVATE_CLAMAV_MAX_BYTES} from './quarantine-scanner.js';
import type {QuarantineByteScanner,QuarantineScanVerdict} from './quarantine-scanner.js';
import {LocalStorageAdapter} from './local-storage.js';
import type {QuarantinedBlob} from './local-storage.js';

const owner='51b6e3c6-448e-4416-a486-e471b2909f3a';
const bytes=Buffer.from('Synthetic private quarantine data, never published.\n','utf8');
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');

const stubCode=[
  "const mode=process.argv[1];",
  "if(mode==='early'){process.stdout.write('stdin: OK\\n');process.exit(0);}",
  "let total=0;",
  "process.stdin.on('data',b=>{total+=b.length;});",
  "process.stdin.on('end',()=>{",
  "  if(mode==='hang'){setInterval(()=>{},1000);return;}",
  "  if(mode==='warning'){process.stderr.write('signature database stale\\n');process.stdout.write('stdin: OK\\n');process.exit(0);}",
  "  if(mode==='large-output'){process.stdout.write('x'.repeat(5000));process.exit(0);}",
  "  if(mode==='found'){process.stdout.write('stdin: Synthetic.Test FOUND\\n');process.exit(1);}",
  "  if(mode==='unexpected'){process.stdout.write('stdin: FOUND\\n');process.exit(0);}",
  "  if(mode==='engine-error'){process.stderr.write('ERROR\\n');process.exit(2);}",
  "  if(mode==='clean'){process.stdout.write('stdin: OK\\n');process.exit(0);}",
  "  process.exit(3);",
  "});",
].join('\n');
const stub=(mode:string,timeout=2000)=>
  new ClamAvStdinScanner(process.execPath,['-e',stubCode,mode],timeout);

async function withBlob(run:(blob:QuarantinedBlob,adapter:LocalStorageAdapter,root:string)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'folio-scan-synthetic-'));
  try{
    const storage=await LocalStorageAdapter.create(root);
    const blob=await storage.stage({
      owner:{scope:'private-user',ownerUserId:owner},
      source:Readable.from([bytes]),declaredSha256:hash(bytes),
      declaredMime:'text/plain',maxBytes:1024,
    });
    await run(blob,storage,root);
  }finally{await rm(root,{recursive:true,force:true});}
}

describe('internal ClamAV stdin-only quarantine scanning',()=>{
  it('sets fail-closed signature age, decompression size/time and archive limits',()=>{
    expect(PRIVATE_CLAMAV_ARGS).toContain('--fail-if-cvd-older-than=3');
    expect(PRIVATE_CLAMAV_ARGS).toContain('--alert-exceeds-max=yes');
    expect(PRIVATE_CLAMAV_ARGS).toContain('--alert-encrypted=yes');
    expect(PRIVATE_CLAMAV_ARGS).toContain('-');
    expect(PRIVATE_CLAMAV_ARGS).not.toContain('--remove');
    expect(PRIVATE_CLAMAV_MAX_BYTES).toBe(16*1024*1024);
  });

  it('streams exact bytes to an isolated subprocess; remains pending_verify even on clean',async()=>{
    await withBlob(async(blob,storage)=>{
      const outcome=await storage.scanQuarantined(blob,stub('clean'));
      expect(outcome).toEqual({
        verdict:'clean',sha256:hash(bytes),sizeBytes:bytes.length,status:'pending_verify',
      });
      expect(await storage.inspectQuarantined(blob)).toEqual({sha256:hash(bytes),sizeBytes:bytes.length});
    });
  });

  it('reports infection without making any DB/publication state change',async()=>{
    await withBlob(async(blob,storage)=>{
      const result=await storage.scanQuarantined(blob,stub('found'));
      expect(result.verdict).toBe('infected');
      expect(result.status).toBe('pending_verify');
      expect(await storage.inspectQuarantined(blob)).toMatchObject({sizeBytes:bytes.length});
    });
  });

  it.each(['warning','large-output','unexpected','engine-error','hang'])(
    'fails closed on synthetic ClamAV process mode %s',async mode=>{
      await withBlob(async(blob,storage)=>{
        await expect(storage.scanQuarantined(blob,stub(mode,mode==='hang'?150:2000)))
          .rejects.toThrow();
        expect(await storage.inspectQuarantined(blob)).toMatchObject({sizeBytes:bytes.length});
      });
    },
  );

  it('fails closed when executable/signature engine cannot start',async()=>{
    await withBlob(async(blob,storage)=>{
      const absent=new ClamAvStdinScanner('/not-installed/folio-clamscan',[],200);
      await expect(storage.scanQuarantined(blob,absent)).rejects.toThrow();
      expect(await storage.inspectQuarantined(blob)).toMatchObject({sizeBytes:bytes.length});
    });
  });

  it('rejects scanners that return clean without reading the whole byte stream',async()=>{
    await withBlob(async(blob,storage)=>{
      const liar:QuarantineByteScanner={scan:async _source=>'clean'};
      await expect(storage.scanQuarantined(blob,liar))
        .rejects.toThrow(/digest or length mismatched/);
      const wrong={scan:async source=>{
        for await(const _ of source){/* consume bytes */ }
        return 'verified' as QuarantineScanVerdict;
      }};
      await expect(storage.scanQuarantined(blob,wrong)).rejects.toThrow(/verdict/);
    });
  });

  it('refuses forged owner/key/hash, switched symlink and writable-by-group inode',async()=>{
    await withBlob(async(blob,storage,root)=>{
      const file=join(root,'quarantine','users',owner,blob.key+'.blob');
      const scanner=stub('clean');
      await expect(storage.scanQuarantined({...blob,ownerUserId:'52b6e3c6-448e-4416-a486-e471b2909f3a'},scanner))
        .rejects.toThrow();
      await expect(storage.scanQuarantined({...blob,key:'../escape'},scanner))
        .rejects.toThrow();
      await expect(storage.scanQuarantined({...blob,sha256:'a'.repeat(64)},scanner))
        .rejects.toThrow(/digest or length mismatched/);
      await chmod(file,0o640);
      await expect(storage.scanQuarantined(blob,scanner))
        .rejects.toThrow(/unsafe/i);
      await chmod(file,0o600);
      const orphan=join(root,'quarantine','users',owner,'other.blob');
      await writeFile(orphan,bytes);
      await rm(file);
      await symlink(orphan,file);
      await expect(storage.scanQuarantined(blob,scanner))
        .rejects.toThrow();
    });
  });

  it('rejects files mutated during the scanner byte stream and >16 MiB scan admission',async()=>{
    await withBlob(async(blob,storage,root)=>{
      await expect(storage.scanQuarantined({...blob,sizeBytes:PRIVATE_CLAMAV_MAX_BYTES+1},stub('clean')))
        .rejects.toThrow(/size cap/);
      const file=join(root,'quarantine','users',owner,blob.key+'.blob');
      const mutate:QuarantineByteScanner={
        async scan(source){
          for await(const _chunk of source){await writeFile(file,Buffer.from(bytes));}
          return 'clean';
        },
      };
      await expect(storage.scanQuarantined(blob,mutate))
        .rejects.toThrow(/inode changed/);
    });
  });
});
