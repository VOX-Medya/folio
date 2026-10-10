import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, mkdir, open, opendir, rm, unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {TextDecoder} from 'node:util';
import {z} from 'zod';
import {PRIVATE_CLAMAV_MAX_BYTES} from './quarantine-scanner.js';
import type {QuarantineByteScanner,QuarantineScanVerdict} from './quarantine-scanner.js';
import {EPUB_ZIP_PREFLIGHT_MAX_BYTES,inspectEpubZipStructure,inspectEpubZipPackageSpine,inspectEpubZipXhtmlMarkup,inspectEpubZipCssResources,inspectEpubZipPngResources} from './epub-structure.js';
import type {EpubXhtmlMarkupResult} from './epub-xhtml.js';
import type {EpubCssResourceResult} from './epub-css.js';
import type {EpubPngResourcesResult} from './epub-png.js';
import {inspectOggOpusContainer,OGG_OPUS_PREFLIGHT_MAX_BYTES} from './ogg-opus.js';
import type {OggOpusContainerResult} from './ogg-opus.js';
import {inspectM4aContainer,M4A_PREFLIGHT_MAX_BYTES} from './m4a-structure.js';
import type {M4aContainerResult} from './m4a-structure.js';
import type {EpubPackageSpineResult} from './epub-package.js';
import type {EpubZipStructuralResult} from './epub-structure.js';

/**
 * V1 local, private, QUARANTINE-ONLY storage boundary.
 * This is not an authenticated HTTP endpoint, malware scanner, audio validator,
 * or publication gate. Catalog rights and user sessions must be checked elsewhere.
 */
const uuid=z.uuid();
const ownerSchema=z.discriminatedUnion('scope', [
  z.object({scope:z.literal('catalog'),ownerUserId:z.null()}),
  z.object({scope:z.literal('private-user'),ownerUserId:uuid}),
]);
export type AssetOwner=z.infer<typeof ownerSchema>;

export const LOCAL_STORAGE_MAX_BYTES=1024*1024*1024;
/** Stale, unreferenced completed quarantine files are held for >=72 hours. */
export const PRIVATE_ORPHAN_GRACE_MS=72*60*60*1000;
const PRIVATE_ORPHAN_SWEEP_MAX_ENTRIES=512;
export type CandidateMime='text/plain'|'application/pdf'|'application/epub+zip'|'audio/mp4'|'audio/ogg';
export type QuarantinedBlob = AssetOwner & {
  key:string;
  status:'pending_verify';
  sha256:string;
  sizeBytes:number;
  mime:CandidateMime;
};
export interface StagePrivateBlob {
  owner:AssetOwner;
  source:AsyncIterable<Uint8Array>;
  declaredSha256:string;
  declaredMime:CandidateMime;
  maxBytes:number;
}

/** V1 byte quarantine port, deliberately WITHOUT reads, promotion or URLs.
 * A later S3 provider must satisfy the same owner/hash/status invariants,
 * but no remote provider implementation or network access exists in V1. */
export interface StorageAdapter {
  stage(input:StagePrivateBlob):Promise<QuarantinedBlob>;
  inspectQuarantined(record:QuarantinedBlob):Promise<{sha256:string;sizeBytes:number}>;
  inspectEpubStructure(record:QuarantinedBlob):Promise<EpubZipStructuralResult>;
  inspectEpubPackageSpine(record:QuarantinedBlob):Promise<EpubPackageSpineResult>;
  inspectEpubXhtmlMarkup(record:QuarantinedBlob):Promise<EpubXhtmlMarkupResult>;
  inspectEpubCssResources(record:QuarantinedBlob):Promise<EpubCssResourceResult>;
  inspectEpubPngResources(record:QuarantinedBlob):Promise<EpubPngResourcesResult>;
  inspectOggOpus(record:QuarantinedBlob):Promise<OggOpusContainerResult>;
  inspectM4a(record:QuarantinedBlob):Promise<M4aContainerResult>;
}

