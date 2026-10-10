import {TextDecoder} from 'node:util';
import {inflateRawSync} from 'node:zlib';
import {inspectEpubPackageSpine,inspectEpubPackageSpineDetails} from './epub-package.js';
import {inspectEpubXhtmlMarkup} from './epub-xhtml.js';
import type {EpubXhtmlMarkupResult} from './epub-xhtml.js';
import type {EpubPackageSpineResult} from './epub-package.js';

/**
 * Conservative EPUB OCF ZIP *structure* admission, not an EPUB parser.
 * No content/spine reading order, scripting, CSS, XHTML sanitization,
 * extracted text, DRM rights, AV verdict, verified state or publication.
 * Ambiguous ZIP features fail closed, including ZIP64 and appended members.
 */
export const EPUB_ZIP_PREFLIGHT_MAX_BYTES=16*1024*1024;
export const EPUB_ZIP_PREFLIGHT_MAX_ENTRIES=512;
const MAX_ENTRY_BYTES=8*1024*1024;
const MAX_EXPANDED_BYTES=32*1024*1024;
const MAX_RATIO=100;
const MAX_NAME_BYTES=256;
const MAX_EXTRA_BYTES=1024;
const utf8=new TextDecoder('utf-8',{fatal:true});
const SIG_LOCAL=0x04034b50;
const SIG_CENTRAL=0x02014b50;
const SIG_END=0x06054b50;
const SIG_DESCRIPTOR=0x08074b50;
const OCF_MIME='application/epub+zip';

export interface EpubZipStructuralResult {
  status:'structure_only';
  entryCount:number;
  expandedBytes:number;
  hasContainer:true;
  hasPackage:true;
  hasXhtml:true;
}

