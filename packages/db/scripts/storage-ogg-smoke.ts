import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {and,eq} from 'drizzle-orm';
import {createFolioDb,LocalStorageAdapter,reservePrivateUploadQuota,
  commitPrivateQuarantinedUpload,observePrivateQuarantineOggOpus,schema
} from '../src/index.js';
function check(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
async function deny(name:string,p:()=>Promise<unknown>){
  let rejected=false;
  try{await p();}catch{rejected=true;}
  check(rejected,'Unsafe Ogg Opus observation accepted: '+name);
}
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function crc(bytes:Buffer):number{
  let sum=0;
  for(let i=0;i<bytes.length;i++){
    const v=i>=22&&i<26?0:bytes[i]!;
    sum^=v<<24;
    for(let b=0;b<8;b++)sum=(sum&0x80000000)?(sum<<1)^0x04c11db7:sum<<1;
  }
  return sum>>>0;
}
function page(packet:Buffer,sequence:number,flags:number,granule:bigint):Buffer{
  const segments:number[]=[];
  let remaining=packet.length;
  while(remaining>=255){segments.push(255);remaining-=255;}
  segments.push(remaining);
  const out=Buffer.alloc(27+segments.length+packet.length);
  out.write('OggS',0,'ascii');out[5]=flags;out.writeBigUInt64LE(granule,6);
  out.writeUInt32LE(77,14);out.writeUInt32LE(sequence,18);
  out[26]=segments.length;
  segments.forEach((segment,i)=>{out[27+i]=segment});
  packet.copy(out,27+segments.length);
  out.writeUInt32LE(crc(out),22);
  return out;
}
function fixture():Buffer{
  const head=Buffer.alloc(19);
  head.write('OpusHead',0,'ascii');head[8]=1;head[9]=1;
  head.writeUInt16LE(312,10);head.writeUInt32LE(48000,12);
  const tags=Buffer.alloc(16);
  tags.write('OpusTags',0,'ascii');
  const audio=Buffer.from([0xf8,0xff,0xfe]);
  return Buffer.concat([
    page(head,0,2,0n),page(tags,1,0,0n),page(audio,2,4,1272n),
  ]);
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Folio isolated PostgreSQL URL required');
  const parsed=new URL(url);
  if(parsed.pathname!=='/folio_test'||
    !['127.0.0.1','localhost'].includes(parsed.hostname)||
    parsed.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Ogg Opus smoke uses ONLY loopback Folio folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const root=await mkdtemp(join(tmpdir(),'folio-ogg-owner-test-'));
  try{
    const owner=randomUUID(),otherOwner=randomUUID();
    const storage=await LocalStorageAdapter.create(root);
    const stage=async(data:Buffer)=>{
      const reservation=await reservePrivateUploadQuota(
        first.db,owner,data.length,32768);
      const blob=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([data]),declaredSha256:sha(data),
        declaredMime:'audio/ogg',maxBytes:data.length,
      });
      return (await commitPrivateQuarantinedUpload(
        first.db,storage,owner,reservation.reservationId,blob)).assetId;
    };
    const audit=async(assetId:string)=>first.db.select().from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityType,'media_asset'),
        eq(schema.auditEvents.entityId,assetId),
        eq(schema.auditEvents.action,'storage.quarantine.ogg_opus_observed')));
    const ownedId=await stage(fixture());
    await deny('other owner',()=>observePrivateQuarantineOggOpus(
      second.db,storage,otherOwner,ownedId));
    await deny('random opaque asset ID',()=>observePrivateQuarantineOggOpus(
      first.db,storage,owner,randomUUID()));
    const inspected=await observePrivateQuarantineOggOpus(
      second.db,storage,owner,ownedId);
    check(inspected.assetId===ownedId&&
      inspected.assetStatus==='pending_verify'&&
      inspected.status==='ogg_opus_container_only'&&
      inspected.pageCount===3&&inspected.audioPacketCount===1&&
      inspected.channelCount===1&&inspected.granuleTimelineMs===20,
      'Trusted Ogg inspection did not produce review-only aggregates');
    const [row]=await first.db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,ownedId));
    const history=await audit(ownedId);
    const logged=JSON.stringify(history[0]?.afterJson);
    check(row?.status==='pending_verify'&&row.verifiedAt===null&&
      row.durationMs===null&&history.length===1&&
      !logged.includes(row.storageKey)&&!logged.includes(root)&&
      !logged.includes('OpusTags')&&!logged.includes('OpusHead'),
      'Ogg structure inspection verified media or leaked source/private key');

    // A simple OggS magic declaration is insufficient after stage admission.
    const truncated=await stage(Buffer.from('OggS-truncated'));
    await deny('incomplete pages',()=>observePrivateQuarantineOggOpus(
      first.db,storage,owner,truncated));
    check((await audit(truncated)).length===0,
      'Malformed Ogg source received a passing audit');

    const withdrawn=await stage(fixture());
    const original=storage.inspectOggOpus.bind(storage);
    storage.inspectOggOpus=async record=>{
      const result=await original(record);
      await second.db.update(schema.mediaAssets).set({status:'rejected'})
        .where(eq(schema.mediaAssets.id,withdrawn));
      return result;
    };
    await deny('withdrawn during scan',()=>observePrivateQuarantineOggOpus(
      first.db,storage,owner,withdrawn));
    check((await audit(withdrawn)).length===0,
      'Withdrawn Ogg source incorrectly received positive audit');
    console.log('OGG OPUS PRIVATE QUARANTINE PASS: Folio-only two PostgreSQL pools, CRC/serial/granule review-only checks, wrong-owner/unknown/malformed denial, in-flight withdrawal, pending_verify intact and counts-only audit.');
  }finally{
    await first.pool.end();
    await second.pool.end();
    await rm(root,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
