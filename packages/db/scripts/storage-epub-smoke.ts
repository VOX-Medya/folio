import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {and,eq} from 'drizzle-orm';
import {createFolioDb,LocalStorageAdapter,reservePrivateUploadQuota,
  commitPrivateQuarantinedUpload,observePrivateQuarantineEpubStructure,schema} from '../src/index.js';
function check(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
async function deny(label:string,fn:()=>Promise<unknown>){
  let rejected=false;
  try{await fn();}catch{rejected=true;}
  check(rejected,'Unsafe EPUB metadata operation accepted: '+label);
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function crc32(b:Buffer):number{
  let c=0xffffffff;
  for(const v of b){c^=v;for(let j=0;j<8;j++)c=(c&1)?(c>>>1)^0xedb88320:c>>>1;}
  return (c^0xffffffff)>>>0;
}
/** Tiny synthetic uncompressed EPUB OCF, not a third-party or copyrighted book. */
function fixture(){
  const entries=[
    ['mimetype','application/epub+zip'],
    ['META-INF/container.xml','<container version="1.0"/>'],
    ['OPS/book.opf','<package version="3.0"/>'],
    ['OPS/chapter.xhtml','<html><body>Synthetic text.</body></html>'],
  ];
  const locals:Buffer[]=[],centrals:Buffer[]=[];
  let offset=0,expanded=0;
  for(const [path,body] of entries){
    const name=Buffer.from(path,'ascii'),data=Buffer.from(body,'utf8');
    const crc=crc32(data),local=Buffer.alloc(30+name.length);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt32LE(crc,14);
    local.writeUInt32LE(data.length,18);
    local.writeUInt32LE(data.length,22);
    local.writeUInt16LE(name.length,26);
    name.copy(local,30);
    locals.push(local,data);
    const central=Buffer.alloc(46+name.length);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt32LE(crc,16);
    central.writeUInt32LE(data.length,20);
    central.writeUInt32LE(data.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt32LE(offset,42);
    name.copy(central,46);
    centrals.push(central);
    offset+=local.length+data.length;
    expanded+=data.length;
  }
  const central=Buffer.concat(centrals),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(central.length,12);
  end.writeUInt32LE(offset,16);
  return {bytes:Buffer.concat([...locals,central,end]),expanded};
}
async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio isolated test PostgreSQL URL required');
  const dbUrl=new URL(url);
  if(dbUrl.pathname!=='/folio_test'||!['localhost','127.0.0.1'].includes(dbUrl.hostname)||
    dbUrl.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('EPUB structural smoke uses ONLY Folio loopback folio_test');
  }
  const first=createFolioDb(url),second=createFolioDb(url);
  const root=await mkdtemp(join(tmpdir(),'folio-epub-structure-test-'));
  try{
    const owner=randomUUID(),anotherOwner=randomUUID();
    const storage=await LocalStorageAdapter.create(root);
    const example=fixture();
    const stage=async(data:Buffer)=>{
      const reservation=await reservePrivateUploadQuota(first.db,owner,data.length,8192);
      const blob=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([data]),declaredSha256:sha(data),
        declaredMime:'application/epub+zip',maxBytes:data.length,
      });
      return (await commitPrivateQuarantinedUpload(
        first.db,storage,owner,reservation.reservationId,blob)).assetId;
    };
    const id=await stage(example.bytes);
    const audit=async(id:string)=>first.db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.entityType,'media_asset'),
      eq(schema.auditEvents.entityId,id),
      eq(schema.auditEvents.action,'storage.quarantine.epub_structure_observed'),
    ));
    await deny('unknown owner',()=>observePrivateQuarantineEpubStructure(
      second.db,storage,anotherOwner,id,
    ));
    await deny('unknown asset',()=>observePrivateQuarantineEpubStructure(
      second.db,storage,owner,randomUUID(),
    ));
    const observation=await observePrivateQuarantineEpubStructure(second.db,storage,owner,id);
    check(observation.assetId===id&&observation.entryCount===4&&
      observation.expandedBytes===example.expanded&&
      observation.assetStatus==='pending_verify'&&observation.status==='structure_only'&&
      observation.hasPackage===true,
    'Trusted structural EPUB observation returned invalid status');
    const [stored]=await first.db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,id));
    check(stored?.status==='pending_verify'&&stored.verifiedAt===null,
      'Structural ZIP validation incorrectly verified/published private media');
    let events=await audit(id);
    check(events.length===1,'Expected one owner-scoped EPUB structural audit');
    const observed=JSON.stringify(events[0]?.afterJson);
    check(observed.includes('structure_only')&&!observed.includes(root)&&
      !observed.includes(stored!.storageKey)&&!observed.includes('Synthetic text'),
    'Structural audit leaked private name/key or content');

    // Old staging magic-sniffing accepts the first OCF member as pending.
    // The full safe ZIP preflight MUST reject a missing central directory.
    const incompleteId=await stage(example.bytes.subarray(0,58));
    await deny('missing entire ZIP central directory',
      ()=>observePrivateQuarantineEpubStructure(first.db,storage,owner,incompleteId));
    check((await audit(incompleteId)).length===0,
      'Bad truncated archive had a positive EPUB structural audit');

    const revokedId=await stage(example.bytes);
    const original=storage.inspectEpubStructure.bind(storage);
    storage.inspectEpubStructure=async rec=>{
      const result=await original(rec);
      await second.db.update(schema.mediaAssets).set({status:'rejected'})
        .where(eq(schema.mediaAssets.id,revokedId));
      return result;
    };
    await deny('mid-inspection rejected asset',
      ()=>observePrivateQuarantineEpubStructure(first.db,storage,owner,revokedId));
    check((await audit(revokedId)).length===0,
      'Withdrawn EPUB retained invalid positive audit evidence');
    events=await audit(id);
    check(events.length===1,'Owner-matched earlier audit changed unexpectedly');
    console.log('EPUB structural owner PASS: real two-pool PostgreSQL owner/revocation safety, complete OCF ZIP CRC/size, truncated-header denial, audit without key/content or verified transition. Synthetic Folio folio_test only.');
  }finally{
    await first.pool.end();
    await second.pool.end();
    await rm(root,{recursive:true,force:true});
  }
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
