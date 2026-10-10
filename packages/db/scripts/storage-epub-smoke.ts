import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {deflateSync} from 'node:zlib';
import {and,eq} from 'drizzle-orm';
import {createFolioDb,LocalStorageAdapter,reservePrivateUploadQuota,
  commitPrivateQuarantinedUpload,observePrivateQuarantineEpubStructure,
  observePrivateQuarantineEpubPackageSpine,
  observePrivateQuarantineEpubXhtmlMarkup,
  observePrivateQuarantineEpubCssResources,
  observePrivateQuarantineEpubPngResources,schema} from '../src/index.js';
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
function pngChunk(type:string,data:Buffer):Buffer{
  const id=Buffer.from(type,'ascii');
  const len=Buffer.alloc(4);len.writeUInt32BE(data.length);
  const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([id,data])));
  return Buffer.concat([len,id,data,crc]);
}
function syntheticPng():Buffer{
  const header=Buffer.alloc(13);
  header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);
  header[8]=8;header[9]=6;
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR',header),
    pngChunk('IDAT',deflateSync(Buffer.from([0,25,50,75,255]))),
    pngChunk('IEND',Buffer.alloc(0)),
  ]);
}
/** Tiny synthetic uncompressed EPUB OCF, not third-party copyrighted files. */
function fixture(withPackage=false,cssText?:string,embedded?:{
  filename:string;mime:string;bytes:Buffer;
}){

  const entries:Array<[string,string|Buffer]>=withPackage?[
    ['mimetype','application/epub+zip'],
    ['META-INF/container.xml','<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OPS/book.opf','<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="a" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="n" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="a" linear="yes"/></spine></package>'],
    ['OPS/chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Private example</title></head><body><section id="chapter"><h1>Synthetic chapter</h1><p>Private synthetic words.</p></section></body></html>'],
    ['OPS/nav.xhtml','<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Navigation</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#chapter">Chapter one</a></li></ol></nav></body></html>'],
  ]:[

    ['mimetype','application/epub+zip'],
    ['META-INF/container.xml','<container version="1.0"/>'],
    ['OPS/book.opf','<package version="3.0"/>'],
    ['OPS/chapter.xhtml','<html><body>Synthetic text.</body></html>'],
  ];
  if(cssText!==undefined){
    if(!withPackage)throw new Error('CSS fixture requires a valid OPF');
    const opf=entries.find(row=>row[0]==='OPS/book.opf');
    if(!opf||typeof opf[1]!=='string')throw new Error('Synthetic OPF missing');
    opf[1]=opf[1].replace('</manifest>',
      '<item id="style" href="style.css" media-type="text/css"/></manifest>');
    entries.push(['OPS/style.css',cssText]);
  }
  if(embedded!==undefined){
    if(!withPackage||!/^[-a-z0-9.]+$/.test(embedded.filename))throw new Error('Invalid embedded fixture');
    const opf=entries.find(row=>row[0]==='OPS/book.opf');
    if(!opf||typeof opf[1]!=='string')throw new Error('Synthetic OPF missing');
    opf[1]=opf[1].replace('</manifest>',
      '<item id="embedded" href="'+embedded.filename+'" media-type="'+
      embedded.mime+'"/></manifest>');
    entries.push(['OPS/'+embedded.filename,embedded.bytes]);
  }
  const locals:Buffer[]=[],centrals:Buffer[]=[];
  let offset=0,expanded=0;
  for(const [path,body] of entries){
    const name=Buffer.from(path,'ascii'),data=Buffer.isBuffer(body)?body:Buffer.from(body,'utf8');
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
      const reservation=await reservePrivateUploadQuota(first.db,owner,data.length,32*1024);
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
    const packageFixture=fixture(true);
    const ownedPackage=await stage(packageFixture.bytes);
    const packageAudit=async(id:string)=>first.db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.entityType,'media_asset'),
      eq(schema.auditEvents.entityId,id),
      eq(schema.auditEvents.action,'storage.quarantine.epub_package_observed'),
    ));
    await deny('another user package observation',
      ()=>observePrivateQuarantineEpubPackageSpine(
        second.db,storage,anotherOwner,ownedPackage));
    await deny('nonexistent package observation',
      ()=>observePrivateQuarantineEpubPackageSpine(
        second.db,storage,owner,randomUUID()));
    const relations=await observePrivateQuarantineEpubPackageSpine(
      first.db,storage,owner,ownedPackage);
    check(relations.assetId===ownedPackage&&relations.status==='package_spine_only'&&
      relations.assetStatus==='pending_verify'&&relations.manifestItems===2&&
      relations.spineItems===1&&relations.linearSpineItems===1,
    'Owned EPUB package/spine observation was not constrained');
    const [packageRow]=await first.db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,ownedPackage));
    const logged=await packageAudit(ownedPackage);
    check(packageRow?.status==='pending_verify'&&packageRow.verifiedAt===null&&
      logged.length===1,
    'Successful package observation incorrectly marked the EPUB as verified');
    const logJson=JSON.stringify(logged[0]!.afterJson);
    check(logJson.includes('package_spine_only')&&!logJson.includes(root)&&
      !logJson.includes(packageRow.storageKey)&&
      !logJson.includes('chapter.xhtml')&&!logJson.includes('Private synthetic'),
    'Package audit leaked private path, key or source');

    // Old structure-only fixture has a valid ZIP, but fake/invalid OPF.
    await deny('structure-only EPUB mistaken for valid package',
      ()=>observePrivateQuarantineEpubPackageSpine(first.db,storage,owner,id));
    check((await packageAudit(id)).length===0,
      'Fake metadata was logged as a successfully validated package');
    const withdrawnPackage=await stage(packageFixture.bytes);
    const originalPackage=storage.inspectEpubPackageSpine.bind(storage);
    storage.inspectEpubPackageSpine=async record=>{
      const result=await originalPackage(record);
      await second.db.update(schema.mediaAssets).set({status:'rejected'})
        .where(eq(schema.mediaAssets.id,withdrawnPackage));
      return result;
    };
    await deny('EPUB package withdrawn while inspection is in progress',
      ()=>observePrivateQuarantineEpubPackageSpine(
        first.db,storage,owner,withdrawnPackage));
    check((await packageAudit(withdrawnPackage)).length===0,
      'Mid-scan rejected package incorrectly received a success audit');
    const xhtmlAudit=async(id:string)=>first.db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.entityType,'media_asset'),
      eq(schema.auditEvents.entityId,id),
      eq(schema.auditEvents.action,'storage.quarantine.epub_xhtml_observed'),
    ));
    await deny('another user XHTML markup preflight',
      ()=>observePrivateQuarantineEpubXhtmlMarkup(second.db,storage,anotherOwner,ownedPackage));
    await deny('unknown private EPUB XHTML media ID',
      ()=>observePrivateQuarantineEpubXhtmlMarkup(second.db,storage,owner,randomUUID()));
    await deny('old valid ZIP but malformed OPF rejected by XHTML',
      ()=>observePrivateQuarantineEpubXhtmlMarkup(first.db,storage,owner,id));
    const shape=await observePrivateQuarantineEpubXhtmlMarkup(
      first.db,storage,owner,ownedPackage);
    check(shape.status==='xhtml_markup_only'&&shape.assetStatus==='pending_verify'&&
      shape.assetId===ownedPackage&&shape.documentCount===2&&
      shape.navigationDocuments===1&&shape.fragmentLinks===1,
    'Private XHTML document and local link checks did not pass');
    const [afterMarkup]=await first.db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,ownedPackage));
    const shapeEvents=await xhtmlAudit(ownedPackage);
    check(afterMarkup?.status==='pending_verify'&&afterMarkup.verifiedAt===null&&
      shapeEvents.length===1,'XHTML shape check incorrectly verified/published EPUB');
    const shapeJson=JSON.stringify(shapeEvents[0]?.afterJson);
    check(shapeJson.includes('xhtml_markup_only')&&
      !shapeJson.includes(afterMarkup.storageKey)&&!shapeJson.includes(root)&&
      !shapeJson.includes('chapter.xhtml')&&!shapeJson.includes('Private synthetic'),
    'XHTML metadata-only audit exposed storage key, file path or source');
    const abortedId=await stage(packageFixture.bytes);
    const originalXhtml=storage.inspectEpubXhtmlMarkup.bind(storage);
    storage.inspectEpubXhtmlMarkup=async record=>{
      const result=await originalXhtml(record);
      await second.db.update(schema.mediaAssets).set({status:'rejected'})
        .where(eq(schema.mediaAssets.id,abortedId));
      return result;
    };
    await deny('EPUB withdrawn while XHTML preflight active',
      ()=>observePrivateQuarantineEpubXhtmlMarkup(first.db,storage,owner,abortedId));
    check((await xhtmlAudit(abortedId)).length===0,
      'Withdrawn XHTML media incorrectly retained success audit');
    // Fourth independent CSS lexical-subset gate, still pending_verify.
    const styledId=await stage(fixture(true,'body { margin: 1em; color: #123; }').bytes);
    const cssAudit=async(assetId:string)=>first.db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.entityType,'media_asset'),
      eq(schema.auditEvents.entityId,assetId),
      eq(schema.auditEvents.action,'storage.quarantine.epub_css_observed'),
    ));
    await deny('CSS inspection cross-owner',
      ()=>observePrivateQuarantineEpubCssResources(
        second.db,storage,anotherOwner,styledId));
    await deny('CSS inspection unknown ID',
      ()=>observePrivateQuarantineEpubCssResources(
        second.db,storage,owner,randomUUID()));
    const css=await observePrivateQuarantineEpubCssResources(
      first.db,storage,owner,styledId);
    check(css.status==='css_resources_only'&&css.assetStatus==='pending_verify'&&
      css.stylesheetCount===1&&css.ruleCount===1&&css.declarationCount===2,
      'Private stylesheet quarantine result was not bounded');
    const [cssAsset]=await first.db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,styledId));
    const cssEvents=await cssAudit(styledId);
    const cssJson=JSON.stringify(cssEvents[0]?.afterJson);
    check(cssAsset?.status==='pending_verify'&&cssAsset.verifiedAt===null&&
      cssEvents.length===1&&!cssJson.includes(cssAsset.storageKey)&&
      !cssJson.includes(root)&&!cssJson.includes('style.css')&&
      !cssJson.includes('margin'),
      'Private CSS inspection incorrectly verified or leaked source/path');
    const unsafeCssId=await stage(
      fixture(true,"@import url('https://evil.invalid/style.css');").bytes);
    await deny('remote CSS import',
      ()=>observePrivateQuarantineEpubCssResources(
        first.db,storage,owner,unsafeCssId));
    check((await cssAudit(unsafeCssId)).length===0,
      'Unsafe CSS was incorrectly recorded as successful');
    const withdrawnCssId=await stage(fixture(true,'p { color: #123; }').bytes);
    const originalCss=storage.inspectEpubCssResources.bind(storage);
    storage.inspectEpubCssResources=async record=>{
      const result=await originalCss(record);
      await second.db.update(schema.mediaAssets).set({status:'rejected'})
        .where(eq(schema.mediaAssets.id,withdrawnCssId));
      return result;
    };
    await deny('CSS inspected while asset withdrawn',
      ()=>observePrivateQuarantineEpubCssResources(
        first.db,storage,owner,withdrawnCssId));
    check((await cssAudit(withdrawnCssId)).length===0,
      'Withdrawn private CSS media incorrectly got success audit');
    // Fifth private binary-resource gate: explicit PNG structure only.
    const image=syntheticPng();
    const pngAsset=await stage(fixture(true,undefined,{
      filename:'cover.png',mime:'image/png',bytes:image,
    }).bytes);
    const pngAudit=async(assetId:string)=>first.db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.entityType,'media_asset'),
      eq(schema.auditEvents.entityId,assetId),
      eq(schema.auditEvents.action,'storage.quarantine.epub_png_observed'),
    ));
    await deny('embedded PNG cross-owner',
      ()=>observePrivateQuarantineEpubPngResources(
        second.db,storage,anotherOwner,pngAsset));
    await deny('embedded PNG unknown ID',
      ()=>observePrivateQuarantineEpubPngResources(
        second.db,storage,owner,randomUUID()));
    const result=await observePrivateQuarantineEpubPngResources(
      first.db,storage,owner,pngAsset);
    check(result.assetId===pngAsset&&result.status==='png_structure_only'&&
      result.imageCount===1&&result.totalPixels===1&&
      result.imageBytes===image.length&&result.assetStatus==='pending_verify',
      'Private image gate incorrectly accepted metadata');
    const [imageRow]=await first.db.select().from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id,pngAsset));
    const pngEvents=await pngAudit(pngAsset);
    const auditString=JSON.stringify(pngEvents[0]?.afterJson);
    check(imageRow?.status==='pending_verify'&&imageRow.verifiedAt===null&&
      pngEvents.length===1&&!auditString.includes(imageRow.storageKey)&&
      !auditString.includes(root)&&!auditString.includes('cover.png'),
      'Private image gate verified a file or leaked private source/path');

    const badPng=Buffer.from(image);badPng[badPng.length-1]=(badPng[badPng.length-1]??0)^1;
    const badPngId=await stage(fixture(true,undefined,{
      filename:'cover.png',mime:'image/png',bytes:badPng,
    }).bytes);
    await deny('PNG chunk CRC corrupted inside valid EPUB ZIP',
      ()=>observePrivateQuarantineEpubPngResources(first.db,storage,owner,badPngId));
    check((await pngAudit(badPngId)).length===0,
      'Corrupted PNG incorrectly got success audit');
    const fontAsset=await stage(fixture(true,undefined,{
      filename:'font.woff2',mime:'font/woff2',bytes:Buffer.from('wOF2','ascii'),
    }).bytes);
    await deny('unparsed embedded font intentionally blocked',
      ()=>observePrivateQuarantineEpubPngResources(first.db,storage,owner,fontAsset));
    check((await pngAudit(fontAsset)).length===0,
      'Unscanned embedded font incorrectly got a positive audit');

    const withdrawnPngId=await stage(fixture(true,undefined,{
      filename:'cover.png',mime:'image/png',bytes:image,
    }).bytes);
    const originalPng=storage.inspectEpubPngResources.bind(storage);
    storage.inspectEpubPngResources=async record=>{
      const reading=await originalPng(record);
      await second.db.update(schema.mediaAssets).set({status:'rejected'})
        .where(eq(schema.mediaAssets.id,withdrawnPngId));
      return reading;
    };
    await deny('private PNG withdrawn during observation',
      ()=>observePrivateQuarantineEpubPngResources(
        first.db,storage,owner,withdrawnPngId));
    check((await pngAudit(withdrawnPngId)).length===0,
      'Withdrawn private PNG incorrectly received success audit');
    console.log('EPUB PNG binary owner PASS: Folio-only PostgreSQL, bounded PNG CRC/zlib, unparsed fonts denied, owner isolation, revocation, pending status and counts-only audit.');
    console.log('EPUB CSS private-owner PASS: isolated PostgreSQL, imports denied, cross-owner and withdrawal rejected, counts-only audit, pending_verify.');
    console.log('EPUB XHTML syntax owner PASS: Folio-only two-pool PostgreSQL, exact safe-local nav anchors, owner isolation, in-flight revocation, counts-only audit, pending_verify preserved.');
    console.log('EPUB package/spine owner PASS: two Folio-only PostgreSQL pools, actual OCF rootfile and OPF relationships, private-owner/RBAC boundary, no source/key in audit, rejected placeholder, revocation and pending_verify preserved.');
    console.log('EPUB structural owner PASS: real two-pool PostgreSQL owner/revocation safety, complete OCF ZIP CRC/size, truncated-header denial, audit without key/content or verified transition. Synthetic Folio folio_test only.');
  }finally{
    await first.pool.end();
    await second.pool.end();
    await rm(root,{recursive:true,force:true});
  }
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
