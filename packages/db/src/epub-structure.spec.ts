import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {deflateSync,deflateRawSync} from 'node:zlib';
import {describe,expect,it} from 'vitest';
import {inspectEpubZipStructure,inspectEpubZipPackageSpine,inspectEpubZipXhtmlMarkup,inspectEpubZipCssResources,inspectEpubZipPngResources,EPUB_ZIP_PREFLIGHT_MAX_BYTES} from './epub-structure.js';
import {LocalStorageAdapter} from './local-storage.js';

interface Entry{
  name:string;
  content:Buffer;
  compress?:boolean;
  descriptor?:boolean;
  flags?:number;
  externalMode?:number;
  extra?:Buffer;
}
const utf=(value:string)=>Buffer.from(value,'utf8');
const crc32=(buf:Buffer)=>{
  let crc=0xffffffff;
  for(const byte of buf){
    crc^=byte;
    for(let i=0;i<8;i++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;
  }
  return (crc^0xffffffff)>>>0;
};
const core=():Entry[]=>[
  {name:'mimetype',content:utf('application/epub+zip')},
  {name:'META-INF/container.xml',content:utf('<container version="1.0"></container>'),compress:true},
  {name:'OPS/book.opf',content:utf('<package version="3.0"></package>'),compress:true,descriptor:true},
  {name:'OPS/chapter.xhtml',content:utf('<html><body><p>Synthetic chapter only.</p></body></html>'),compress:true},
];

/** Synthetic ZIP fixture generator independent of the implementation under
 * test. Never fetches or modifies copyrighted source files. */
function archive(entries:Entry[]):Buffer{
  const locals:Buffer[]=[],centrals:Buffer[]=[];
  let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,'utf8'),extra=entry.extra??Buffer.alloc(0);
    const packed=entry.compress?deflateRawSync(entry.content):entry.content;
    const crc=crc32(entry.content),flags=(entry.flags??0)|(entry.descriptor?8:0);
    const method=entry.compress?8:0;
    const local=Buffer.alloc(30+name.length+extra.length);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(flags,6);
    local.writeUInt16LE(method,8);
    if(!entry.descriptor){
      local.writeUInt32LE(crc,14);
      local.writeUInt32LE(packed.length,18);
      local.writeUInt32LE(entry.content.length,22);
    }
    local.writeUInt16LE(name.length,26);
    local.writeUInt16LE(extra.length,28);
    name.copy(local,30);
    extra.copy(local,30+name.length);
    const descriptor=entry.descriptor?Buffer.alloc(16):Buffer.alloc(0);
    if(entry.descriptor){
      descriptor.writeUInt32LE(0x08074b50,0);
      descriptor.writeUInt32LE(crc,4);
      descriptor.writeUInt32LE(packed.length,8);
      descriptor.writeUInt32LE(entry.content.length,12);
    }
    locals.push(local,packed,descriptor);
    const central=Buffer.alloc(46+name.length+extra.length);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt16LE(flags,8);
    central.writeUInt16LE(method,10);
    central.writeUInt32LE(crc,16);
    central.writeUInt32LE(packed.length,20);
    central.writeUInt32LE(entry.content.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt16LE(extra.length,30);
    central.writeUInt32LE(((entry.externalMode??0)<<16)>>>0,38);
    central.writeUInt32LE(offset,42);
    name.copy(central,46);
    extra.copy(central,46+name.length);
    centrals.push(central);
    offset+=local.length+packed.length+descriptor.length;
  }
  const catalog=Buffer.concat(centrals);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(catalog.length,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,catalog,end]);
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

