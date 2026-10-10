import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {deflateRawSync} from 'node:zlib';
import {describe,expect,it} from 'vitest';
import {inspectEpubZipStructure,EPUB_ZIP_PREFLIGHT_MAX_BYTES} from './epub-structure.js';
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
