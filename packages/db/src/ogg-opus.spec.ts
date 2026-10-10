import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {describe,expect,it} from 'vitest';
import {inspectOggOpusContainer,OGG_OPUS_PREFLIGHT_MAX_BYTES} from './ogg-opus.js';
import {LocalStorageAdapter} from './local-storage.js';

const vendor=Buffer.from('synthetic-folio-fixture','ascii');
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

/** A small, independent bit-by-bit Ogg CRC32 fixture writer. */
function crc(bytes:Buffer):number{
  let sum=0;
  for(let i=0;i<bytes.length;i++){
    const v=i>=22&&i<26?0:bytes[i]!;
    sum^=v<<24;
    for(let bit=0;bit<8;bit++)sum=(sum&0x80000000)?
      (sum<<1)^0x04c11db7:sum<<1;
  }
  return sum>>>0;
}
function oggPage(packet:Buffer,sequence:number,flags:number,
  granule:bigint,serial=0x3ac11a4):Buffer{
  const segments:number[]=[];
  for(let rest=packet.length;rest>=255;rest-=255)segments.push(255);
  const remainder=packet.length%255;
  segments.push(remainder);
  if(segments.length>255)throw new Error('Synthetic packet too large');
  const page=Buffer.alloc(27+segments.length+packet.length);
  page.write('OggS',0,'ascii');
  page[4]=0;page[5]=flags;page.writeBigUInt64LE(granule,6);
  page.writeUInt32LE(serial,14);page.writeUInt32LE(sequence,18);
  page[26]=segments.length;
  segments.forEach((length,i)=>{page[27+i]=length});
  packet.copy(page,27+segments.length);
  page.writeUInt32LE(crc(page),22);
  return page;
}
function opusHead(patch:(b:Buffer)=>void=()=>{}):Buffer{
  const data=Buffer.alloc(19);
  data.write('OpusHead',0,'ascii');
  data[8]=1;data[9]=2;data.writeUInt16LE(312,10);
  data.writeUInt32LE(48000,12);
  patch(data);
  return data;
}
function opusTags(patch:(b:Buffer)=>void=()=>{}):Buffer{
  const data=Buffer.alloc(16+vendor.length);
  data.write('OpusTags',0,'ascii');data.writeUInt32LE(vendor.length,8);
  vendor.copy(data,12);data.writeUInt32LE(0,12+vendor.length);
  patch(data);return data;
}
function fixture({
  head=opusHead(),tags=opusTags(),
  audio=Buffer.from([0xf8,0xff,0xfe]),
  flags=[2,0,4],serials=[123,123,123],
  sequences=[0,1,2],granules=[0n,0n,1272n],
}:{head?:Buffer;tags?:Buffer;audio?:Buffer;flags?:number[];
  serials?:number[];sequences?:number[];granules?:bigint[]}={}):Buffer{
  return Buffer.concat([head,tags,audio].map((packet,i)=>oggPage(
    packet,sequences[i]!,flags[i]!,granules[i]!,serials[i]!,
  )));
}
function reject(bytes:Buffer):void{
  expect(()=>inspectOggOpusContainer(bytes)).toThrow(/Unsupported Ogg Opus/);
}