describe('bounded EPUB ZIP OCF structural admission (never publication)',()=>{
  it('accepts a synthetic OCF archive with deflate, stored mimetype and ZIP descriptor',()=>{
    const bytes=archive(core());
    const result=inspectEpubZipStructure(bytes);
    expect(result).toEqual({
      status:'structure_only',entryCount:4,expandedBytes:core().reduce((s,e)=>s+e.content.length,0),
      hasContainer:true,hasPackage:true,hasXhtml:true,
    });
    expect(JSON.stringify(result)).not.toContain('Synthetic chapter');
  });

  it('rejects the incomplete 58-byte header currently admitted to quarantine',()=>{
    const valid=archive(core());
    expect(()=>inspectEpubZipStructure(valid.subarray(0,58))).toThrow(/Unsupported EPUB/);
  });

  it('denies missing required OCF files, duplicate paths, and encrypted/rights payload markers',()=>{
    for(const entries of [
      core().filter(e=>e.name!=='META-INF/container.xml'),
      core().filter(e=>e.name!=='OPS/book.opf'),
      core().filter(e=>e.name!=='OPS/chapter.xhtml'),
      [...core(),{name:'OPS/CHAPTER.xhtml',content:utf('duplicate')}],
      [...core(),{name:'META-INF/encryption.xml',content:utf('<encryptedData/>')}],
      [...core(),{name:'META-INF/rights.xml',content:utf('<rights/>')}],
      [...core(),{name:'OPS/external.zip',content:utf('PK')}],
    ]){
      expect(()=>inspectEpubZipStructure(archive(entries))).toThrow(/Unsupported EPUB/);
    }
  });

  it.each([
    '../outside.xhtml','OPS/../evil.xhtml','OPS/./evil.xhtml',
    '/absolute.xhtml','C:/escape.xhtml','OPS\\bad.xhtml',
    'OPS//fragment.xhtml','OPS/%2e%2e/file.xhtml','OPS/bad%2ffile.xhtml',
  ])('rejects ambiguous/traversal ZIP member %s',name=>{
    expect(()=>inspectEpubZipStructure(archive([
      ...core(),{name,content:utf('payload')},
    ]))).toThrow(/Unsupported EPUB/);
  });

  it('fails closed on ZIP encryption flag, symlinks, unknown flag and unsigned UTF-8 names',()=>{
    for(const options of [
      {flags:1},{flags:0x40},{flags:0x2000},{externalMode:0xa000},
    ]){
      const entries=core();
      Object.assign(entries[3]!,options);
      expect(()=>inspectEpubZipStructure(archive(entries))).toThrow(/Unsupported EPUB/);
    }
    expect(()=>inspectEpubZipStructure(archive([
      ...core(),{name:'OPS/öykü.xhtml',content:utf('ok')},
    ]))).toThrow(/Unsupported EPUB/);
    expect(inspectEpubZipStructure(archive([
      ...core(),{name:'OPS/öykü.xhtml',content:utf('ok'),flags:0x800},
    ])).entryCount).toBe(5);
  });

  it('refuses malformed EOCD, incorrect local/central metadata and appended ZIP garbage',()=>{
    const valid=archive(core());
    const cd=valid.readUInt32LE(valid.length-6);
    const mutated:Buffer[]=[];
    const tamper=(write:(b:Buffer)=>void)=>{const b=Buffer.from(valid);write(b);mutated.push(b);};
    tamper(b=>b.writeUInt16LE(1,b.length-22+4)); // multidisk
    tamper(b=>b.writeUInt16LE(0xffff,b.length-22+10)); // bogus entries
    tamper(b=>b.writeUInt32LE(0xffffffff,b.length-6)); // ZIP64 sentinel
    tamper(b=>b.writeUInt32LE(123,cd+42)); // central local offset
    tamper(b=>b.writeUInt32LE(1,cd+20)); // mismatch central compressed size
    tamper(b=>b[38]=0x41); // EPUB mimetype content mismatch
    tamper(b=>b[58]=b[58]!^0x01); // first byte of local second header
    tamper(b=>b.writeUInt32LE(0,cd+16)); // CRC mismatch
    mutated.push(Buffer.concat([valid,Buffer.from('garbage')]));
    mutated.push(valid.subarray(0,valid.length-4));
    for(const b of mutated){
      expect(()=>inspectEpubZipStructure(b)).toThrow(/Unsupported EPUB/);
    }
  });

  it('supports benign extra-field TLVs but rejects malformed/ZIP64/path-rebinding extras',()=>{
    const safe=Buffer.from([0x55,0x54,0x01,0x00,0x00]);
    expect(inspectEpubZipStructure(archive([
      ...core(),{name:'OPS/sub.xhtml',content:utf('ok'),extra:safe},
    ])).entryCount).toBe(5);
    for(const extra of [
      Buffer.from([0x01,0x00,0x00,0x00]), // zip64
      Buffer.from([0x75,0x70,0x00,0x00]), // Unicode path override
      Buffer.from([0x55,0x54,0xff,0xff]), // truncated
    ]){
      expect(()=>inspectEpubZipStructure(archive([
        ...core(),{name:'OPS/sub.xhtml',content:utf('ok'),extra},
      ]))).toThrow(/Unsupported EPUB/);
    }
  });

  it('bounds inflated data to prevent compressed ZIP bombs',()=>{
    const expanded=Buffer.alloc(512*1024,'a');
    const compressed=archive([
      ...core(),{name:'OPS/bomb.xhtml',content:expanded,compress:true},
    ]);
    expect(compressed.length).toBeLessThan(20000);
    expect(()=>inspectEpubZipStructure(compressed)).toThrow(/Unsupported EPUB/);
    const tooLarge=Buffer.alloc(EPUB_ZIP_PREFLIGHT_MAX_BYTES+1);
    expect(()=>inspectEpubZipStructure(tooLarge)).toThrow(/Unsupported EPUB/);
  });

  it('does not treat valid ZIP shape as EPUB spine, source text or scanning proof',()=>{
    const first=core();
    first[3]!.content=utf('garbled XHTML, deliberately no readable source');
    const result=inspectEpubZipStructure(archive(first));
    expect(result.status).toBe('structure_only');
    expect(Object.keys(result)).not.toContain('verified');
    expect(Object.keys(result)).not.toContain('readingOrder');
  });

  it('rechecks private owner inode + SHA before returning only structural result',async()=>{
    const root=await mkdtemp(join(tmpdir(),'folio-zip-structure-'));
    try{
      const adapter=await LocalStorageAdapter.create(root);
      const alice=randomUUID();
      const data=archive(core());
      const record=await adapter.stage({
        owner:{scope:'private-user',ownerUserId:alice},
        source:Readable.from([data]),declaredSha256:sha(data),
        declaredMime:'application/epub+zip',maxBytes:data.length,
      });
      expect((await adapter.inspectEpubStructure(record)).status).toBe('structure_only');
      await expect(adapter.inspectEpubStructure({
        ...record,ownerUserId:randomUUID(),
      })).rejects.toThrow();
      await expect(adapter.inspectEpubStructure({
        ...record,sha256:'f'.repeat(64),
      })).rejects.toThrow(/changed/);
      await expect(adapter.inspectEpubStructure({
        ...record,mime:'text/plain',
      })).rejects.toThrow();
      const file=join(root,'quarantine','users',alice,record.key+'.blob');
      await chmod(file,0o644);
      await expect(adapter.inspectEpubStructure(record)).rejects.toThrow(/permissions/);
      await chmod(file,0o600);
      const altered=Buffer.from(data);
      altered[altered.length-1]=0xff;
      await writeFile(file,altered);
      await expect(adapter.inspectEpubStructure(record)).rejects.toThrow(/changed/);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});


/** Complete, but intentionally synthetic, OCF/OPF *relationship* fixtures.
 * No source text is extracted or published by either inspector. */
function completePackageEntries():Entry[]{
  return [
    {name:'mimetype',content:utf('application/epub+zip')},
    {name:'META-INF/container.xml',compress:true,content:utf(
      '<?xml version="1.0" encoding="UTF-8"?>'+
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'+
      '<rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles>'+
      '</container>',
    )},
    {name:'OPS/book.opf',compress:true,descriptor:true,content:utf(
      '<?xml version="1.0" encoding="UTF-8"?>'+
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pubid">'+
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'+
      '<dc:identifier id="pubid">urn:folio:synthetic</dc:identifier>'+
      '<dc:title>Safe &amp; synthetic</dc:title></metadata>'+
      '<manifest>'+
      '<item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'+
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'+
      '<item id="style" href="style.css" media-type="text/css"/>'+
      '</manifest><spine><itemref idref="chapter" linear="yes"/></spine>'+
      '</package>',
    )},
    {name:'OPS/chapter.xhtml',compress:true,content:utf(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Synthetic source only.</p></body></html>',
    )},
    {name:'OPS/nav.xhtml',compress:true,content:utf(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav>Contents</nav></body></html>',
    )},
    {name:'OPS/style.css',content:utf('body { margin: 1em; }')},
  ];
}
function replaceEntry(
  entries:Entry[],name:string,transform:(value:string)=>string,
):Entry[]{
  return entries.map(e=>e.name===name?{...e,content:utf(transform(e.content.toString('utf8')))}:e);
}
function changedPackage(transform:(value:string)=>string):Buffer {
  return archive(replaceEntry(completePackageEntries(),'OPS/book.opf',transform));
}
function changedContainer(transform:(value:string)=>string):Buffer {
  return archive(replaceEntry(completePackageEntries(),'META-INF/container.xml',transform));
}
const denyPackage=(data:Buffer)=>{
  // The outer ZIP may still be CRC-perfect; the package/spine relationship
  // must be rejected separately without blessing or mutating the source.
  expect(inspectEpubZipStructure(data).status).toBe('structure_only');
  expect(()=>inspectEpubZipPackageSpine(data)).toThrow(/Unsupported EPUB package\/spine/);
};

describe('EPUB package and spine relationship preflight (not text validation)',()=>{
  it('checks exact OCF rootfile + OPF manifest + nav + linear chapter references',()=>{
    const original=archive(completePackageEntries());
    const result=inspectEpubZipPackageSpine(original);
    expect(result).toEqual({
      status:'package_spine_only',packageCount:1,
      manifestItems:3,spineItems:1,linearSpineItems:1,navigationCount:1,
    });
    expect(JSON.stringify(result)).not.toMatch(/book\.opf|chapter\.xhtml|urn:folio|Synthetic source/);
    expect('verified' in result).toBe(false);
  });

  it('rejects a structurally intact EPUB with fake XML/OPF placeholder text',()=>{
    denyPackage(archive(core()));
  });

  it('rejects ambiguous, missing or remote container rootfile resolution',()=>{
    const cases=[
      (s:string)=>s.replace('OPS/book.opf','OPS/other.opf'),
      (s:string)=>s.replace('OPS/book.opf','OPS/../OPS/book.opf'),
      (s:string)=>s.replace('OPS/book.opf','https://example.org/book.opf'),
      (s:string)=>s.replace('OPS/book.opf','OPS/%62ook.opf'),
      (s:string)=>s.replace('application/oebps-package+xml','text/plain'),
      (s:string)=>s.replace('version="1.0"','version="2.0"'),
      (s:string)=>s.replace('<rootfiles>','<rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/>'),
      (s:string)=>s.replace('urn:oasis:names:tc:opendocument:xmlns:container','http://evil.invalid/ns'),
      (s:string)=>s.replace('<rootfiles>','<!DOCTYPE container [<!ENTITY x SYSTEM "file:///etc/passwd">]><rootfiles>'),
    ];
    for(const change of cases)denyPackage(changedContainer(change));
  });

  it('rejects doctypes, custom entities, namespace confusion and malformed XML',()=>{
    const cases=[
      (s:string)=>'<!DOCTYPE package [<!ENTITY exploit SYSTEM "file:///etc/passwd">]>'+s,
      (s:string)=>s.replace('<dc:title>','<dc:title>&leak;'),
      (s:string)=>s.replace('<dc:title>','<dc:title>&#x41;'),
      (s:string)=>s.replace('<manifest>','<manifest xmlns="https://evil.invalid/ns">'),
      (s:string)=>s.replace('http://www.idpf.org/2007/opf','https://fake.invalid/opf'),
      (s:string)=>s.replace('unique-identifier="pubid"','unique-identifier="x" unique-identifier="y"'),
      (s:string)=>s.replace('</spine>',''),
      (s:string)=>s.replace('</manifest>','<script>alert(1)</script></manifest>'),
      (s:string)=>s.replace('<item id="style"','<item id="style" xmlns="https://evil.invalid"'),
      (s:string)=>s.replace('<manifest>','<!-- hidden -->'+'<manifest>'),
    ];
    for(const change of cases)denyPackage(changedPackage(change));
  });

  it('rejects OPF manifest missing/duplicate IDs, remote assets and spoofed media types',()=>{
    const cases=[
      (s:string)=>s.replace('id="chapter"','id="nav"'),
      (s:string)=>s.replace('href="chapter.xhtml"','href="nav.xhtml"'),
      (s:string)=>s.replace('href="chapter.xhtml"','href="https://example.org/chapter.xhtml"'),
      (s:string)=>s.replace('href="chapter.xhtml"','href="../chapter.xhtml"'),
      (s:string)=>s.replace('href="chapter.xhtml"','href="chapter.xhtml#fragment"'),
      (s:string)=>s.replace('href="chapter.xhtml"','href="%63hapter.xhtml"'),
      (s:string)=>s.replace('media-type="application/xhtml+xml"','media-type="text/html"'),
      (s:string)=>s.replace('properties="nav"','properties="remote-resources"'),
      (s:string)=>s.replace('properties="nav"','properties="scripted nav"'),
      (s:string)=>s.replace('properties="nav"','properties="nav nav"'),
      (s:string)=>s.replace('<manifest>','<manifest><item id="hidden" href="missing.css" media-type="text/css"/>'),
      (s:string)=>s.replace('<item id="chapter"','<item fallback="nav" id="chapter"'),
    ];
    for(const change of cases)denyPackage(changedPackage(change));
  });

  it('rejects mismatched/ambiguous or unreadable spine sequence references',()=>{
    const cases=[
      (s:string)=>s.replace('idref="chapter"','idref="missing"'),
      (s:string)=>s.replace('idref="chapter"','idref="style"'),
      (s:string)=>s.replace('<itemref idref="chapter" linear="yes"/>',
        '<itemref idref="chapter"/><itemref idref="chapter"/>'),
      (s:string)=>s.replace('linear="yes"','linear="no"'),
      (s:string)=>s.replace('linear="yes"','linear="sometimes"'),
      (s:string)=>s.replace('<itemref idref="chapter" linear="yes"/>',''),
      (s:string)=>s.replace('<itemref idref="chapter"','<itemref script="enabled" idref="chapter"'),
      (s:string)=>s.replace('properties="nav"','properties="cover-image"'),
    ];
    for(const change of cases)denyPackage(changedPackage(change));
  });

  it('rejects ZIP files not accounted for by OPF manifest (and unsafe SVG MIME)',()=>{
    denyPackage(archive([...completePackageEntries(),{
      name:'OPS/hidden.xhtml',content:utf('<html>Unlisted hidden resource</html>'),
    }]));
    const entries=[...completePackageEntries(),{
      name:'OPS/script.svg',content:utf('<svg onload="alert(1)"/>'),
    }];
    const modified=replaceEntry(entries,'OPS/book.opf',s=>s.replace('</manifest>',
      '<item id="script" href="script.svg" media-type="image/svg+xml"/></manifest>'));
    denyPackage(archive(modified));
  });

  it('does not mistake a consistent spine for safe XHTML, prose or publication',()=>{
    const entries=replaceEntry(completePackageEntries(),'OPS/chapter.xhtml',
      ()=>'<html><script>alert("not yet sanitized")</script></html>');
    const result=inspectEpubZipPackageSpine(archive(entries));
    expect(result.status).toBe('package_spine_only');
    expect('readyToPublish' in result).toBe(false);
    expect('spinePaths' in result).toBe(false);
  });

  it('uses a trusted private inode and hash for package/spine inspection only',async()=>{
    const root=await mkdtemp(join(tmpdir(),'folio-epub-package-'));
    try{
      const storage=await LocalStorageAdapter.create(root);
      const owner=randomUUID(),data=archive(completePackageEntries());
      const blob=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},source:Readable.from([data]),
        declaredSha256:sha(data),declaredMime:'application/epub+zip',maxBytes:data.length,
      });
      expect((await storage.inspectEpubPackageSpine(blob)).status).toBe('package_spine_only');
      await expect(storage.inspectEpubPackageSpine({...blob,ownerUserId:randomUUID()}))
        .rejects.toThrow();
      await expect(storage.inspectEpubPackageSpine({...blob,sha256:'f'.repeat(64)}))
        .rejects.toThrow(/source bytes changed/);
      await expect(storage.inspectEpubPackageSpine({...blob,mime:'text/plain'}))
        .rejects.toThrow();
    }finally{await rm(root,{force:true,recursive:true});}
  });
});


