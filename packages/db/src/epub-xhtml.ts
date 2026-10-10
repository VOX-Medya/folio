import {TextDecoder} from 'node:util';

/**
 * PRIVATE quarantine-only XHTML *syntax and reference* preflight.
 * This is deliberately NOT a generic XML/HTML parser, sanitizer, renderer or
 * text extractor. No source bytes, text, URLs or paths leave its result.
 * The input must come from the fully CRC/size-validated bounded EPUB ZIP.
 */
export interface EpubXhtmlMarkupResult {
  status:'xhtml_markup_only';
  documentCount:number;
  totalElements:number;
  navigationDocuments:1;
  localLinks:number;
  fragmentLinks:number;
}
type LocalLink={target:string;fragment:string|null};
type InspectedDocument={ids:Set<string>;links:LocalLink[];elements:number;
  tocCount:number;tocLinks:number};

const UTF8=new TextDecoder('utf-8',{fatal:true});
const NS_XHTML='http://www.w3.org/1999/xhtml';
const NS_EPUB='http://www.idpf.org/2007/ops';
const MAX_DOCUMENT_BYTES=2*1024*1024;
const MAX_DOCUMENTS=128;
const MAX_ELEMENTS_PER_DOC=8000;
const MAX_ELEMENTS_TOTAL=50000;
const MAX_LINKS_TOTAL=4096;
const MAX_DEPTH=64;
const MAX_TAG_BYTES=4096;
const MAX_ATTR_BYTES=1024;
const LOCAL_ID=/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const TAG=/^[a-z][a-z0-9]*$/;
const CONTENT_TAGS=new Set([
  'article','section','main','aside','header','footer','div','span','p',
  'h1','h2','h3','h4','h5','h6','blockquote','q','cite','em','strong','b','i',
  'u','s','small','sub','sup','code','pre','ol','ul','li','dl','dt','dd',
  'table','caption','thead','tbody','tfoot','tr','th','td','figure',
  'figcaption','abbr','time','ruby','rb','rt','rp','bdi','bdo','a','br','hr','nav',
]);
const GLOBAL_ATTRS=new Set(['id','lang','xml:lang','dir','class','title']);