describe('Ogg Opus structural quarantine-only preflight',()=>{
  it('checks exact three-page CRC Opus chain and returns only aggregate review data',()=>{
    const bytes=fixture();
    const result=inspectOggOpusContainer(bytes);
    expect(result).toEqual({
      status:'ogg_opus_container_only',pageCount:3,audioPacketCount:1,
      channelCount:2,granuleTimelineMs:20,
    });
    expect(JSON.stringify(result)).not.toMatch(/synthetic-folio|OpusHead|OpusTags|123|decoded|verified|playback/);
  });

  it('rejects magic, version, CRC damage, truncated pages, appendages and extra streams',()=>{
    const source=fixture();
    const badMagic=Buffer.from(source);badMagic.write('OOPS',0,'ascii');
    const badVersion=Buffer.from(source);badVersion[4]=1;
    const badCrc=Buffer.from(source);badCrc[badCrc.length-1]!^=1;
    for(const input of [
      badMagic,badVersion,badCrc,source.subarray(0,50),
      source.subarray(0,source.length-1),
      Buffer.concat([source,Buffer.from([0,0,0,0])]),
      Buffer.concat([source,source]),
      Buffer.alloc(OGG_OPUS_PREFLIGHT_MAX_BYTES+1,0),
    ])reject(input);
  });

  it('rejects page continuation, missing BOS/EOS, mismatched serial or sequence',()=>{
    for(const config of [
      {flags:[0,0,4]},
      {flags:[2,0,0]},
      {flags:[2,2,4]},
      {flags:[2,1,4]},
      {flags:[2,0,5]},
      {serials:[123,124,123]},
      {sequences:[0,3,4]},
      {sequences:[1,2,3]},
    ])reject(fixture(config));
  });

  it('rejects invalid OpusHead fields even with valid page checksums',()=>{
    const changes=[
      (b:Buffer)=>{b[8]=2},
      (b:Buffer)=>{b[9]=0},
      (b:Buffer)=>{b[9]=3},
      (b:Buffer)=>b.writeUInt32LE(44100,12),
      (b:Buffer)=>{b[18]=1},
      (b:Buffer)=>b.writeInt16LE(-5,16),
      (b:Buffer)=>b.writeUInt16LE(4000,10),
      (b:Buffer)=>b.write('FakeHead',0,'ascii'),
    ];
    for(const patch of changes)reject(fixture({head:opusHead(patch)}));
    reject(fixture({head:Buffer.concat([opusHead(),Buffer.alloc(1)])}));
  });

  it('rejects malformed OpusTags, hidden comments and oversized header/vendor',()=>{
    const changes=[
      (b:Buffer)=>b.writeUInt32LE(100000,8),
      (b:Buffer)=>b.writeUInt32LE(1,12+vendor.length),
      (b:Buffer)=>b.write('BadTags!',0,'ascii'),
    ];
    for(const patch of changes)reject(fixture({tags:opusTags(patch)}));
    reject(fixture({tags:Buffer.concat([opusTags(),Buffer.from([0])])}));
  });

  it('rejects duration/packet forgeries instead of claiming decoded audio',()=>{
    for(const conf of [
      {granules:[0n,0n,300n]},
      {granules:[0n,0n,312n]},
      {granules:[0n,1n,1272n]},
      {granules:[0n,0n,48_000n*60n*60n*13n]},
      {audio:Buffer.alloc(0)},
      {audio:Buffer.from([0])},
      {audio:opusHead()},
    ])reject(fixture(conf));
  });

  it('refuses owner, SHA, MIME or status mismatches at the private inode',async()=>{
    const root=await mkdtemp(join(tmpdir(),'folio-ogg-preflight-'));
    try{
      const owner=randomUUID();
      const storage=await LocalStorageAdapter.create(root);
      const payload=fixture();
      const staged=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([payload]),declaredSha256:sha(payload),
        declaredMime:'audio/ogg',maxBytes:payload.length,
      });
      expect((await storage.inspectOggOpus(staged)).granuleTimelineMs).toBe(20);
      await expect(storage.inspectOggOpus({...staged,ownerUserId:randomUUID()}))
        .rejects.toThrow();
      await expect(storage.inspectOggOpus({...staged,sha256:'f'.repeat(64)}))
        .rejects.toThrow(/source bytes changed/);
      await expect(storage.inspectOggOpus({...staged,mime:'audio/mp4'}))
        .rejects.toThrow(/audio\/ogg/);
      await expect(storage.inspectOggOpus({...staged,status:'verified' as 'pending_verify'}))
        .rejects.toThrow(/pending/);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