/** Separate XHTML fixtures must not weaken the prior relationship-only
 * contract: a CRC-correct unsafe XHTML still passes the earlier OPF gate. */
function completeMarkupEntries():Entry[]{
  let entries=completePackageEntries();
  entries=replaceEntry(entries,'OPS/chapter.xhtml',()=>(
    '<?xml version="1.0" encoding="UTF-8"?>'+
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="tr" lang="tr">'+
    '<head><title>Sentetik Bölüm</title></head>'+
    '<body><section id="start"><h1>Başlık</h1><p>Türkçe &amp; English.</p>'+
    '<p><a href="#start">Başa dön</a></p></section></body></html>'
  ));
  return replaceEntry(entries,'OPS/nav.xhtml',()=>(
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'+
    '<head><title>İçindekiler</title></head>'+
    '<body><nav epub:type="toc"><ol><li>'+
    '<a href="chapter.xhtml#start">Birinci bölüm</a>'+
    '</li></ol></nav></body></html>'
  ));
}
function changeMarkup(name:string,alter:(source:string)=>string):Buffer{
  return archive(replaceEntry(completeMarkupEntries(),name,alter));
}
function denyXhtml(buffer:Buffer){
  expect(inspectEpubZipStructure(buffer).status).toBe('structure_only');
  expect(inspectEpubZipPackageSpine(buffer).status).toBe('package_spine_only');
  expect(()=>inspectEpubZipXhtmlMarkup(buffer)).toThrow(/Unsupported EPUB XHTML/);
}
describe('inert EPUB XHTML source shape and local navigation preflight',()=>{
  it('checks local fragment targets without outputting raw XML, text or paths',()=>{
    const data=archive(completeMarkupEntries());
    const inspected=inspectEpubZipXhtmlMarkup(data);
    expect(inspected).toMatchObject({
      status:'xhtml_markup_only',documentCount:2,navigationDocuments:1,
      localLinks:2,fragmentLinks:2,
    });
    expect(inspected.totalElements).toBeGreaterThan(8);
    const json=JSON.stringify(inspected);
    expect(json).not.toMatch(/chapter\.xhtml|nav\.xhtml|start|Sentetik|Türkçe|verified|safeToRender/);
  });

  it('rejects scripts, active/embedded elements, unsafe attributes and remote links',()=>{
    const htmlCases=[
      (s:string)=>s.replace('<h1>Başlık</h1>','<script>alert(1)</script>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<iframe src="https://evil.invalid"/>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<img src="data:image/png;base64,AA"/>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<svg onload="alert(1)"/>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<math><mi>x</mi></math>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<object data="file:///etc/passwd"/>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<video autoplay src="https://evil.invalid/movie"/>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<form action="https://evil.invalid"/>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<link rel="stylesheet" href="https://evil.invalid/style.css"/>'),
      (s:string)=>s.replace('<h1>Başlık</h1>','<style>@import url(https://evil.invalid)</style>'),
      (s:string)=>s.replace('<p>Türkçe','<p onclick="alert(1)">Türkçe'),
      (s:string)=>s.replace('<p>Türkçe','<p style="background:url(https://evil.invalid)">Türkçe'),
      (s:string)=>s.replace('<p>Türkçe','<p data-evil="1">Türkçe'),
      (s:string)=>s.replace('href="#start"','href="javascript:alert(1)"'),
      (s:string)=>s.replace('href="#start"','href="data:text/html,payload"'),
      (s:string)=>s.replace('href="#start"','href="https://example.invalid/foo.xhtml"'),
      (s:string)=>s.replace('href="#start"','href="//example.invalid/foo.xhtml"'),
      (s:string)=>s.replace('href="#start"','href="../outside.xhtml"'),
      (s:string)=>s.replace('href="#start"','href="%63hapter.xhtml#start"'),
      (s:string)=>s.replace('href="#start"','href="missing.xhtml#start"'),
      (s:string)=>s.replace('href="#start"','href="#missing-id"'),
      (s:string)=>s.replace('href="#start"','href="chapter.xhtml?remote=1#start"'),
      (s:string)=>s.replace('<section id="start">','<section id="start"><p id="start">dup</p>'),
      (s:string)=>s.replace('<p>Türkçe','<p xml:base="https://evil.invalid/">Türkçe'),
      (s:string)=>s.replace('<p>Türkçe','<p xmlns="http://evil.invalid">Türkçe'),
    ];
    for(const change of htmlCases)denyXhtml(changeMarkup('OPS/chapter.xhtml',change));
  });

  it('rejects deceptive XML declarations, XXE, numeric entities, comments and CDATA',()=>{
    const cases=[
      (s:string)=>'<!DOCTYPE html [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'+s,
      (s:string)=>s.replace('Türkçe','&xxe;'),
      (s:string)=>s.replace('Türkçe','&#x3c;script&#x3e;'),
      (s:string)=>s.replace('Türkçe','&not-a-standard-xml-entity;'),
      (s:string)=>s.replace('<body>','<?xml-stylesheet href="https://evil.invalid"?>'+'<body>'),
      (s:string)=>s.replace('<body>','<!-- comment -->'+'<body>'),
      (s:string)=>s.replace('Türkçe','<![CDATA[remote]]>'),
      (s:string)=>s.replace('</section>','</div>'),
      (s:string)=>s.replace('<body>','<body><body>'),
      (s:string)=>s.replace('<html xmlns=','<html xmlns="https://evil.invalid" xmlns='),
      (s:string)=>s.replace('xml:lang="tr"','xml:lang="en"'),
      (s:string)=>s.replace('id="start"','id="start" id="again"'),
      (s:string)=>s.replace('<p>Türkçe','<p class="reader evil:script">Türkçe'),
      (s:string)=>s.replace('<p>Türkçe','<p title="a" title="b">Türkçe'),
    ];
    for(const change of cases)denyXhtml(changeMarkup('OPS/chapter.xhtml',change));
    const malformed=completeMarkupEntries();
    malformed.find(e=>e.name==='OPS/chapter.xhtml')!.content=Buffer.from([0xc3,0x28]);
    denyXhtml(archive(malformed));
  });

  it('rejects missing/forged navigation links and unexpected XHTML namespace',()=>{
    const cases=[
      (s:string)=>s.replace('xmlns:epub="http://www.idpf.org/2007/ops"','xmlns:epub="https://evil.invalid"'),
      (s:string)=>s.replace('xmlns:epub="http://www.idpf.org/2007/ops"',''),
      (s:string)=>s.replace('epub:type="toc"','epub:type="landmarks"'),
      (s:string)=>s.replace('epub:type="toc"','onfocus="alert(1)"'),
      (s:string)=>s.replace('<a href="chapter.xhtml#start">','<a href="https://evil.invalid/chapter.xhtml">'),
      (s:string)=>s.replace('chapter.xhtml#start','chapter.xhtml#missing'),
      (s:string)=>s.replace('chapter.xhtml#start','chapter.xhtml#sta%72t'),
      (s:string)=>s.replace('<ol><li>','<ol>'),
      (s:string)=>s.replace('<li><a','<li><a target="_blank"'),
      (s:string)=>s.replace('<nav epub:type="toc">','<div>'),
      (s:string)=>s.replace('xmlns="http://www.w3.org/1999/xhtml"','xmlns="http://evil.invalid/xhtml"'),
      (s:string)=>s.replace('xmlns:epub="http://www.idpf.org/2007/ops"','xmlns:svg="http://www.w3.org/2000/svg"'),
    ];
    for(const change of cases)denyXhtml(changeMarkup('OPS/nav.xhtml',change));
  });

  it('bounds XHTML document size and nesting depth without extracting source text',()=>{
    const big=completeMarkupEntries();
    big.find(e=>e.name==='OPS/chapter.xhtml')!.content=Buffer.alloc(2*1024*1024+1,'a');
    // Intentionally STORE rather than deflate a 100:1 ratio bomb: this
    // exercises the inner XHTML byte limit independently of the ZIP limit.
    big.find(e=>e.name==='OPS/chapter.xhtml')!.compress=false;
    denyXhtml(archive(big));
    const deep=completeMarkupEntries();
    const nested='<span>'.repeat(66)+'a'+'</span>'.repeat(66);
    deep.find(e=>e.name==='OPS/chapter.xhtml')!.content=utf(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head>'+
      '<body>'+nested+'</body></html>');
    deep.find(e=>e.name==='OPS/chapter.xhtml')!.compress=false;
    denyXhtml(archive(deep));
  });

  it('does NOT approve malicious CSS despite inert XHTML relationship success',()=>{
    const entries=replaceEntry(completeMarkupEntries(),'OPS/style.css',
      ()=>"@import url('https://evil.invalid/font.css');");
    const result=inspectEpubZipXhtmlMarkup(archive(entries));
    expect(result.status).toBe('xhtml_markup_only');
    expect('cssApproved' in result).toBe(false);
    expect('safeToRender' in result).toBe(false);
  });

  it('requires source owner/mode/digest; no bytes can be returned through inspector',async()=>{
    const root=await mkdtemp(join(tmpdir(),'folio-epub-xhtml-'));
    try{
      const storage=await LocalStorageAdapter.create(root);
      const owner=randomUUID(),data=archive(completeMarkupEntries());
      const blob=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([data]),declaredSha256:sha(data),
        declaredMime:'application/epub+zip',maxBytes:data.length,
      });
      expect((await storage.inspectEpubXhtmlMarkup(blob)).status).toBe('xhtml_markup_only');
      await expect(storage.inspectEpubXhtmlMarkup({...blob,ownerUserId:randomUUID()}))
        .rejects.toThrow();
      await expect(storage.inspectEpubXhtmlMarkup({...blob,sha256:'f'.repeat(64)}))
        .rejects.toThrow(/source bytes changed/);
      await expect(storage.inspectEpubXhtmlMarkup({...blob,mime:'text/plain'})).rejects.toThrow();
    }finally{await rm(root,{recursive:true,force:true});}
  });
});