interface Member {
  name:string;
  nameBytes:Buffer;
  localOffset:number;
  flags:number;
  method:number;
  crc:number;
  compressed:number;
  expanded:number;
}
function invalid():never {throw new Error('Unsupported EPUB ZIP structure');}
function within(buffer:Buffer,from:number,length:number):boolean{
  return Number.isSafeInteger(from)&&Number.isSafeInteger(length)&&
    from>=0&&length>=0&&from+length<=buffer.length;
}
function extrasSafe(bytes:Buffer):boolean{
  if(bytes.length>MAX_EXTRA_BYTES)return false;
  let offset=0;
  while(offset<bytes.length){
    if(offset+4>bytes.length)return false;
    const tag=bytes.readUInt16LE(offset),size=bytes.readUInt16LE(offset+2);
    offset+=4;
    // Reject ZIP64 and Unicode-path overrides; prevent path ambiguity.
    if(tag===0x0001||tag===0x7075||offset+size>bytes.length)return false;
    offset+=size;
  }
  return offset===bytes.length;
}
function readName(raw:Buffer,flags:number):string {
  if(raw.length===0||raw.length>MAX_NAME_BYTES)return invalid();
  if((flags&0x800)===0&&raw.some(c=>c>0x7f))return invalid();
  let name:string;
  try{name=utf8.decode(raw);}catch{return invalid();}
  if(name.normalize('NFC')!==name||name.startsWith('/')||
    name.includes('\\')||name.includes(':')||name.includes('%')||
    [...name].some(ch=>{const n=ch.charCodeAt(0);return n<=31||n===127;}))return invalid();
  const folder=name.endsWith('/');
  const segments=(folder?name.slice(0,-1):name).split('/');
  if(segments.some(s=>!s||s==='.'||s==='..'))return invalid();
  if(/\.(?:epub|zip|rar|7z|tar|gz)$/i.test(name))return invalid();
  return name;
}
function crc32(data:Buffer):number{
  let crc=0xffffffff;
  for(const byte of data){
    crc^=byte;
    for(let bit=0;bit<8;bit++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;
  }
  return (crc^0xffffffff)>>>0;
}
/** Validate a bounded byte buffer WITHOUT extracting files or trusting
 * central-directory size claims. Re-check every local header, compressed
 * range, descriptor, CRC32 and continuous offset. Deflate is bounded by
 * maxOutputLength and a cumulative expansion ceiling.
 *
 * Deliberately rejects archives requiring ZIP64, archive comments, unknown
 * flag bits, native symlinks, duplicate/case-ambiguous or traversal names,
 * multi-disk archives, nested archives, rights/encryption.xml and input bombs.
 * A passing result is not a safe-to-render or safe-to-publish conclusion.
 */
/**
 * Existing structural API is deliberately unchanged, including its loose
 * EPUB XML semantics. The separate package/spine gate is opt-in and NEVER
 * marks a private source verified or makes it available for rendering.
 */
export function inspectEpubZipStructure(bytes:Buffer):EpubZipStructuralResult{
  return validatedZip(bytes).result;
}
export function inspectEpubZipPackageSpine(bytes:Buffer):EpubPackageSpineResult{
  const archive=validatedZip(bytes);
  return inspectEpubPackageSpine(archive.entries);
}
/** Third independent, fail-closed quarantine observation. This only verifies
 * XHTML structural/active-markup absence and local link *syntax* for the
 * previously validated OCF/OPF manifest. Neither readable nor publishable. */
export function inspectEpubZipXhtmlMarkup(bytes:Buffer):EpubXhtmlMarkupResult{
  const archive=validatedZip(bytes);
  const details=inspectEpubPackageSpineDetails(archive.entries);
  return inspectEpubXhtmlMarkup(
    archive.entries,details.xhtmlPaths,details.navigationPath);
}
function validatedZip(bytes:Buffer):{
  result:EpubZipStructuralResult;entries:ReadonlyMap<string,Buffer>
}{
  if(!Buffer.isBuffer(bytes)||bytes.length<80||
    bytes.length>EPUB_ZIP_PREFLIGHT_MAX_BYTES)return invalid();
  // Exact OCF first local member: uncompressed first "mimetype" with no
  // extra data, descriptor or encryption (W3C EPUB 3 OCF).
  if(!within(bytes,0,58)||bytes.readUInt32LE(0)!==SIG_LOCAL||
    bytes.readUInt16LE(6)!==0||bytes.readUInt16LE(8)!==0||
    bytes.readUInt32LE(18)!==20||bytes.readUInt32LE(22)!==20||
    bytes.readUInt16LE(26)!==8||bytes.readUInt16LE(28)!==0||
    bytes.toString('ascii',30,38)!=='mimetype'||
    bytes.toString('ascii',38,58)!==OCF_MIME)return invalid();

  // No ZIP commentary, suffix bytes, multidisk layout or ZIP64 tail.
  const end=bytes.length-22;
  if(bytes.readUInt32LE(end)!==SIG_END||
    bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0||
    bytes.readUInt16LE(end+20)!==0)return invalid();
  const count=bytes.readUInt16LE(end+10);
  const centralSize=bytes.readUInt32LE(end+12);
  const centralOffset=bytes.readUInt32LE(end+16);
  if(count<4||count>EPUB_ZIP_PREFLIGHT_MAX_ENTRIES||
    count!==bytes.readUInt16LE(end+8)||
    centralOffset<58||!within(bytes,centralOffset,centralSize)||
    centralOffset+centralSize!==end)return invalid();

  const entries=new Map<string,Buffer>();
  const members:Member[]=[];
  const known=new Set<string>();
  let cursor=centralOffset,totalExpanded=0;
  for(let idx=0;idx<count;idx++){
    if(cursor+46>centralOffset+centralSize||
      bytes.readUInt32LE(cursor)!==SIG_CENTRAL)return invalid();
    const version=bytes.readUInt16LE(cursor+6),flags=bytes.readUInt16LE(cursor+8);
    const method=bytes.readUInt16LE(cursor+10);
    const crc=bytes.readUInt32LE(cursor+16);
    const compressed=bytes.readUInt32LE(cursor+20);
    const expanded=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28);
    const extraLength=bytes.readUInt16LE(cursor+30);
    const commentLength=bytes.readUInt16LE(cursor+32);
    const disk=bytes.readUInt16LE(cursor+34);
    const externalMode=(bytes.readUInt32LE(cursor+38)>>>16)&0xf000;
    const localOffset=bytes.readUInt32LE(cursor+42);
    const recordSize=46+nameLength+extraLength+commentLength;
    if(version>45||(flags&~0x808)!==0||(method!==0&&method!==8)||
      disk!==0||commentLength!==0||!within(bytes,cursor,recordSize)||
      cursor+recordSize>centralOffset+centralSize||
      localOffset>=centralOffset||externalMode===0xa000||
      (externalMode!==0&&externalMode!==0x8000&&externalMode!==0x4000)||
      nameLength>MAX_NAME_BYTES||
      compressed>EPUB_ZIP_PREFLIGHT_MAX_BYTES||
      expanded>MAX_ENTRY_BYTES||expanded>Math.max(1,compressed)*MAX_RATIO||
      (method===0&&compressed!==expanded))return invalid();
    const nameBytes=bytes.subarray(cursor+46,cursor+46+nameLength);
    const name=readName(nameBytes,flags);
    const extra=bytes.subarray(cursor+46+nameLength,cursor+46+nameLength+extraLength);
    if(!extrasSafe(extra))return invalid();
    if(name.endsWith('/')&&(compressed!==0||expanded!==0||method!==0))return invalid();
    if(/^META-INF\/(?:encryption|rights)\.xml$/i.test(name))return invalid();
    const canonical=name.toLocaleLowerCase('en-US');
    if(known.has(canonical))return invalid();
    known.add(canonical);
    totalExpanded+=expanded;
    if(totalExpanded>MAX_EXPANDED_BYTES)return invalid();
    members.push({name,nameBytes,localOffset,flags,method,crc,compressed,expanded});
    cursor+=recordSize;
  }
  if(cursor!==centralOffset+centralSize)return invalid();
  const ordered=members.sort((a,b)=>a.localOffset-b.localOffset);
  let expectedOffset=0;
  for(const member of ordered){
    const pos=member.localOffset;
    if(pos!==expectedOffset||!within(bytes,pos,30)||
      bytes.readUInt32LE(pos)!==SIG_LOCAL)return invalid();
    const version=bytes.readUInt16LE(pos+4);
    const flags=bytes.readUInt16LE(pos+6);
    const method=bytes.readUInt16LE(pos+8);
    const storedCrc=bytes.readUInt32LE(pos+14);
    const storedComp=bytes.readUInt32LE(pos+18);
    const storedExp=bytes.readUInt32LE(pos+22);
    const nameLength=bytes.readUInt16LE(pos+26);
    const extraLength=bytes.readUInt16LE(pos+28);
    const dataOffset=pos+30+nameLength+extraLength;
    if(version>45||flags!==member.flags||method!==member.method||
      nameLength!==member.nameBytes.length||!within(bytes,pos,30+nameLength+extraLength)||
      !bytes.subarray(pos+30,pos+30+nameLength).equals(member.nameBytes)||
      !extrasSafe(bytes.subarray(pos+30+nameLength,dataOffset))) {
      // The data-descriptor checks are below; avoid silently trusting
      // compressed/uncompressed size claims from the local ZIP header.
      return invalid();
    }
    if((flags&8)===0){
      if(storedCrc!==member.crc||
        storedComp!==member.compressed||storedExp!==member.expanded)return invalid();
    }else if((storedCrc!==0&&storedCrc!==member.crc)||
      (storedComp!==0&&storedComp!==member.compressed)||
      (storedExp!==0&&storedExp!==member.expanded))return invalid();
    const dataEnd=dataOffset+member.compressed;
    if(dataEnd>centralOffset||!within(bytes,dataOffset,member.compressed))return invalid();
    const packed=bytes.subarray(dataOffset,dataEnd);
    let unpacked:Buffer;
    if(member.method===0)unpacked=packed;
    else{
      try{
        unpacked=inflateRawSync(packed,{maxOutputLength:member.expanded+1});
      }catch{return invalid();}
    }
    if(unpacked.length!==member.expanded||crc32(unpacked)!==member.crc)return invalid();
    entries.set(member.name,unpacked);
    expectedOffset=dataEnd;
    if((flags&8)!==0){
      if(member.name==='mimetype')return invalid();
      const hasSignature=within(bytes,expectedOffset,4)&&
        bytes.readUInt32LE(expectedOffset)===SIG_DESCRIPTOR;
      if(hasSignature)expectedOffset+=4;
      if(expectedOffset+12>centralOffset||
        bytes.readUInt32LE(expectedOffset)!==member.crc||
        bytes.readUInt32LE(expectedOffset+4)!==member.compressed||
        bytes.readUInt32LE(expectedOffset+8)!==member.expanded)return invalid();
      expectedOffset+=12;
    }
  }
  if(expectedOffset!==centralOffset||
    ordered[0]?.name!=='mimetype'||ordered[0].localOffset!==0||
    !known.has('meta-inf/container.xml')||
    !members.some(m=>m.name.toLowerCase().endsWith('.opf'))||
    !members.some(m=>/\.xhtml$/i.test(m.name)))return invalid();
  return {result:{status:'structure_only',entryCount:count,expandedBytes:totalExpanded,
    hasContainer:true,hasPackage:true,hasXhtml:true},entries};
}
