import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {describe,expect,it} from 'vitest';
import {inspectM4aContainer,M4A_PREFLIGHT_MAX_BYTES} from './m4a-structure.js';
import {LocalStorageAdapter} from './local-storage.js';
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function u32(n:number):Buffer{
  const bytes=Buffer.alloc(4);bytes.writeUInt32BE(n);return bytes;
}
function box(type:string,payload:Buffer):Buffer{
  const header=Buffer.alloc(8);
  header.writeUInt32BE(8+payload.length,0);header.write(type,4,'ascii');
  return Buffer.concat([header,payload]);
}
type Options={brand?:string;handler?:string;sampleCount?:number;sizeCount?:number;
  sampleSize?:number;external?:boolean;chunkShift?:number;sampleEntry?:string;
  esdsTag?:number;mediaScale?:number;movieDuration?:number;mediaDuration?:number;
  fragment?:boolean;hidden?:boolean;rate?:number};
function makeMovie(offset:number,o:Options):Buffer{
  const samples=o.sampleCount??1,delta=960,duration=960;
  const mvhd=Buffer.alloc(100);
  mvhd.writeUInt32BE(48000,12);mvhd.writeUInt32BE(o.movieDuration??duration,16);
  const tkhd=Buffer.alloc(84);
  tkhd.writeUInt32BE(7,0);tkhd.writeUInt32BE(1,12);
  tkhd.writeUInt32BE(o.movieDuration??duration,20);
  const mdhd=Buffer.alloc(24);
  mdhd.writeUInt32BE(o.mediaScale??48000,12);
  mdhd.writeUInt32BE(o.mediaDuration??duration,16);
  const hdlr=Buffer.alloc(24);
  hdlr.write(o.handler??'soun',8,'ascii');
  const smhd=Buffer.alloc(8);
  const url=box('url ',u32(o.external?0:1));
  const dref=box('dref',Buffer.concat([u32(0),u32(1),url]));
  const dinf=box('dinf',dref);
  const entry=Buffer.alloc(28);
  entry.writeUInt16BE(1,6);entry.writeUInt16BE(2,16);
  entry.writeUInt16BE(16,18);
  entry.writeUInt32BE((o.rate??48000)*65536,24);
  const esds=box('esds',Buffer.from([0,0,0,0,o.esdsTag??3,0]));
  const mp4a=box(o.sampleEntry??'mp4a',Buffer.concat([entry,esds]));
  const stsd=box('stsd',Buffer.concat([u32(0),u32(1),mp4a]));
  const stts=Buffer.alloc(16);
  stts.writeUInt32BE(1,4);stts.writeUInt32BE(samples,8);
  stts.writeUInt32BE(delta,12);
  const stsc=Buffer.alloc(20);
  stsc.writeUInt32BE(1,4);stsc.writeUInt32BE(1,8);
  stsc.writeUInt32BE(samples,12);stsc.writeUInt32BE(1,16);
  const stsz=Buffer.alloc(12);
  stsz.writeUInt32BE(o.sampleSize??3,4);
  stsz.writeUInt32BE(o.sizeCount??1,8);
  const stco=Buffer.alloc(12);
  stco.writeUInt32BE(1,4);stco.writeUInt32BE(offset+(o.chunkShift??0),8);
  const stbl=box('stbl',Buffer.concat([
    stsd,box('stts',stts),box('stsc',stsc),
    box('stsz',stsz),box('stco',stco),
  ]));
  const minf=box('minf',Buffer.concat([box('smhd',smhd),dinf,stbl]));
  const mdia=box('mdia',Buffer.concat([
    box('mdhd',mdhd),box('hdlr',hdlr),minf,
  ]));
  const trak=box('trak',Buffer.concat([box('tkhd',tkhd),mdia]));
  return box('moov',Buffer.concat([
    box('mvhd',mvhd),trak,...(o.hidden?[box('udta',Buffer.alloc(0))]:[]),
  ]));
}
function fixture(o:Options={}):Buffer{
  const ftyp=box('ftyp',Buffer.concat([
    Buffer.from(o.brand??'M4A ','ascii'),u32(0),
    Buffer.from('M4A ','ascii'),
  ]));
  const media=box('mdat',Buffer.from([9,8,7]));
  const first=makeMovie(0,o);
  const movie=makeMovie(ftyp.length+first.length+8,o);
  return Buffer.concat([
    ftyp,movie,media,...(o.fragment?[box('moof',Buffer.alloc(0))]:[]),
  ]);
}
const deny=(bytes:Buffer)=>expect(()=>inspectM4aContainer(bytes))
  .toThrow(/Unsupported M4A/);
