import {TextDecoder} from 'node:util';

/**
 * Internal quarantine-only EPUB stylesheet lexical subset.
 *
 * NOT a CSS sanitizer, rendering approval, content extraction, AV proof,
 * publication permission, or a general CSS parser. The caller supplies only
 * fully CRC/size-validated OCF ZIP entries after OPF/XHTML quarantine checks.
 */
export interface EpubCssResourceResult {
  status:'css_resources_only';
  stylesheetCount:number;
  stylesheetBytes:number;
  ruleCount:number;
  declarationCount:number;
}
const decoder=new TextDecoder('utf-8',{fatal:true});
const MAX_STYLESHEETS=32;
const MAX_SHEET_BYTES=64*1024;
const MAX_ALL_SHEETS_BYTES=256*1024;
const MAX_RULES=256;
const MAX_DECLARATIONS=2048;
const MAX_SELECTORS_PER_RULE=8;
const SELECTOR=/^(?:html|body|div|span|p|section|article|blockquote|li|ol|ul|a|nav|h[1-6]|\.[a-z][a-z0-9_-]{0,31})$/;
const HEX=/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
const LENGTH=/^(?:0|[1-9][0-9]?(?:\.[0-9]{1,2})?(?:px|em|rem))$/;
const INERT_VALUES:Readonly<Record<string,RegExp>>={
  'color':HEX,'background-color':HEX,
  'font-family':/^(?:serif|sans-serif|monospace)$/,
  'font-style':/^(?:normal|italic|oblique)$/,
  'font-weight':/^(?:normal|bold|[1-9]00)$/,
  'font-size':LENGTH,
  'line-height':/^(?:normal|[1-3](?:\.[0-9]{1,2})?)$/,
  'text-align':/^(?:left|right|center|justify|start|end)$/,
  'text-decoration':/^(?:none|underline|line-through)$/,
  'text-indent':LENGTH,'margin':LENGTH,'margin-top':LENGTH,
  'margin-right':LENGTH,'margin-bottom':LENGTH,'margin-left':LENGTH,
  'padding':LENGTH,'padding-top':LENGTH,'padding-right':LENGTH,
  'padding-bottom':LENGTH,'padding-left':LENGTH,
};
function invalid():never {throw new Error('Unsupported EPUB CSS resources');}

function inspectSheet(data:Buffer):{rules:number;declarations:number}{
  if(!Buffer.isBuffer(data)||data.length===0||data.length>MAX_SHEET_BYTES)invalid();
  let source:string;
  try{source=decoder.decode(data);}catch{return invalid();}
  // No escapes/comments/at-rules/functions/URL loaders/obfuscated encodings
  // or complex selector grammar. Unknown syntax fails instead of sanitizing.
  for(const char of source){
    const n=char.codePointAt(0)!;
    if(n>126||(n<32&&n!==9&&n!==10&&n!==13))invalid();
  }
  for(const forbidden of ['\\','@','"',"'",'<','>','[',']','/','*','(',')','!','&','|','^','~','?','$',String.fromCharCode(96)]){
    if(source.includes(forbidden))invalid();
  }
  source=source.trim();
  if(!source)invalid();
  let cursor=0,rules=0,declarations=0;
  while(cursor<source.length){
    const open=source.indexOf('{',cursor);
    if(open<0)return invalid();
    const selector=source.slice(cursor,open).trim();
    if(!selector||selector.length>256)return invalid();
    const parts=selector.split(',');
    if(parts.length>MAX_SELECTORS_PER_RULE||
      parts.some(part=>!SELECTOR.test(part.trim())))return invalid();
    const close=source.indexOf('}',open+1);
    const nested=source.indexOf('{',open+1);
    if(close<0||(nested!==-1&&nested<close))return invalid();
    const block=source.slice(open+1,close).trim();
    if(!block.endsWith(';'))return invalid();
    const lines=block.slice(0,-1).split(';');
    if(lines.length===0||lines.some(line=>!line.trim()))return invalid();
    const seen=new Set<string>();
    for(const raw of lines){
      const match=/^([a-z][a-z-]{0,31})\s*:\s*(\S(?:[^;]*\S)?)$/.exec(raw.trim());
      if(!match)return invalid();
      const key=match[1]!,value=match[2]!;
      const allowed=INERT_VALUES[key];
      if(!allowed||seen.has(key)||!allowed.test(value))return invalid();
      seen.add(key);
      declarations++;
      if(declarations>MAX_DECLARATIONS)return invalid();
    }
    rules++;
    if(rules>MAX_RULES)return invalid();
    cursor=close+1;
    while(cursor<source.length&&/\s/.test(source[cursor]!))cursor++;
  }
  return {rules,declarations};
}

/** Counts-only inspection. No CSS bytes, filenames, URLs, source or paths
 * can appear in the result. A stylesheet-free manifest may return zero.
 * Even a positive verdict DOES NOT approve fonts/images or a renderer. */
export function inspectEpubCssResources(
  entries:ReadonlyMap<string,Buffer>,cssPaths:readonly string[],
):EpubCssResourceResult{
  if(cssPaths.length>MAX_STYLESHEETS||new Set(cssPaths).size!==cssPaths.length)invalid();
  const actual=[...entries.keys()].filter(path=>/\.css$/i.test(path));
  if(actual.length!==cssPaths.length)invalid();
  const declared=new Set(cssPaths);
  if(actual.some(path=>!declared.has(path)))invalid();
  let stylesheetBytes=0,ruleCount=0,declarationCount=0;
  for(const path of cssPaths){
    if(!path.endsWith('.css')||path.length>256||path.includes('..')||
      path.includes('\\')||path.includes('%'))invalid();
    const content=entries.get(path);
    if(!content)return invalid();
    stylesheetBytes+=content.length;
    if(stylesheetBytes>MAX_ALL_SHEETS_BYTES)return invalid();
    const result=inspectSheet(content);
    ruleCount+=result.rules;
    declarationCount+=result.declarations;
    if(ruleCount>MAX_RULES||declarationCount>MAX_DECLARATIONS)return invalid();
  }
  return {status:'css_resources_only',stylesheetCount:cssPaths.length,
    stylesheetBytes,ruleCount,declarationCount};
}