function requireSha256(value:string):void {
  if(!/^[a-f0-9]{64}$/.test(value))throw new Error('Invalid SHA-256 declaration');
}
function requireBlobKey(value:string):void {
  uuid.parse(value);
}
function ensureLimit(value:number):void {
  if(!Number.isSafeInteger(value)||value<1||value>LOCAL_STORAGE_MAX_BYTES){
    throw new Error('Invalid private asset byte limit');
  }
}
/**
 * OCF media-type admission ONLY, not EPUB validation. The W3C-mandated
 * first ZIP member must be the uncompressed, unencrypted "mimetype" entry
 * without an extra field and with exact ASCII "application/epub+zip" bytes.
 * ZIP directory/traversal/bomb safety, DRM and reliable reading order remain
 * mandatory downstream gates; this method NEVER marks a blob verified.
 */
function hasEpubOcfMimetypeHeader(first:Buffer):boolean {
  if(first.length<58||
    !first.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04])))return false;
  const version=first.readUInt16LE(4),flags=first.readUInt16LE(6);
  return [10,20,45].includes(version)&&
    (flags&(0x1|0x8|0x40|0x2000))===0&&
    first.readUInt16LE(8)===0&&
    first.readUInt32LE(18)===20&&
    first.readUInt32LE(22)===20&&
    first.readUInt16LE(26)===8&&
    first.readUInt16LE(28)===0&&
    first.subarray(30,38).equals(Buffer.from('mimetype','ascii'))&&
    first.subarray(38,58).equals(Buffer.from('application/epub+zip','ascii'));
}
function detectMime(mime:CandidateMime,first:Buffer):void {
  if(mime==='application/pdf'&&!first.subarray(0,5).equals(Buffer.from('%PDF-'))){
    throw new Error('PDF magic mismatch');
  }
  if(mime==='application/epub+zip'&&!hasEpubOcfMimetypeHeader(first)){
    throw new Error('EPUB OCF mimetype header mismatch');
  }
  if(mime==='audio/mp4'&&(first.length<12||first.toString('ascii',4,8)!=='ftyp')){
    throw new Error('MP4 container magic mismatch');
  }
  if(mime==='audio/ogg'&&!first.subarray(0,4).equals(Buffer.from('OggS'))){
    throw new Error('Ogg container magic mismatch');
  }
}

/** Only server-generated, lowercase UUIDs become filenames. */
export class LocalStorageAdapter implements StorageAdapter {
  private constructor(private readonly root:string){}

  static async create(root:string):Promise<LocalStorageAdapter>{
    if(!isAbsolute(root))throw new Error('Private storage root must be absolute');
    const storage=new LocalStorageAdapter(root);
    await storage.ensurePrivateDirectories([]);
    return storage;
  }

