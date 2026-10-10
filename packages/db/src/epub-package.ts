import {TextDecoder} from 'node:util';

/**
 * Very small, fail-closed XML subset for EPUB OCF/OPF *metadata only*.
 * NEVER feed XHTML to this parser or render/extract book text with it.
 * It rejects external entities, DTDs, custom entities, CDATA, comments,
 * processing instructions, namespace rebinding and ambiguous constructs.
 * This is a conservative gate, NOT a generic conforming XML parser.
 */
const decoder=new TextDecoder('utf-8',{fatal:true});
const MAX_XML_BYTES=256*1024;
const MAX_NODES=1024;
const MAX_DEPTH=16;
const MAX_TAG_LENGTH=8192;
const CONTAINER_NS='urn:oasis:names:tc:opendocument:xmlns:container';
const PACKAGE_NS='http://www.idpf.org/2007/opf';
const OEBPS_MIME='application/oebps-package+xml';
const XML_NAME=/^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const ID=/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export type EpubPackageSpineResult={
  status:'package_spine_only';
  packageCount:1;
  manifestItems:number;
  spineItems:number;
  linearSpineItems:number;
  navigationCount:1;
};
type Node={
  name:string;
  attrs:Map<string,string>;
  children:Node[];
};
function invalid():never{throw new Error('Unsupported EPUB package/spine metadata');}
function safeEntities(value:string):void{
  // Only the five built-in XML entities; no numeric/custom/recursive entities.
  if(value.replace(/&(amp|lt|gt|quot|apos);/g,'').includes('&'))invalid();
}
function attributes(text:string):Map<string,string>{
  const attrs=new Map<string,string>();
  let rest=text;
  while(rest.length){
    if(/^\s+$/.test(rest))break;
    const match=/^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
    if(!match)invalid();
    const name=match[1]!;
    const value=match[2]??match[3]??'';
    if(!XML_NAME.test(name)||attrs.has(name)||value.length>2048)invalid();
    safeEntities(value);
    attrs.set(name,value.replace(/&(amp|lt|gt|quot|apos);/g,(_,entity:string)=>
      ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[entity]!));
    rest=rest.slice(match[0].length);
  }
  return attrs;
}
function parseXml(raw:Buffer):Node{
  if(raw.length===0||raw.length>MAX_XML_BYTES)invalid();
  let source:string;
  try{source=decoder.decode(raw);}catch{return invalid();}
  if(source.charCodeAt(0)===0xfeff)source=source.slice(1);
  for(const c of source){
    const n=c.charCodeAt(0);
    if((n<32&&n!==9&&n!==10&&n!==13)||n===127)invalid();
  }
  if(source.startsWith('<?xml')){
    const declaration=/^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])UTF-8\2)?\s*\?>/.exec(source);
    if(!declaration)invalid();
    source=source.slice(declaration[0].length);
  }
  const stack:Node[]=[];
  let root:Node|undefined;
  let cursor=0,count=0;
  while(cursor<source.length){
    const start=source.indexOf('<',cursor);
    const text=source.slice(cursor,start<0?source.length:start);
    safeEntities(text);
    if(text.includes(']]>')||(!stack.length&&text.trim().length>0))invalid();
    if(start<0)break;
    const end=source.indexOf('>',start+1);
    if(end<0||end-start>MAX_TAG_LENGTH)invalid();
    const tag=source.slice(start,end+1);
    if(tag.startsWith('</')){
      const close=/^<\/([A-Za-z_][A-Za-z0-9_.:-]*)\s*>$/.exec(tag);
      if(!close||!stack.length||stack.pop()!.name!==close[1])invalid();
    }else{
      const match=/^<([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*?)(\/?)>$/.exec(tag);
      if(!match||match[2]!.includes('<'))invalid();
      const attrs=attributes(match[2]!);
      // Prevent an inner XML element from changing the default namespace of
      // the security-relevant container/package/manifest/spine names.
      if(attrs.has('xml:base')||attrs.has('xlink:href'))invalid();
      if(stack.length>0&&attrs.has('xmlns'))invalid();
      const node:Node={name:match[1]!,attrs,children:[]};
      count++;
      if(count>MAX_NODES||stack.length>=MAX_DEPTH)invalid();
      if(stack.length)stack[stack.length-1]!.children.push(node);
      else{
        if(root)invalid();
        root=node;
      }
      if(match[3]!=='/')stack.push(node);
    }
    cursor=end+1;
  }
  if(stack.length||!root)invalid();
  return root;
}
function children(parent:Node,name:string):Node[]{
  return parent.children.filter(c=>c.name===name);
}
function onlyOne(parent:Node,name:string):Node {
  const all=children(parent,name);
  if(all.length!==1)return invalid();
  return all[0]!;
}
function requireAttr(node:Node,name:string):string {
  const value=node.attrs.get(name);
  if(typeof value!=='string'||!value)return invalid();
  return value;
}
function noChild(node:Node):void{
  if(node.children.length!==0)invalid();
}
function safePath(value:string):void{
  if(!value||value.length>256||value.startsWith('/')||
    value.includes('\\')||value.includes(':')||value.includes('%')||
    value.includes('?')||value.includes('#')||
    [...value].some(c=>{const n=c.charCodeAt(0);return n<=31||n===127;}))invalid();
  if(value.normalize('NFC')!==value||
    value.split('/').some(s=>!s||s==='.'||s==='..'))invalid();
}
function tokens(value:string):string[]{
  const pieces=value.trim()?value.trim().split(/\s+/):[];
  if(new Set(pieces).size!==pieces.length)return invalid();
  return pieces;
}
function formatMatches(name:string,mime:string):boolean{
  const supported:Record<string,string[]>={
    '.xhtml':['application/xhtml+xml'],
    '.css':['text/css'],
    '.jpg':['image/jpeg'],
    '.jpeg':['image/jpeg'],
    '.png':['image/png'],
    '.gif':['image/gif'],
    '.webp':['image/webp'],
    '.otf':['font/otf','application/vnd.ms-opentype'],
    '.ttf':['font/ttf'],
    '.woff':['font/woff'],
    '.woff2':['font/woff2'],
    '.ncx':['application/x-dtbncx+xml'],
  };
  const suffix=name.slice(name.lastIndexOf('.')).toLowerCase();
  return (supported[suffix]??[]).includes(mime);
}
/**
 * The caller MUST provide a fully ZIP-validated, CRC-checked, bounded map of
 * decompressed entries from the private quarantine OCF inspector. No external
 * resource loading, raw XML return, chapter extraction, read API or publication.
 *
 * Exact relative references are deliberately stricter than full EPUB URL
 * handling: percent escapes, fragments, parent traversal, multiple renditions,
 * unsupported media/fallbacks or active properties are rejected.
 */
