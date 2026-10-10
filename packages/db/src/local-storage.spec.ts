import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {mkdtemp,rm,readdir,lstat,link,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {LocalStorageAdapter} from './local-storage.js';
import type {AssetOwner,QuarantinedBlob} from './local-storage.js';

const alice='51b6e3c6-448e-4416-a486-e471b2909f3a';
const bob='52b6e3c6-448e-4416-a486-e471b2909f3a';
const privateOwner:AssetOwner={scope:'private-user',ownerUserId:alice};
const catalog:AssetOwner={scope:'catalog',ownerUserId:null};
const digest=(content:Uint8Array)=>createHash('sha256').update(content).digest('hex');
async function withVault(test:(root:string,adapter:LocalStorageAdapter)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'folio-v1-storage-'));
  try{await test(root,await LocalStorageAdapter.create(root));}
  finally{await rm(root,{recursive:true,force:true});}
}
const pdf=Buffer.from('%PDF-1.7\n% synthetic test bytes; no real copyrighted work\n');
const source=(value:Uint8Array)=>Readable.from([value]);

describe('LocalStorageAdapter quarantine: no public reads or publish state',()=>{
  it('stores 0600 bytes privately and rechecks bytes after process restart',async()=>{
    await withVault(async(root,adapter)=>{
      const staged=await adapter.stage({owner:privateOwner,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024});
      expect(staged.status).toBe('pending_verify');
      expect(staged.key).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(staged)).not.toContain(root);
      expect(await adapter.inspectQuarantined(staged)).toEqual({sha256:digest(pdf),sizeBytes:pdf.length});
      const file=join(root,'quarantine','users',alice,staged.key+'.blob');
      expect((await lstat(file)).mode&0o777).toBe(0o600);
      const reloaded=await LocalStorageAdapter.create(root);
      expect(await reloaded.inspectQuarantined(staged)).toEqual({sha256:digest(pdf),sizeBytes:pdf.length});
    });
  });

  it('separates two private owners and catalog scope without cross-owner dedup',async()=>{
    await withVault(async(_root,adapter)=>{
      const aliceBlob=await adapter.stage({owner:privateOwner,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024});
      const bobOwner:AssetOwner={scope:'private-user',ownerUserId:bob};
      const bobBlob=await adapter.stage({owner:bobOwner,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024});
      const catalogBlob=await adapter.stage({owner:catalog,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024});
      expect(new Set([aliceBlob.key,bobBlob.key,catalogBlob.key]).size).toBe(3);
      await expect(adapter.inspectQuarantined({...aliceBlob,ownerUserId:bob}))
        .rejects.toThrow();
      await expect(adapter.inspectQuarantined({...aliceBlob,scope:'catalog',ownerUserId:null}))
        .rejects.toThrow();
      expect(await adapter.inspectQuarantined(bobBlob)).toMatchObject({sha256:digest(pdf)});
      expect(await adapter.inspectQuarantined(catalogBlob)).toMatchObject({sha256:digest(pdf)});
    });
  });

  it('never leaves a partial asset after digest mismatch, MIME spoof or size overrun',async()=>{
    await withVault(async(root,adapter)=>{
      await expect(adapter.stage({owner:catalog,source:source(pdf),
        declaredSha256:'a'.repeat(64),declaredMime:'application/pdf',maxBytes:1024}))
        .rejects.toThrow(/SHA-256 mismatch/);
      await expect(adapter.stage({owner:catalog,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'audio/mp4',maxBytes:1024}))
        .rejects.toThrow(/MP4 container magic/);
      await expect(adapter.stage({owner:catalog,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:8}))
        .rejects.toThrow(/size limit/);
      expect(await readdir(join(root,'quarantine','catalog'))).toEqual([]);
    });
  });

  it('removes interrupted stream and rejects invalid limits and owner identity',async()=>{
    await withVault(async(root,adapter)=>{
      async function* aborted():AsyncGenerator<Uint8Array>{
        yield Buffer.from('%PDF-1.7\n');
        throw new Error('Synthetic upload interrupted');
      }
      await expect(adapter.stage({owner:catalog,source:aborted(),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024}))
        .rejects.toThrow(/interrupted/);
      await expect(adapter.stage({owner:catalog,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:0}))
        .rejects.toThrow(/Invalid private asset byte limit/);
      await expect(adapter.stage({owner:{scope:'private-user',ownerUserId:'../escape'} as AssetOwner,
        source:source(pdf),declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024}))
        .rejects.toThrow();
      expect(await readdir(join(root,'quarantine','catalog'))).toEqual([]);
    });
  });

  it('refuses symlinked private directory, malicious key and hardlinked file inode',async()=>{
    await withVault(async(root,adapter)=>{
      const payload=Buffer.from('exact source text\n','utf8');
      const staged=await adapter.stage({owner:privateOwner,source:source(payload),
        declaredSha256:digest(payload),declaredMime:'text/plain',maxBytes:1024});
      await expect(adapter.inspectQuarantined({...staged,key:'../../etc/passwd'}))
        .rejects.toThrow();
      const file=join(root,'quarantine','users',alice,staged.key+'.blob');
      const hardlink=join(root,'quarantine','users',alice,randomUUID()+'.blob');
      await link(file,hardlink);
      await expect(adapter.inspectQuarantined(staged)).rejects.toThrow(/inode/);
      await rm(hardlink);
      const userFolder=join(root,'quarantine','users',bob);
      const escaped=join(root,'quarantine','users',randomUUID());
      await mkdir(userFolder,{mode:0o700});
      await symlink(userFolder,escaped);
      await expect(adapter.stage({owner:{scope:'private-user',ownerUserId:escaped.split('/').pop()!},
        source:source(payload),declaredSha256:digest(payload),
        declaredMime:'text/plain',maxBytes:1024}))
        .rejects.toThrow(/unsafe/);
    });
  });

  it('rejects invalid UTF-8 text; accepts only quarantine, not verified/playable',async()=>{
    await withVault(async(_root,adapter)=>{
      const bytes=Buffer.from([0xff,0xfe,0x00]);
      await expect(adapter.stage({owner:catalog,source:source(bytes),
        declaredSha256:digest(bytes),declaredMime:'text/plain',maxBytes:1024}))
        .rejects.toThrow();
      const ogg=Buffer.from('OggS\x00\x02not-a-real-opus-stream','latin1');
      const result:QuarantinedBlob=await adapter.stage({owner:catalog,source:source(ogg),
        declaredSha256:digest(ogg),declaredMime:'audio/ogg',maxBytes:1024});
      expect(result.status).toBe('pending_verify');
      // Sniffed container header is not proof of playable codec or duration.
      await expect(adapter.inspectQuarantined({...result,status:'verified' as 'pending_verify'}))
        .rejects.toThrow(/quarantine/);
    });
  });
});
