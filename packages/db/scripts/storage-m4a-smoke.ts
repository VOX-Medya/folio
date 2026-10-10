import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {and,eq} from 'drizzle-orm';
import {createFolioDb,LocalStorageAdapter,reservePrivateUploadQuota,
  commitPrivateQuarantinedUpload,observePrivateQuarantineM4a,schema
} from '../src/index.js';
function check(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
async function deny(label:string,fn:()=>Promise<unknown>){
  let rejected=false;
  try{await fn();}catch{rejected=true;}
  check(rejected,'Unsafe M4A quarantine observation accepted: '+label);
}
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function u32(value:number):Buffer{
  const out=Buffer.alloc(4);out.writeUInt32BE(value);return out;
}
function box(kind:string,body:Buffer):Buffer{
  const header=Buffer.alloc(8);
  header.writeUInt32BE(8+body.length,0);header.write(kind,4,'ascii');
  return Buffer.concat([header,body]);
}
function movie(offset:number):Buffer{
  const mvhd=Buffer.alloc(100);
  mvhd.writeUInt32BE(48000,12);mvhd.writeUInt32BE(960,16);
  const tkhd=Buffer.alloc(84);
  tkhd.writeUInt32BE(7,0);tkhd.writeUInt32BE(1,12);tkhd.writeUInt32BE(960,20);
  const mdhd=Buffer.alloc(24);
  mdhd.writeUInt32BE(48000,12);mdhd.writeUInt32BE(960,16);
  const hdlr=Buffer.alloc(24);hdlr.write('soun',8,'ascii');
  const smhd=Buffer.alloc(8);
  const dref=box('dref',Buffer.concat([
    u32(0),u32(1),box('url ',u32(1)),
  ]));
  const sample=Buffer.alloc(28);
  sample.writeUInt16BE(1,6);sample.writeUInt16BE(1,16);
  sample.writeUInt16BE(16,18);sample.writeUInt32BE(48000*65536,24);
  const stsd=box('stsd',Buffer.concat([
    u32(0),u32(1),
    box('mp4a',Buffer.concat([
      sample,box('esds',Buffer.from([0,0,0,0,3,0])),
    ])),
  ]));
  const stts=Buffer.alloc(16);
  stts.writeUInt32BE(1,4);stts.writeUInt32BE(1,8);stts.writeUInt32BE(960,12);
  const stsc=Buffer.alloc(20);
  stsc.writeUInt32BE(1,4);stsc.writeUInt32BE(1,8);
  stsc.writeUInt32BE(1,12);stsc.writeUInt32BE(1,16);
  const stsz=Buffer.alloc(12);
  stsz.writeUInt32BE(3,4);stsz.writeUInt32BE(1,8);
  const stco=Buffer.alloc(12);
  stco.writeUInt32BE(1,4);stco.writeUInt32BE(offset,8);
  const stbl=box('stbl',Buffer.concat([
    stsd,box('stts',stts),box('stsc',stsc),
    box('stsz',stsz),box('stco',stco),
  ]));
  return box('moov',Buffer.concat([
    box('mvhd',mvhd),box('trak',Buffer.concat([
      box('tkhd',tkhd),box('mdia',Buffer.concat([
        box('mdhd',mdhd),box('hdlr',hdlr),
        box('minf',Buffer.concat([
          box('smhd',smhd),box('dinf',dref),stbl,
        ])),
      ])),
    ])),
  ]));
}
function fixture():Buffer{
  const ftyp=box('ftyp',Buffer.concat([
    Buffer.from('M4A ','ascii'),u32(0),Buffer.from('M4A ','ascii'),
  ]));
  const first=movie(0);
  return Buffer.concat([
    ftyp,movie(ftyp.length+first.length+8),
    box('mdat',Buffer.from([9,8,7])),
  ]);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Folio isolated PostgreSQL URL required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||
    !['localhost','127.0.0.1'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('M4A smoke only uses Folio loopback folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const root=await mkdtemp(join(tmpdir(),'folio-m4a-pg-test-'));
  try{
    const owner=randomUUID(),other=randomUUID();
    const storage=await LocalStorageAdapter.create(root);
    const stage=async(data:Buffer)=>{
      const reservation=await reservePrivateUploadQuota(
        first.db,owner,data.length,32768);
      const blob=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([data]),declaredSha256:sha(data),
        declaredMime:'audio/mp4',maxBytes:data.length,
      });
      return (await commitPrivateQuarantinedUpload(
        first.db,storage,owner,reservation.reservationId,blob)).assetId;
    };
    const audit=async(id:string)=>first.db.select().from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityType,'media_asset'),
        eq(schema.auditEvents.entityId,id),
        eq(schema.auditEvents.action,'storage.quarantine.m4a_observed')));
    const assetId=await stage(fixture());
    await deny('foreign owner',()=>observePrivateQuarantineM4a(
      second.db,storage,other,assetId));
    await deny('unknown ID',()=>observePrivateQuarantineM4a(
      first.db,storage,owner,randomUUID()));
    const result=await observePrivateQuarantineM4a(
      second.db,storage,owner,assetId);
    check(result.assetId===assetId&&result.status==='m4a_box_shape_only'&&
      result.assetStatus==='pending_verify'&&result.sampleCount===1&&
      result.channelCount===1&&result.containerTimelineMs===20&&
      result.mediaBytes===3,
      'Owned M4A structure observation returned unsafe shape');
    const [row]=await first.db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,assetId));
    const events=await audit(assetId);
    const eventJson=JSON.stringify(events[0]?.afterJson);
    check(row?.status==='pending_verify'&&row.verifiedAt===null&&
      row.durationMs===null&&events.length===1&&
      !eventJson.includes(row.storageKey)&&!eventJson.includes(root)&&
      !eventJson.includes('mp4a')&&!eventJson.includes('mdat'),
      'M4A inspection leaked bytes or changed private asset status');

    const fakeFtyp=await stage(box('ftyp',Buffer.concat([
      Buffer.from('M4A '),u32(0),Buffer.from('M4A '),
    ])));
    await deny('staging-only ftyp is not full media',()=>observePrivateQuarantineM4a(
      first.db,storage,owner,fakeFtyp));
    check((await audit(fakeFtyp)).length===0,'Incomplete MP4 was logged as accepted');

    const withdrawn=await stage(fixture());
    const original=storage.inspectM4a.bind(storage);
    storage.inspectM4a=async record=>{
      const inspected=await original(record);
      await second.db.update(schema.mediaAssets).set({status:'rejected'})
        .where(eq(schema.mediaAssets.id,withdrawn));
      return inspected;
    };
    await deny('withdrawn during M4A preflight',
      ()=>observePrivateQuarantineM4a(first.db,storage,owner,withdrawn));
    check((await audit(withdrawn)).length===0,
      'Withdrawn MP4 received a false successful audit');
    console.log('M4A PRIVATE QUARANTINE PASS: real two Folio-only PostgreSQL pools, ftyp/mdat/mp4a sample graph, cross-owner/unknown/truncated denial, in-flight withdrawal, private pending status and counts-only audit.');
  }finally{
    await first.pool.end();await second.pool.end();
    await rm(root,{force:true,recursive:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