describe('EPUB CSS-only quarantine lexical gate (no rendering approval)',()=>{
  const withCss=(value:string)=>archive(
    replaceEntry(completeMarkupEntries(),'OPS/style.css',()=>value));

  it('accepts a bounded inert CSS subset with aggregate counts only',()=>{
    const bytes=withCss('body { margin: 1em; color: #123; }\np { text-align: justify; font-weight: bold; line-height: 1.4; }');
    expect(inspectEpubZipXhtmlMarkup(bytes).status).toBe('xhtml_markup_only');
    const result=inspectEpubZipCssResources(bytes);
    expect(result).toMatchObject({
      status:'css_resources_only',stylesheetCount:1,ruleCount:2,declarationCount:5,
    });
    expect(result.stylesheetBytes).toBeGreaterThan(30);
    expect(JSON.stringify(result)).not.toMatch(/style\.css|chapter\.xhtml|body|margin|verified|render/i);
  });

  it('denies imports, URL functions, comments, escapes and complex or dangerous grammar',()=>{
    const unsafe=[
      "@import url('https://evil.invalid/exfil.css');",
      'body { background: url(https://evil.invalid/tracker); }',
      'body { background-image: url(data:image/png;base64,AA); }',
      '@font-face { font-family: remote; src: url(https://evil.invalid/font.woff2); }',
      'body { color: #fff; } /* hidden import */',
      'body { color: #fff !important; }',
      'body { color: red; }',
      'body { font-family: "remote"; }',
      'body { margin: calc(1em + 1px); }',
      'body { margin: 1em; margin: 2em; }',
      'body { position: fixed; }',
      'body { color: #fff; background: transparent; }',
      'body:hover { color: #fff; }',
      'body[data-x] { color: #fff; }',
      '* { color: #fff; }',
      'body { color: #fff; } }',
      'body { color: #fff; } @supports (display: grid) {}',
      'body { color: \\23fff; }',
      'body { color: #fff; }\u00a0',
      'body { color: #fff; }\x00',
      'body { color: #fff; } <style>',
    ];
    for(const css of unsafe){
      const bytes=withCss(css);
      expect(inspectEpubZipXhtmlMarkup(bytes).status).toBe('xhtml_markup_only');
      expect(()=>inspectEpubZipCssResources(bytes),css.slice(0,60))
        .toThrow(/Unsupported EPUB CSS/);
    }
  });

  it('denies invalid UTF-8 and oversized stylesheet bytes',()=>{
    const invalidUtf8=completeMarkupEntries().map(e=>e.name==='OPS/style.css'
      ?{...e,content:Buffer.from([0xc3,0x28])}:e);
    expect(()=>inspectEpubZipCssResources(archive(invalidUtf8)))
      .toThrow(/Unsupported EPUB CSS/);
    const oversized=completeMarkupEntries().map(e=>e.name==='OPS/style.css'
      ?{...e,content:Buffer.alloc(64*1024+1,'x'),compress:false}:e);
    expect(()=>inspectEpubZipCssResources(archive(oversized))).toThrow();
  });

  it('returns zero styling evidence only for genuinely CSS-free OPF manifest',()=>{
    const entries=completeMarkupEntries().filter(e=>e.name!=='OPS/style.css');
    const noCss=replaceEntry(entries,'OPS/book.opf',s=>
      s.replace('<item id="style" href="style.css" media-type="text/css"/>',''));
    expect(inspectEpubZipCssResources(archive(noCss))).toEqual({
      status:'css_resources_only',stylesheetCount:0,stylesheetBytes:0,
      ruleCount:0,declarationCount:0,
    });
  });

  it('requires private owner, digest and pending metadata; no raw CSS returned',async()=>{
    const root=await mkdtemp(join(tmpdir(),'folio-epub-css-'));
    try{
      const storage=await LocalStorageAdapter.create(root);
      const owner=randomUUID(),data=withCss('p { color: #abc; }');
      const blob=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([data]),declaredSha256:sha(data),
        declaredMime:'application/epub+zip',maxBytes:data.length,
      });
      const result=await storage.inspectEpubCssResources(blob);
      expect(result.status).toBe('css_resources_only');
      expect(JSON.stringify(result)).not.toContain('#abc');
      await expect(storage.inspectEpubCssResources({...blob,ownerUserId:randomUUID()}))
        .rejects.toThrow();
      await expect(storage.inspectEpubCssResources({...blob,sha256:'f'.repeat(64)}))
        .rejects.toThrow(/source bytes changed/);
      await expect(storage.inspectEpubCssResources({...blob,status:'verified' as 'pending_verify'}))
        .rejects.toThrow(/pending|quarantined/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});


/** Independent PNG/ZIP synthetic negative corpus, no third-party book assets. */
function makePngChunk(type:string,payload:Buffer):Buffer{
  const tag=Buffer.from(type,'ascii');
  const size=Buffer.alloc(4);size.writeUInt32BE(payload.length);
  const sum=Buffer.alloc(4);sum.writeUInt32BE(crc32(Buffer.concat([tag,payload])));
  return Buffer.concat([size,tag,payload,sum]);
}
function testPng(options:{filter?:number;colorType?:number;
  width?:number;height?:number;compressed?:Buffer}={}):Buffer{
  const width=options.width??1,height=options.height??1;
  const hdr=Buffer.alloc(13);
  hdr.writeUInt32BE(width,0);hdr.writeUInt32BE(height,4);
  hdr[8]=8;hdr[9]=options.colorType??6;
  const pixel=Buffer.from([options.filter??0,120,140,160,255]);
  const compressed=options.compressed??deflateSync(pixel);
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    makePngChunk('IHDR',hdr),
    makePngChunk('IDAT',compressed),
    makePngChunk('IEND',Buffer.alloc(0)),
  ]);
}
function embeddedMedia(
  payload:Buffer,filename='cover.png',mime='image/png',
):Buffer{
  const path='OPS/'+filename;
  const entries=replaceEntry(completeMarkupEntries(),'OPS/book.opf',
    original=>original.replace('</manifest>',
      '<item id="binary" href="'+filename+'" media-type="'+mime+'"/></manifest>'));
  return archive([...entries,{name:path,content:payload}]);
}
function denyPngResource(bytes:Buffer):void{
  expect(inspectEpubZipStructure(bytes).status).toBe('structure_only');
  expect(inspectEpubZipPackageSpine(bytes).status).toBe('package_spine_only');
  expect(inspectEpubZipXhtmlMarkup(bytes).status).toBe('xhtml_markup_only');
  expect(inspectEpubZipCssResources(bytes).status).toBe('css_resources_only');
  expect(()=>inspectEpubZipPngResources(bytes)).toThrow(/Unsupported EPUB embedded binary/);
}