  /** Refuse symlinked/writable-by-others parents inside the Folio-only vault. */
  private async ensurePrivateDirectories(segments:string[]):Promise<string>{
    let current=this.root;
    const all=[current];
    for(const segment of segments){
      current=join(current,segment);
      all.push(current);
    }
    for(const dir of all){
      try {await mkdir(dir,{mode:0o700});}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      }
      const state=await lstat(dir);
      if(!state.isDirectory()||state.isSymbolicLink()||(state.mode&0o077)!==0){
        throw new Error('Private storage directory is unsafe');
      }
    }
    return current;
  }

  private ownerSegments(owner:AssetOwner):string[]{
    const checked=ownerSchema.parse(owner);
    return checked.scope==='catalog'
      ?['quarantine','catalog']
      :['quarantine','users',checked.ownerUserId];
  }

  /**
   * Stream untrusted bytes to a random, non-public, exclusive 0600 file.
   * Hash the real bytes; abort and delete partial uploads on errors.
   * Container sniffing is NOT full EPUB/PDF sanitization or audio codec/duration
   * verification, so the result is always pending_verify.
   */
  async stage(input:StagePrivateBlob):Promise<QuarantinedBlob>{
    const owner=ownerSchema.parse(input.owner);
    requireSha256(input.declaredSha256);
    ensureLimit(input.maxBytes);
    const allowed:CandidateMime[]=['text/plain','application/pdf','application/epub+zip','audio/mp4','audio/ogg'];
    if(!allowed.includes(input.declaredMime))throw new Error('Unsupported private asset media type');
    const dir=await this.ensurePrivateDirectories(this.ownerSegments(owner));
    const key=randomUUID();
    const filename=join(dir,key+'.blob');
    // Bytes under construction NEVER have a .blob name. Only a fully
    // hashed, fsynced candidate is atomically linked into that namespace.
    const partial=join(dir,key+'.part');
    let handle:FileHandle|undefined;
    let complete=false,linked=false;
    try{
      handle=await open(partial,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      const sha=createHash('sha256');
      const textDecoder=input.declaredMime==='text/plain'?new TextDecoder('utf-8',{fatal:true}):null;
      let size=0;
      let first=Buffer.alloc(0);
      for await(const originalChunk of input.source){
        if(!(originalChunk instanceof Uint8Array))throw new Error('Invalid streaming chunk');
        const chunk=Buffer.from(originalChunk);
        if(chunk.length===0)continue;
        size+=chunk.length;
        if(size>input.maxBytes||size>LOCAL_STORAGE_MAX_BYTES)throw new Error('Private asset size limit exceeded');
        sha.update(chunk);
        if(first.length<64)first=Buffer.concat([first,chunk.subarray(0,64-first.length)]);
        if(textDecoder&&textDecoder.decode(chunk,{stream:true}).includes('\0')){
          throw new Error('NUL in source text');
        }
        let offset=0;
        while(offset<chunk.length){
          const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset);
          if(!bytesWritten)throw new Error('Private storage short write');
          offset+=bytesWritten;
        }
      }
      if(size===0)throw new Error('Empty asset not allowed');
      if(textDecoder&&textDecoder.decode().includes('\0'))throw new Error('NUL in source text');
      detectMime(input.declaredMime,first);
      if(sha.digest('hex')!==input.declaredSha256)throw new Error('Private asset SHA-256 mismatch');
      await handle.sync();
      await handle.close();
      handle=undefined;
      // Hard-link creation is atomic and fails if an unexpected final key
      // already exists; unlike rename(), it never overwrites that file.
      await link(partial,filename);
      linked=true;
      await unlink(partial);
      const directoryHandle=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{await directoryHandle.sync();}
      finally{await directoryHandle.close();}
      complete=true;
      return {...owner,key,status:'pending_verify',sha256:input.declaredSha256,
        sizeBytes:size,mime:input.declaredMime};
    }finally{
      if(handle)await handle.close().catch(()=>{});
      if(!complete&&linked)await rm(filename,{force:true}).catch(()=>{});
      if(!complete)await rm(partial,{force:true}).catch(()=>{});
    }
  }

  /**
   * Internal-only integrity inspection. A trusted DB record supplies owner
   * and expected digest; never expose this method directly to an HTTP client.
   * No public media/read route exists while real auth/RBAC/rights are unfinished.
   */
  /**
   * INTERNAL ONLY. The caller MUST hold the same PostgreSQL owner advisory
   * transaction lock as quota reserve/commit, and provide ALL media_assets
   * storage keys for this private owner (including deleted/rejected rows).
   * No HTTP, cron or operator command can invoke this as an unguarded delete.
   *
   * Only final .blob files with a generated UUID and an untouched safe inode
   * older than the grace interval are eligible. Stale .part files, foreign
   * names, hardlinks, symlinks, missing paths and active uploads remain intact.
   * testNowMs is exclusively for synthetic clock-advance test fixtures.
   */
  async sweepPrivateUserOrphans(
    trustedOwnerId:string,
    referencedKeys:ReadonlySet<string>,
    options:{apply?:boolean;testNowMs?:number}={},
  ):Promise<{scanned:number;referenced:number;eligible:number;removed:number;
    skipped:number;truncated:boolean;dryRun:boolean}>{
    const ownerId=uuid.parse(trustedOwnerId);
    for(const key of referencedKeys)requireBlobKey(key);
    const now=options.testNowMs??Date.now();
    if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid private orphan sweep clock');
    const cutoff=now-PRIVATE_ORPHAN_GRACE_MS;
    const dir=await this.ensurePrivateDirectories(['quarantine','users',ownerId]);
    const results={scanned:0,referenced:0,eligible:0,removed:0,skipped:0,
      truncated:false,dryRun:options.apply!==true};
    for await(const entry of await opendir(dir)){
      if(results.scanned>=PRIVATE_ORPHAN_SWEEP_MAX_ENTRIES){
        results.truncated=true;
        break;
      }
      results.scanned++;
      if(!entry.isFile()||!entry.name.endsWith('.blob')){
        results.skipped++;
        continue;
      }
      const key=entry.name.slice(0,-5);
      if(!uuid.safeParse(key).success||entry.name!==key+'.blob'){
        results.skipped++;
        continue;
      }
      if(referencedKeys.has(key)){
        results.referenced++;
        continue;
      }
      const path=join(dir,entry.name);
      // Refuse special files, hard links and changed POSIX ownership/mode.
      // O_NOFOLLOW prevents replacement by a final-component symlink.
      let handle:FileHandle|undefined;
      try{
        handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const state=await handle.stat();
        if(!state.isFile()||state.nlink!==1||state.size<1||
          state.size>LOCAL_STORAGE_MAX_BYTES||
          (state.mode&0o777)!==0o600||
          (typeof process.getuid==='function'&&state.uid!==process.getuid())||
          Math.max(state.birthtimeMs,state.ctimeMs,state.mtimeMs)>cutoff){
          results.skipped++;
          continue;
        }
        const pathState=await lstat(path);
        if(!pathState.isFile()||pathState.isSymbolicLink()||
          pathState.ino!==state.ino||pathState.dev!==state.dev||
          pathState.nlink!==1||(pathState.mode&0o777)!==0o600||
          Math.max(pathState.birthtimeMs,pathState.ctimeMs,pathState.mtimeMs)>cutoff){
          results.skipped++;
          continue;
        }
        results.eligible++;
        if(options.apply===true){
          await unlink(path);
          results.removed++;
        }
      }catch(error){
        if((error as NodeJS.ErrnoException).code==='ENOENT'||
          (error as NodeJS.ErrnoException).code==='ELOOP'){
          results.skipped++;
          continue;
        }
        // Permission failures and unexpected I/O abort instead of deleting
        // anything else. Earlier successful removals are idempotent.
        throw error;
      }finally{
        if(handle)await handle.close();
      }
    }
    return results;
  }

  /**
   * INTERNAL structure-only EPUB ZIP preflight; no extracted bytes or URLs.
   * 16 MiB cap bounds file buffering and uncompressed ZIP processing. The
   * trusted persisted owner/key/hash identify an O_NOFOLLOW 0600 inode.
   * A valid ZIP skeleton is NEVER proof of safe XHTML, reliable chapter/spine
   * order, complete EPUB semantics, clean malware, license or publication.
   */
  /**
   * Shared quarantine-only EPUB reader for ZIP and OPF checks. Exact owner,
   * private inode, size and SHA must match the persisted metadata supplied by
   * trusted callers. No output exposes bytes/path to an HTTP response.
   */
  private async readTrustedEpubBytes(record:QuarantinedBlob):Promise<Buffer>{
    const owner=ownerSchema.parse(record);
    requireBlobKey(record.key);
    requireSha256(record.sha256);
    ensureLimit(record.sizeBytes);
    if(record.status!=='pending_verify'||record.mime!=='application/epub+zip'){
      throw new Error('EPUB preflight requires quarantined EPUB metadata');
    }
    if(record.sizeBytes>EPUB_ZIP_PREFLIGHT_MAX_BYTES){
      throw new Error('EPUB preflight size cap exceeded');
    }
    const dir=await this.ensurePrivateDirectories(this.ownerSegments(owner));
    const filename=join(dir,record.key+'.blob');
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const before=await handle.stat();
      const safe=(s:typeof before)=>s.isFile()&&s.nlink===1&&
        s.size===record.sizeBytes&&(s.mode&0o777)===0o600&&
        (typeof process.getuid!=='function'||s.uid===process.getuid());
      if(!safe(before))throw new Error('Unsafe quarantined EPUB inode or permissions');
      const bytes=await handle.readFile();
      if(bytes.length!==record.sizeBytes||
        createHash('sha256').update(bytes).digest('hex')!==record.sha256){
        throw new Error('Quarantined EPUB source bytes changed');
      }
      const after=await handle.stat(),pathState=await lstat(filename);
      if(!safe(after)||!pathState.isFile()||pathState.isSymbolicLink()||
        after.ino!==before.ino||after.dev!==before.dev||
        after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||
        pathState.ino!==before.ino||pathState.dev!==before.dev||
        pathState.mtimeMs!==before.mtimeMs||pathState.ctimeMs!==before.ctimeMs){
        throw new Error('Quarantined EPUB inode changed during preflight');
      }
      return bytes;
    }finally{await handle.close();}
  }

  /** ZIP structure-only. No semantic acceptance or status transition. */
  async inspectEpubStructure(record:QuarantinedBlob):Promise<EpubZipStructuralResult>{
    return inspectEpubZipStructure(await this.readTrustedEpubBytes(record));
  }

  /** Package/spine relationship-only. No XHTML reading-order extraction,
   * DOM rendering, malware proof, rights decision or verified status. */
  async inspectEpubPackageSpine(record:QuarantinedBlob):Promise<EpubPackageSpineResult>{
    return inspectEpubZipPackageSpine(await this.readTrustedEpubBytes(record));
  }

  /** Safe XHTML *shape* observation only. It neither returns original source
   * text nor allows a renderer, download route or verified transition. */
  async inspectEpubXhtmlMarkup(record:QuarantinedBlob):Promise<EpubXhtmlMarkupResult>{
    return inspectEpubZipXhtmlMarkup(await this.readTrustedEpubBytes(record));
  }

  /** Internal stylesheet lexical-subset observation, NOT a CSS sanitizer.
   * Reuses the owner-bound O_NOFOLLOW digest/inode quarantine checks. */
  async inspectEpubCssResources(record:QuarantinedBlob):Promise<EpubCssResourceResult>{
    return inspectEpubZipCssResources(await this.readTrustedEpubBytes(record));
  }

  /** Fifth quarantine-only, PNG-structure observation. Fonts and all
   * other binary resource formats are explicitly rejected, not ignored. */
  async inspectEpubPngResources(record:QuarantinedBlob):Promise<EpubPngResourcesResult>{
    return inspectEpubZipPngResources(await this.readTrustedEpubBytes(record));
  }

  /**
   * Internal Ogg Opus page/CRC/header-only quarantine observation. It must
   * never expose bytes, create a playable stream, or verify duration.
   */
  async inspectOggOpus(record:QuarantinedBlob):Promise<OggOpusContainerResult>{
    const owner=ownerSchema.parse(record);
    requireBlobKey(record.key);
    requireSha256(record.sha256);
    ensureLimit(record.sizeBytes);
    if(record.status!=='pending_verify'||record.mime!=='audio/ogg'){
      throw new Error('Ogg Opus preflight requires pending private audio/ogg');
    }
    if(record.sizeBytes>OGG_OPUS_PREFLIGHT_MAX_BYTES){
      throw new Error('Ogg Opus preflight size cap exceeded');
    }
    const dir=await this.ensurePrivateDirectories(this.ownerSegments(owner));
    const filename=join(dir,record.key+'.blob');
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const before=await handle.stat();
      const safe=(s:typeof before)=>s.isFile()&&s.nlink===1&&
        s.size===record.sizeBytes&&(s.mode&0o777)===0o600&&
        (typeof process.getuid!=='function'||s.uid===process.getuid());
      if(!safe(before))throw new Error('Unsafe quarantined Ogg inode or permissions');
      const bytes=await handle.readFile();
      if(bytes.length!==record.sizeBytes||
        createHash('sha256').update(bytes).digest('hex')!==record.sha256){
        throw new Error('Quarantined Ogg source bytes changed');
      }
      const after=await handle.stat(),pathState=await lstat(filename);
      if(!safe(after)||!pathState.isFile()||pathState.isSymbolicLink()||
        after.ino!==before.ino||after.dev!==before.dev||
        after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||
        pathState.ino!==before.ino||pathState.dev!==before.dev||
        pathState.mtimeMs!==before.mtimeMs||pathState.ctimeMs!==before.ctimeMs){
        throw new Error('Quarantined Ogg inode changed during preflight');
      }
      return inspectOggOpusContainer(bytes);
    }finally{await handle.close();}
  }

  /** Internal MP4 box-shape observation only; not an AAC/MP4 decoder or
   * verified duration or a media streaming route. */
  async inspectM4a(record:QuarantinedBlob):Promise<M4aContainerResult>{
    const owner=ownerSchema.parse(record);
    requireBlobKey(record.key);
    requireSha256(record.sha256);
    ensureLimit(record.sizeBytes);
    if(record.status!=='pending_verify'||record.mime!=='audio/mp4'){
      throw new Error('M4A preflight requires pending private audio/mp4');
    }
    if(record.sizeBytes>M4A_PREFLIGHT_MAX_BYTES){
      throw new Error('M4A preflight size cap exceeded');
    }
    const dir=await this.ensurePrivateDirectories(this.ownerSegments(owner));
    const filename=join(dir,record.key+'.blob');
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const before=await handle.stat();
      const safe=(s:typeof before)=>s.isFile()&&s.nlink===1&&
        s.size===record.sizeBytes&&(s.mode&0o777)===0o600&&
        (typeof process.getuid!=='function'||s.uid===process.getuid());
      if(!safe(before))throw new Error('Unsafe quarantined M4A inode or permissions');
      const bytes=await handle.readFile();
      if(bytes.length!==record.sizeBytes||
        createHash('sha256').update(bytes).digest('hex')!==record.sha256){
        throw new Error('Quarantined M4A source bytes changed');
      }
      const after=await handle.stat(),pathState=await lstat(filename);
      if(!safe(after)||!pathState.isFile()||pathState.isSymbolicLink()||
        after.ino!==before.ino||after.dev!==before.dev||
        after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||
        pathState.ino!==before.ino||pathState.dev!==before.dev||
        pathState.mtimeMs!==before.mtimeMs||pathState.ctimeMs!==before.ctimeMs){
        throw new Error('Quarantined M4A inode changed during preflight');
      }
      return inspectM4aContainer(bytes);
    }finally{await handle.close();}
  }

  /**
   * INTERNAL byte-bound malware inspection, not file verification/promotion.
   * A trusted, previously persisted metadata row must supply owner/key/hash.
   * The scanner receives an AsyncIterable of bytes from an O_NOFOLLOW file
   * descriptor, NEVER a disk pathname. SHA and size are checked on the exact
   * bytes delivered to the scanner; file metadata/inode is rechecked after.
   * Any AV unavailability, truncated stream, concurrent mutation, symlink,
   * permission, digest or size error fails closed. No DB write or URL.
   */
  async scanQuarantined(
    record:QuarantinedBlob,scanner:QuarantineByteScanner,
  ):Promise<{verdict:QuarantineScanVerdict;sha256:string;sizeBytes:number;
    status:'pending_verify'}>{
    const owner=ownerSchema.parse(record);
    requireBlobKey(record.key);
    requireSha256(record.sha256);
    ensureLimit(record.sizeBytes);
    if(record.status!=='pending_verify')throw new Error('Only quarantine scans are allowed');
    if(record.sizeBytes>PRIVATE_CLAMAV_MAX_BYTES){
      throw new Error('Private malware scan size cap exceeded');
    }
    const dir=await this.ensurePrivateDirectories(this.ownerSegments(owner));
    const filename=join(dir,record.key+'.blob');
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const before=await handle.stat();
      const safe=(s:typeof before)=>s.isFile()&&s.nlink===1&&
        s.size===record.sizeBytes&&(s.mode&0o777)===0o600&&
        (typeof process.getuid!=='function'||s.uid===process.getuid());
      if(!safe(before))throw new Error('Unsafe private quarantine inode or permissions');
      const sha=createHash('sha256');
      let size=0;
      const source=async function*():AsyncGenerator<Uint8Array>{
        for await(const chunk of handle.createReadStream({autoClose:false})){
          size+=chunk.length;
          if(size>record.sizeBytes||size>PRIVATE_CLAMAV_MAX_BYTES){
            throw new Error('Quarantine bytes changed during malware scan');
          }
          sha.update(chunk);
          yield chunk;
        }
      };
      const verdict=await scanner.scan(source());
      if(verdict!=='clean'&&verdict!=='infected'){
        throw new Error('Invalid private malware scanner verdict');
      }
      if(size!==record.sizeBytes||sha.digest('hex')!==record.sha256){
        throw new Error('Quarantine digest or length mismatched during malware scan');
      }
      const after=await handle.stat(),pathState=await lstat(filename);
      if(!safe(after)||!pathState.isFile()||pathState.isSymbolicLink()||
        after.ino!==before.ino||after.dev!==before.dev||
        after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||
        pathState.ino!==before.ino||pathState.dev!==before.dev||
        pathState.mtimeMs!==before.mtimeMs||pathState.ctimeMs!==before.ctimeMs){
        throw new Error('Private quarantine inode changed during malware scan');
      }
      return {verdict,sha256:record.sha256,sizeBytes:size,status:'pending_verify'};
    }finally{await handle.close();}
  }

  async inspectQuarantined(record:QuarantinedBlob):Promise<{sha256:string;sizeBytes:number}>{
    const owner=ownerSchema.parse(record);
    requireBlobKey(record.key);
    requireSha256(record.sha256);
    ensureLimit(record.sizeBytes);
    if(record.status!=='pending_verify')throw new Error('Only quarantine inspection is available');
    const dir=await this.ensurePrivateDirectories(this.ownerSegments(owner));
    const filename=join(dir,record.key+'.blob');
    const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const state=await handle.stat();
      if(!state.isFile()||state.nlink!==1||state.size!==record.sizeBytes||
        (state.mode&0o777)!==0o600||
        (typeof process.getuid==='function'&&state.uid!==process.getuid())){
        throw new Error('Unsafe private asset inode, ownership, permissions or size');
      }
      const sha=createHash('sha256');
      let count=0;
      for await(const chunk of handle.createReadStream({autoClose:false})){
        count+=chunk.length;
        if(count>record.sizeBytes)throw new Error('Unexpected extra asset bytes');
        sha.update(chunk);
      }
      const actual=sha.digest('hex');
      if(actual!==record.sha256||count!==record.sizeBytes)throw new Error('Private asset changed after staging');
      return {sha256:actual,sizeBytes:count};
    }finally{await handle.close();}
  }
}
