import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {mkdtemp,rm,readdir,lstat,link,symlink,mkdir,chmod,writeFile,utimes} from 'node:fs/promises';
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
/** Deliberately only an OCF first local-file-header fixture, not a full EPUB.
 * No central directory or textual book content is processed or published. */
function ocfHeader():Buffer{
  const header=Buffer.alloc(58);
  header.writeUInt32LE(0x04034b50,0);
  header.writeUInt16LE(20,4); // ZIP version needed
  header.writeUInt32LE(20,18); // stored member size
  header.writeUInt32LE(20,22); // uncompressed member size
  header.writeUInt16LE(8,26); // filename length
  header.write('mimetype',30,'ascii');
  header.write('application/epub+zip',38,'ascii');
  return header;
}


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

  it('fails closed if private file permissions weaken or staged bytes change after hash',async()=>{
    await withVault(async(root,adapter)=>{
      const staged=await adapter.stage({owner:privateOwner,source:source(pdf),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024});
      const file=join(root,'quarantine','users',alice,staged.key+'.blob');
      await chmod(file,0o644);
      await expect(adapter.inspectQuarantined(staged)).rejects.toThrow(/permissions/);
      await chmod(file,0o600);
      expect(await adapter.inspectQuarantined(staged)).toEqual({
        sha256:digest(pdf),sizeBytes:pdf.length,
      });
      const modified=Buffer.from(pdf);
      modified[modified.length-1]=modified[modified.length-1]===33?46:33;
      await writeFile(file,modified);
      await expect(adapter.inspectQuarantined(staged)).rejects.toThrow(/changed after staging/);
    });
  });

  it('requires W3C OCF first ZIP member, not merely PK magic, before quarantining EPUB',async()=>{
    await withVault(async(root,adapter)=>{
      const valid=ocfHeader();
      const accepted=await adapter.stage({
        owner:catalog,
        source:Readable.from([valid.subarray(0,17),valid.subarray(17,41),valid.subarray(41)]),
        declaredSha256:digest(valid),declaredMime:'application/epub+zip',maxBytes:128,
      });
      expect(accepted.status).toBe('pending_verify');
      expect(await adapter.inspectQuarantined(accepted)).toEqual({
        sha256:digest(valid),sizeBytes:valid.length,
      });
      const tampered:Array<[string,Buffer]>=[
        ['arbitrary ZIP bytes',Buffer.from([0x50,0x4b,0x03,0x04,0x6e,0x6f,0x74])],
        ['wrong first entry name',(()=>{const b=ocfHeader();b[30]=0x78;return b;})()],
        ['compressed mimetype',(()=>{const b=ocfHeader();b.writeUInt16LE(8,8);return b;})()],
        ['extra ZIP header',(()=>{const b=ocfHeader();b.writeUInt16LE(1,28);return b;})()],
        ['encrypted ZIP entry',(()=>{const b=ocfHeader();b.writeUInt16LE(1,6);return b;})()],
        ['data descriptor flag',(()=>{const b=ocfHeader();b.writeUInt16LE(8,6);return b;})()],
        ['wrong content size',(()=>{const b=ocfHeader();b.writeUInt32LE(21,22);return b;})()],
        ['unsupported version',(()=>{const b=ocfHeader();b.writeUInt16LE(63,4);return b;})()],
        ['incorrect MIME string',(()=>{const b=ocfHeader();b[38]=0x58;return b;})()],
        ['padded MIME',(()=>{const b=Buffer.concat([ocfHeader(),Buffer.from(' ')]);b.writeUInt32LE(21,18);b.writeUInt32LE(21,22);return b;})()],
      ];
      for(const [label,invalid] of tampered){
        await expect(adapter.stage({
          owner:catalog,source:source(invalid),
          declaredSha256:digest(invalid),declaredMime:'application/epub+zip',maxBytes:128,
        }),label).rejects.toThrow(/EPUB OCF mimetype header mismatch/);
      }
      const entries=await readdir(join(root,'quarantine','catalog'));
      expect(entries).toEqual([accepted.key+'.blob']);
    });
  });

  it('never exposes incomplete bytes under .blob and finishes with a single 0600 inode',async()=>{
    await withVault(async(root,adapter)=>{
      const dir=join(root,'quarantine','users',alice);
      let during:string[]=[];
      async function* paused():AsyncGenerator<Uint8Array>{
        yield pdf.subarray(0,5);
        during=await readdir(dir);
        yield pdf.subarray(5);
      }
      const stored=await adapter.stage({
        owner:privateOwner,source:paused(),
        declaredSha256:digest(pdf),declaredMime:'application/pdf',maxBytes:1024,
      });
      expect(during).toEqual([stored.key+'.part']);
      expect(await readdir(dir)).toEqual([stored.key+'.blob']);
      const state=await lstat(join(dir,stored.key+'.blob'));
      expect(state.nlink).toBe(1);
      expect(state.mode&0o777).toBe(0o600);
      expect(await adapter.inspectQuarantined(stored)).toEqual({
        sha256:digest(pdf),sizeBytes:pdf.length,
      });
    });
  });

  it('never deletes DB-protected/private-other-owner/young/symlink/partial/hardlinked files',async()=>{
    await withVault(async(root,adapter)=>{
      const stage=(owner:AssetOwner)=>adapter.stage({
        owner,source:source(pdf),declaredSha256:digest(pdf),
        declaredMime:'application/pdf',maxBytes:1024,
      });
      const protectedBlob=await stage(privateOwner);
      const orphan=await stage(privateOwner);
      const alteredMode=await stage(privateOwner);
      const linked=await stage(privateOwner);
      const future=await stage(privateOwner);
      const bobBlob=await stage({scope:'private-user',ownerUserId:bob});
      const catalogBlob=await stage(catalog);
      const dir=join(root,'quarantine','users',alice);
      const linkedCopy=join(dir,randomUUID()+'.blob');
      const symbolic=join(dir,randomUUID()+'.blob');
      const partial=join(dir,randomUUID()+'.part');
      const unknown=join(dir,'some-strange-name.blob');
      const oldClock=Date.now();
      const futureClock=oldClock+5*24*60*60*1000;
      await chmod(join(dir,alteredMode.key+'.blob'),0o644);
      await link(join(dir,linked.key+'.blob'),linkedCopy);
      await symlink(join(dir,protectedBlob.key+'.blob'),symbolic);
      await writeFile(partial,Buffer.from('aborted upload'));
      await writeFile(unknown,Buffer.from('not an opaque key'));
      await utimes(join(dir,future.key+'.blob'),new Date(futureClock),new Date(futureClock));

      // Default is reporting only, even if the synthetic clock is far ahead.
      const onlyReport=await adapter.sweepPrivateUserOrphans(alice,
        new Set([protectedBlob.key]),{testNowMs:futureClock});
      expect(onlyReport.dryRun).toBe(true);
      expect(onlyReport.removed).toBe(0);
      expect(onlyReport.eligible).toBe(1);
      expect(onlyReport.referenced).toBe(1);
      expect(onlyReport.skipped).toBeGreaterThanOrEqual(6);
      expect((await readdir(dir))).toContain(orphan.key+'.blob');

      const removed=await adapter.sweepPrivateUserOrphans(alice,
        new Set([protectedBlob.key]),{apply:true,testNowMs:futureClock});
      expect(removed.eligible).toBe(1);
      expect(removed.removed).toBe(1);
      expect(await readdir(dir)).not.toContain(orphan.key+'.blob');
      expect((await readdir(dir))).toContain(protectedBlob.key+'.blob');
      expect((await readdir(dir))).toContain(alteredMode.key+'.blob');
      expect((await readdir(dir))).toContain(linked.key+'.blob');
      expect((await readdir(dir))).toContain(future.key+'.blob');
      expect((await readdir(dir))).toContain(partial.split('/').pop());
      expect(await adapter.inspectQuarantined(protectedBlob)).toEqual({
        sha256:digest(pdf),sizeBytes:pdf.length,
      });
      expect(await adapter.inspectQuarantined(bobBlob)).toMatchObject({sizeBytes:pdf.length});
      expect(await adapter.inspectQuarantined(catalogBlob)).toMatchObject({sizeBytes:pdf.length});
      const repeat=await adapter.sweepPrivateUserOrphans(alice,
        new Set([protectedBlob.key]),{apply:true,testNowMs:futureClock});
      expect(repeat.removed).toBe(0);
      await expect(adapter.sweepPrivateUserOrphans('../bad',new Set(),{apply:true}))
        .rejects.toThrow();
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