export function inspectEpubPackageSpine(entries:ReadonlyMap<string,Buffer>):EpubPackageSpineResult{
  const containerBytes=entries.get('META-INF/container.xml');
  if(!containerBytes)return invalid();
  const container=parseXml(containerBytes);
  if(container.name!=='container'||container.attrs.get('xmlns')!==CONTAINER_NS||
    container.attrs.get('version')!=='1.0'||
    container.children.length!==1)return invalid();
  const rootfiles=onlyOne(container,'rootfiles');
  if(rootfiles.children.length!==1)return invalid(); // no rendition ambiguity
  const rootfile=onlyOne(rootfiles,'rootfile');
  noChild(rootfile);
  if(requireAttr(rootfile,'media-type')!==OEBPS_MIME)return invalid();
  const opfPath=requireAttr(rootfile,'full-path');
  safePath(opfPath);
  if(!opfPath.toLowerCase().endsWith('.opf')||opfPath.startsWith('META-INF/'))invalid();
  const opfBytes=entries.get(opfPath);
  if(!opfBytes)return invalid();
  const opf=parseXml(opfBytes);
  if(opf.name!=='package'||opf.attrs.get('xmlns')!==PACKAGE_NS||
    opf.attrs.get('version')!=='3.0'||opf.children.length!==3||
    opf.children[0]!.name!=='metadata'||
    opf.children[1]!.name!=='manifest'||
    opf.children[2]!.name!=='spine')return invalid();
  const manifest=onlyOne(opf,'manifest'),spine=onlyOne(opf,'spine');
  const declared=manifest.children;
  if(declared.length<2||declared.length>256)return invalid();
  const itemIds=new Map<string,{path:string,mime:string,nav:boolean}>();
  const referencedPaths=new Set<string>();
  const rootDir=opfPath.includes('/')?opfPath.slice(0,opfPath.lastIndexOf('/')+1):'';
  let navCount=0;
  for(const item of declared){
    if(item.name!=='item')invalid();
    noChild(item);
    if([...item.attrs.keys()].some(key=>!['id','href','media-type','properties'].includes(key)))invalid();
    const id=requireAttr(item,'id'),href=requireAttr(item,'href');
    const mime=requireAttr(item,'media-type');
    if(!ID.test(id)||itemIds.has(id))invalid();
    safePath(href);
    const path=rootDir+href;
    safePath(path);
    if(path.startsWith('META-INF/')||!entries.has(path)||!formatMatches(path,mime)||
      referencedPaths.has(path)||path===opfPath)return invalid();
    const properties=tokens(item.attrs.get('properties')??'');
    if(properties.some(t=>!['nav','cover-image'].includes(t)))invalid();
    const nav=properties.includes('nav');
    if(nav&&mime!=='application/xhtml+xml')invalid();
    if(properties.includes('cover-image')&&!mime.startsWith('image/'))invalid();
    if(nav)navCount++;
    itemIds.set(id,{path,mime,nav});
    referencedPaths.add(path);
  }
  if(navCount!==1)return invalid();
  // Do not ignore hidden/unlisted XHTML, scripts or arbitrary ZIP entries.
  for(const path of entries.keys()){
    if(path==='mimetype'||path==='META-INF/container.xml'||path===opfPath||
      path.endsWith('/'))continue;
    if(!referencedPaths.has(path))invalid();
  }
  const sequence=spine.children;
  if(sequence.length<1||sequence.length>128)return invalid();
  const seen=new Set<string>();
  let linear=0;
  for(const ref of sequence){
    if(ref.name!=='itemref')invalid();
    noChild(ref);
    const idref=requireAttr(ref,'idref');
    const item=itemIds.get(idref);
    if(!item||seen.has(idref)||item.mime!=='application/xhtml+xml')invalid();
    if([...ref.attrs.keys()].some(key=>!['idref','id','linear'].includes(key)))invalid();
    const flag=ref.attrs.get('linear')??'yes';
    if(flag!=='yes'&&flag!=='no')invalid();
    if(flag==='yes')linear++;
    seen.add(idref);
  }
  if(linear===0)return invalid();
  return {status:'package_spine_only',packageCount:1,manifestItems:declared.length,
    spineItems:sequence.length,linearSpineItems:linear,navigationCount:1};
}