function invalid():never{throw new Error('Unsupported EPUB XHTML markup');}
function xmlEntities(value:string):void{
  if(value.replace(/&(amp|lt|gt|quot|apos);/g,'').includes('&'))invalid();
}
function validCharacters(value:string):void{
  for(const char of value){
    const n=char.codePointAt(0)!;
    if((n<32&&n!==9&&n!==10&&n!==13)||
      (n>=0x7f&&n<=0x9f)||
      (n>=0xd800&&n<=0xdfff)||
      (n&0xfffe)===0xfffe)invalid();
  }
}
function parseAttributes(source:string):Map<string,string>{
  const result=new Map<string,string>();
  let rest=source;
  while(rest.length){
    if(/^\s+$/.test(rest))break;
    const match=/^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(rest);
    if(!match)invalid();
    const key=match[1]!,raw=match[2]??match[3]??'';
    if(raw.length>MAX_ATTR_BYTES||result.has(key))invalid();
    validCharacters(raw);
    xmlEntities(raw);
    const value=raw.replace(/&(amp|lt|gt|quot|apos);/g,(_,entity:string)=>
      ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[entity]!);
    if(value.normalize('NFC')!==value)invalid();
    result.set(key,value);
    rest=rest.slice(match[0].length);
  }
  return result;
}
function readTagEnd(source:string,start:number):number{
  let quote='';
  for(let i=start+1;i<source.length&&i-start<=MAX_TAG_BYTES;i++){
    const ch=source[i]!;
    if(quote){
      if(ch===quote)quote='';
    }else if(ch==='"'||ch==="'")quote=ch;
    else if(ch==='>')return i;
  }
  return invalid();
}
function safeLocalHref(
  value:string,currentPath:string,
):LocalLink{
  if(!value||value.length>256||value!==value.trim()||
    value.normalize('NFC')!==value||value.includes('%')||
    value.includes('\\')||value.includes(':')||
    value.includes('?')||value.startsWith('//'))invalid();
  const parts=value.split('#');
  if(parts.length>2)invalid();
  const relative=parts[0]!;
  const fragment=parts.length===2?parts[1]!:null;
  if(fragment!==null&&!LOCAL_ID.test(fragment))invalid();
  if(!relative&&!fragment)invalid();
  let target=currentPath;
  if(relative){
    if(!relative.endsWith('.xhtml')||relative.startsWith('/')||
      !/^[A-Za-z0-9_./-]+$/.test(relative)||
      relative.split('/').some(x=>!x||x==='.'||x==='..'))invalid();
    const dir=currentPath.includes('/')?currentPath.slice(0,currentPath.lastIndexOf('/')+1):'';
    target=dir+relative;
    if(target.length>256)invalid();
  }
  return {target,fragment};
}
function inspectDocument(path:string,bytes:Buffer,isNavigation:boolean):InspectedDocument{
  if(bytes.length===0||bytes.length>MAX_DOCUMENT_BYTES)invalid();
  let source:string;
  try{source=UTF8.decode(bytes);}catch{return invalid();}
  if(source.charCodeAt(0)===0xfeff)source=source.slice(1);
  validCharacters(source);
  if(source.startsWith('<?xml')){
    const declaration=/^<\?xml\s+version=(["'])1\.0\1(?:\s+encoding=(["'])UTF-8\2)?\s*\?>/.exec(source);
    if(!declaration)invalid();
    source=source.slice(declaration[0].length);
  }

  const stack:string[]=[];
  const ids=new Set<string>();
  const links:LocalLink[]=[];
  let root=false,head=0,title=0,body=0,elements=0,tocCount=0,tocLinks=0;
  let epubNamespaceDeclared=false;
  let index=0;
  while(index<source.length){
    const start=source.indexOf('<',index);
    const text=source.slice(index,start<0?source.length:start);
    xmlEntities(text);
    if(text.includes(']]>')||
      ((!stack.length||stack.length===1||
        (stack.includes('head')&&!stack.includes('title')))&&text.trim()))invalid();
    if(start<0)break;
    const end=readTagEnd(source,start),raw=source.slice(start,end+1);
    index=end+1;
    if(raw.startsWith('</')){
      const close=/^<\/([a-z][a-z0-9]*)\s*>$/.exec(raw);
      if(!close||stack.pop()!==close[1])invalid();
      continue;
    }
    const match=/^<([a-z][a-z0-9]*)([\s\S]*?)(\/?)>$/.exec(raw);
    if(!match||match[2]!.includes('<'))invalid();
    const name=match[1]!,parent=stack[stack.length-1]??null;
    if(!TAG.test(name))invalid();
    const attrs=parseAttributes(match[2]!);
    const selfClosing=match[3]==='/';
    elements++;
    if(elements>MAX_ELEMENTS_PER_DOC||stack.length>=MAX_DEPTH)invalid();

    if(name==='html'){
      if(root||parent!==null||selfClosing)invalid();
      root=true;
      if(attrs.get('xmlns')!==NS_XHTML)invalid();
      if(attrs.has('xmlns:epub')&&attrs.get('xmlns:epub')!==NS_EPUB)invalid();
      epubNamespaceDeclared=attrs.get('xmlns:epub')===NS_EPUB;
    }else if(name==='head'){
      if(parent!=='html'||head||body||selfClosing)invalid();
      head++;
    }else if(name==='title'){
      if(parent!=='head'||title||selfClosing)invalid();
      title++;
    }else if(name==='body'){
      if(parent!=='html'||head!==1||body||selfClosing)invalid();
      body++;
    }else{
      if(!CONTENT_TAGS.has(name)||!stack.includes('body'))invalid();
      if(name==='nav'){
        if(!isNavigation||tocCount||stack.includes('nav')||
          attrs.get('epub:type')!=='toc')invalid();
        tocCount++;
      }
      if(name==='li'&&parent!=='ol'&&parent!=='ul')invalid();
      if(name==='a'&&!attrs.has('href'))invalid();
      if((name==='br'||name==='hr')!==selfClosing)invalid();
    }

    for(const [key,value] of attrs){
      if(key==='xmlns'){
        if(name!=='html'||value!==NS_XHTML)invalid();
      }else if(key==='xmlns:epub'){
        if(name!=='html'||value!==NS_EPUB)invalid();
      }else if(key==='epub:type'){
        if(name!=='nav'||value!=='toc'||!epubNamespaceDeclared)invalid();
      }else if(key==='href'){
        if(name!=='a')invalid();
        const link=safeLocalHref(value,path);
        links.push(link);
        if(isNavigation&&stack.includes('nav')){
          if(!stack.includes('li'))invalid();
          tocLinks++;
        }
      }else if(GLOBAL_ATTRS.has(key)){
        if(key==='id'){
          if(!LOCAL_ID.test(value)||ids.has(value))invalid();
          ids.add(value);
        }else if(key==='dir'){
          if(value!=='ltr'&&value!=='rtl'&&value!=='auto')invalid();
        }else if(key==='lang'||key==='xml:lang'){
          if(!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(value))invalid();
        }else if(key==='class'){
          if(!/^[A-Za-z_][A-Za-z0-9_-]*(?:\s+[A-Za-z_][A-Za-z0-9_-]*)*$/.test(value))invalid();
        }
      }else invalid();
    }
    if(attrs.has('lang')&&attrs.has('xml:lang')&&attrs.get('lang')!==attrs.get('xml:lang'))invalid();
    if(name==='a'&&stack.includes('nav')&&!stack.includes('li'))invalid();
    if(!selfClosing)stack.push(name);
  }
  if(stack.length||!root||head!==1||title!==1||body!==1)invalid();
  if(isNavigation?(tocCount!==1||tocLinks===0):tocCount!==0)invalid();
  return {ids,links,elements,tocCount,tocLinks};

}

/**
 * This result is evidence that a narrow, inert XHTML syntax/reference subset
 * was observed. It is NOT a safe-to-render verdict: CSS, images, fonts,
 * actual reading-order semantics, source quality, malware and rights are
 * explicitly outside this gate.
 */
export function inspectEpubXhtmlMarkup(
  entries:ReadonlyMap<string,Buffer>,
  xhtmlPaths:readonly string[],
  navigationPath:string,
):EpubXhtmlMarkupResult{
  if(xhtmlPaths.length<2||xhtmlPaths.length>MAX_DOCUMENTS||
    new Set(xhtmlPaths).size!==xhtmlPaths.length||
    !xhtmlPaths.includes(navigationPath))invalid();
  const checked=new Map<string,InspectedDocument>();
  let totalElements=0,totalLinks=0,fragmentLinks=0;
  for(const path of xhtmlPaths){
    if(!path.endsWith('.xhtml')||path.startsWith('/')||path.includes('..')||
      path.includes('\\')||path.includes('%')||!entries.has(path))invalid();
    const document=inspectDocument(path,entries.get(path)!,path===navigationPath);
    checked.set(path,document);
    totalElements+=document.elements;
    totalLinks+=document.links.length;
    if(totalElements>MAX_ELEMENTS_TOTAL||totalLinks>MAX_LINKS_TOTAL)invalid();
  }
  for(const document of checked.values()){
    for(const link of document.links){
      const target=checked.get(link.target);
      if(!target||(link.fragment!==null&&!target.ids.has(link.fragment)))invalid();
      if(link.fragment!==null)fragmentLinks++;
    }
  }
  return {
    status:'xhtml_markup_only',
    documentCount:checked.size,
    totalElements,
    navigationDocuments:1,
    localLinks:totalLinks,
    fragmentLinks,
  };
}
