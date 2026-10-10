import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, rm} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {TextDecoder} from 'node:util';
import {z} from 'zod';

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
function detectMime(mime:CandidateMime,first:Buffer):void {
  if(mime==='application/pdf'&&!first.subarray(0,5).equals(Buffer.from('%PDF-'))){
    throw new Error('PDF magic mismatch');
  }
  if(mime==='application/epub+zip'&&!first.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))){
    throw new Error('EPUB ZIP magic mismatch');
  }
  if(mime==='audio/mp4'&&(first.length<12||first.toString('ascii',4,8)!=='ftyp')){
    throw new Error('MP4 container magic mismatch');
  }
  if(mime==='audio/ogg'&&!first.subarray(0,4).equals(Buffer.from('OggS'))){
    throw new Error('Ogg container magic mismatch');
  }
}

/** Only server-generated, lowercase UUIDs become filenames. */
export class LocalStorageAdapter {
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
    let handle:FileHandle|undefined;
    let complete=false;
    try{
      handle=await open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
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
      complete=true;
      return {...owner,key,status:'pending_verify',sha256:input.declaredSha256,
        sizeBytes:size,mime:input.declaredMime};
    }finally{
      if(handle)await handle.close().catch(()=>{});
      if(!complete)await rm(filename,{force:true}).catch(()=>{});
    }
  }

  /**
   * Internal-only integrity inspection. A trusted DB record supplies owner
   * and expected digest; never expose this method directly to an HTTP client.
   * No public media/read route exists while real auth/RBAC/rights are unfinished.
   */
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