describe('EPUB bounded PNG structure + explicit font/other-binary quarantine denial',()=>{
  it('accepts only inert small PNG structural evidence, with no source/path/verification',()=>{
    const bytes=embeddedMedia(testPng());
    expect(inspectEpubZipPngResources(bytes)).toEqual({
      status:'png_structure_only',imageCount:1,
      imageBytes:testPng().length,totalPixels:1,
    });
    expect(JSON.stringify(inspectEpubZipPngResources(bytes)))
      .not.toMatch(/cover\.png|OPS|verified|safeToRender|font|raw/i);
  });

  it('permits an EPUB with no OPF binary assets, but does not approve a renderer',()=>{
    const result=inspectEpubZipPngResources(archive(completeMarkupEntries()));
    expect(result).toEqual({
      status:'png_structure_only',imageCount:0,imageBytes:0,totalPixels:0,
    });
    expect('safeToRender' in result).toBe(false);
  });

  it('rejects CRC failures, bad magic, truncation, appended bytes and extra chunks',()=>{
    const good=testPng();
    const badCrc=Buffer.from(good);badCrc[badCrc.length-1]!^=1;
    const badMagic=Buffer.from(good);badMagic[0]=0;
    const cases=[
      badCrc,badMagic,good.subarray(0,-1),
      Buffer.concat([good,Buffer.from('extra')]),
      Buffer.concat([good.subarray(0,33),
        makePngChunk('tEXt',Buffer.from('title=private')),
        good.subarray(33)]),
      Buffer.concat([good.subarray(0,33),
        makePngChunk('acTL',Buffer.from([0,0,0,1,0,0,0,0])),
        good.subarray(33)]),
      Buffer.concat([good.subarray(0,33),
        makePngChunk('iCCP',Buffer.from('untrusted')),
        good.subarray(33)]),
    ];
    for(const data of cases)denyPngResource(embeddedMedia(data));
  });

  it('rejects oversized or impossible dimensions, palette/color, interlace and row filters',()=>{
    const original=testPng();
    const wrongSize=Buffer.from(original);
    wrongSize.writeUInt32BE(70000,16);
    wrongSize.writeUInt32BE(crc32(wrongSize.subarray(12,29)),29);
    for(const raw of [
      testPng({width:0}),testPng({width:2049}),
      testPng({colorType:3}),testPng({filter:5}),wrongSize,
    ])denyPngResource(embeddedMedia(raw));
    const interlaced=Buffer.from(original);
    interlaced[28]=1;
    interlaced.writeUInt32BE(crc32(interlaced.subarray(12,29)),29);
    denyPngResource(embeddedMedia(interlaced));
  });

  it('rejects malformed, appended or double zlib streams in PNG IDAT',()=>{
    const row=Buffer.from([0,120,140,160,255]);
    const compressed=deflateSync(row);
    const malformed=Buffer.from(compressed);
    malformed[0]=0;
    for(const compressedIdat of [
      malformed,
      Buffer.concat([compressed,Buffer.from([0,1,2])]),
      Buffer.concat([compressed,compressed]),
      deflateSync(Buffer.from([0,1,2])),
    ])denyPngResource(embeddedMedia(testPng({compressed:compressedIdat})));
  });

  it('rejects uninspected GIF/JPEG/WebP/font and NCX even if OPF MIME matches',()=>{
    for(const [name,mime,body] of [
      ['cover.jpg','image/jpeg',testPng()],
      ['cover.gif','image/gif',Buffer.from('GIF89a','ascii')],
      ['cover.webp','image/webp',Buffer.from('RIFFxxxxWEBP','ascii')],
      ['font.ttf','font/ttf',Buffer.from([0,1,0,0,0,1,0,0])],
      ['font.otf','font/otf',Buffer.from('OTTO','ascii')],
      ['font.woff','font/woff',Buffer.from('wOFF','ascii')],
      ['font.woff2','font/woff2',Buffer.from('wOF2','ascii')],
      ['nav.ncx','application/x-dtbncx+xml',Buffer.from('<ncx/>','utf8')],
    ] as const)denyPngResource(embeddedMedia(body,name,mime));
  });

  it('fails closed on too many otherwise valid PNG assets',()=>{
    const png=testPng();
    const additions=Array.from({length:17},(_,i)=>({
      name:'OPS/p'+i+'.png',content:png,
    }));
    let entries=completeMarkupEntries();
    entries=replaceEntry(entries,'OPS/book.opf',s=>s.replace('</manifest>',
      additions.map((_,i)=>'<item id="png'+i+'" href="p'+i+'.png" media-type="image/png"/>').join('')+'</manifest>'));
    denyPngResource(archive([...entries,...additions]));
  });

  it('requires already clean XHTML and CSS gates before checking an image',()=>{
    const entries=replaceEntry(completeMarkupEntries(),'OPS/style.css',
      ()=>"@import url('https://evil.invalid/styles.css');");
    const withPng=replaceEntry(entries,'OPS/book.opf',s=>
      s.replace('</manifest>','<item id="img" href="cover.png" media-type="image/png"/></manifest>'));
    expect(()=>inspectEpubZipPngResources(archive([
      ...withPng,{name:'OPS/cover.png',content:testPng()},
    ]))).toThrow(/Unsupported EPUB CSS/);
  });

  it('allows only private owner-matched, SHA-valid pending media inspection',async()=>{
    const root=await mkdtemp(join(tmpdir(),'folio-epub-png-'));
    try{
      const storage=await LocalStorageAdapter.create(root);
      const owner=randomUUID(),data=embeddedMedia(testPng());
      const blob=await storage.stage({
        owner:{scope:'private-user',ownerUserId:owner},
        source:Readable.from([data]),declaredSha256:sha(data),
        declaredMime:'application/epub+zip',maxBytes:data.length,
      });
      expect((await storage.inspectEpubPngResources(blob)).imageCount).toBe(1);
      await expect(storage.inspectEpubPngResources({...blob,ownerUserId:randomUUID()}))
        .rejects.toThrow();
      await expect(storage.inspectEpubPngResources({...blob,sha256:'f'.repeat(64)}))
        .rejects.toThrow(/source bytes changed/);
      await expect(storage.inspectEpubPngResources({...blob,mime:'text/plain'}))
        .rejects.toThrow();
      await expect(storage.inspectEpubPngResources({...blob,status:'verified' as 'pending_verify'}))
        .rejects.toThrow(/quarantined|pending/i);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