describe('M4A single-track private box-shape preflight, never AAC decode',()=>{
  it('accepts only tight self-contained one-track review evidence',()=>{
    const result=inspectM4aContainer(fixture());
    expect(result).toMatchObject({
      status:'m4a_box_shape_only',sampleCount:1,channelCount:2,
      mediaBytes:3,containerTimelineMs:20,
    });
    expect(result.boxCount).toBeGreaterThan(18);
    expect(JSON.stringify(result)).not.toMatch(/mp4a|esds|ftyp|source|verified|playable/i);
  });

  it('rejects spoofed ftyp-only, truncation, extra atoms and extended-size tricks',()=>{
    const bytes=fixture(),bad=Buffer.from(bytes);
    bad.writeUInt32BE(1,0);
    for(const input of [
      box('ftyp',Buffer.concat([Buffer.from('M4A '),u32(0),Buffer.from('M4A ')])),
      bytes.subarray(0,-1),Buffer.concat([bytes,Buffer.alloc(1)]),
      bad,fixture({fragment:true}),fixture({hidden:true}),
      Buffer.alloc(M4A_PREFLIGHT_MAX_BYTES+1),
    ])deny(input);
  });

  it('rejects sound track and sample table relationship confusion',()=>{
    for(const options of [
      {brand:'isom'},
      {handler:'vide'},
      {sampleCount:2},
      {sizeCount:2},
      {sampleSize:0},
      {chunkShift:1},
      {external:true},
      {sampleEntry:'enca'},
      {esdsTag:4},
      {mediaScale:44100},
      {movieDuration:1200},
      {mediaDuration:1200},
      {rate:22050},
    ])deny(fixture(options));
  });

  it('does not confuse random matching-size bytes with verified AAC frames',()=>{
    const shape=inspectM4aContainer(fixture());
    expect(shape.status).toBe('m4a_box_shape_only');
    expect('decodedAudio' in shape).toBe(false);
    expect('verifiedDurationMs' in shape).toBe(false);
    expect('safeToStream' in shape).toBe(false);
  });

  it('requires a private owner-matched O_NOFOLLOW SHA/size pending asset',async()=>{
    const root=await mkdtemp(join(tmpdir(),'folio-m4a-shape-'));
    try{
      const owner=randomUUID(),bytes=fixture();
      const storage=await LocalStorageAdapter.create(root);
      const staged=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([bytes]),declaredSha256:sha(bytes),
        declaredMime:'audio/mp4',maxBytes:bytes.length,
      });
      expect((await storage.inspectM4a(staged)).containerTimelineMs).toBe(20);
      await expect(storage.inspectM4a({...staged,ownerUserId:randomUUID()}))
        .rejects.toThrow();
      await expect(storage.inspectM4a({...staged,sha256:'f'.repeat(64)}))
        .rejects.toThrow(/source bytes changed/);
      await expect(storage.inspectM4a({...staged,mime:'audio/ogg'}))
        .rejects.toThrow(/audio\/mp4/);
      await expect(storage.inspectM4a({...staged,status:'verified' as 'pending_verify'}))
        .rejects.toThrow(/pending/);
    }finally{await rm(root,{force:true,recursive:true});}
  });
});
