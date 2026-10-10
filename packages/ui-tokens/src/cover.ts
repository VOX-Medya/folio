import {paperbound} from './index';

export type FolioCoverTheme='light'|'dark';
export interface FolioCoverInput {
  workId:string;
  language:'tr'|'en';
  title:string;
  authors:string[];
  genre:string;
  templateVersion:'paperbound-v1';
  theme:FolioCoverTheme;
}

/** Shared PAPERBOUND cover geometry. Web SVG and React Native both use this
 * immutable 320x480 logical coordinate system; no remote fonts or imagery. */
export interface FolioCoverLayout {
  width:320;
  height:480;
  background:string;
  ink:string;
  accent:string;
  titleLines:readonly string[];
  authorLines:readonly string[];
  titleFontSize:number;
  titleLineHeight:number;
  titleStartY:number;
  authorStartY:number;
  footer:string;
  accessibleLabel:string;
}

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const safeText=(value:string):string=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function canonicalText(value:string,max:number,required:boolean):string{
  if(typeof value!=='string'||value.length>max||
    [...value].some(char=>{
      const cp=char.codePointAt(0)!;
      return (cp<0x20&&cp!==9&&cp!==10&&cp!==13)||
        (cp>=0x7f&&cp<=0x9f)||
        (cp>=0x202a&&cp<=0x202e)||
        (cp>=0x2066&&cp<=0x2069)||
        (cp>=0xd800&&cp<=0xdfff)||
        cp===0xfffe||cp===0xffff;
    }))throw new Error('Unsafe cover metadata');
  const normalized=value.normalize('NFC').trim();
  if(required&&!normalized)throw new Error('Missing canonical cover metadata');
  return normalized;
}

function fnv1a(value:string):number {
  let hash=0x811c9dc5;
  for(const char of value){
    hash^=char.codePointAt(0)!;
    hash=Math.imul(hash,0x01000193);
  }
  return hash>>>0;
}

/** Line breaks never depend on platform font measuring, time or locale. */
function wrapWords(original:string,maxColumns:number):string[]{
  const words=original.split(/\s+/u);
  const lines:string[]=[];
  let current='';
  const push=()=>{if(current){lines.push(current);current='';}};
  for(const word of words){
    const pieces=Array.from(word);
    if(pieces.length>maxColumns){
      push();
      for(let index=0;index<pieces.length;index+=maxColumns){
        lines.push(pieces.slice(index,index+maxColumns).join(''));
      }
      continue;
    }
    if(!current)current=word;
    else if(Array.from(current+' '+word).length<=maxColumns)current+=' '+word;
    else {push();current=word;}
  }
  push();
  return lines;
}
function wrapTitle(title:string):string[]{
  const length=Array.from(title).length;
  let columns=Math.max(16,Math.ceil(length/3)+2);
  let lines=wrapWords(title,columns);
  while(lines.length>3&&columns<90){columns+=2;lines=wrapWords(title,columns);}
  return lines;
}

/** Safe canonical metadata -> deterministic Folio geometry.
 * This function does NOT grant book visibility, change source revisions,
 * generate a publisher cover or persist a new cover asset. */
export function layoutFolioCover(input:FolioCoverInput):FolioCoverLayout {
  if(!input||!uuid.test(input.workId)||
    input.templateVersion!=='paperbound-v1'||
    (input.language!=='tr'&&input.language!=='en')||
    (input.theme!=='light'&&input.theme!=='dark')){
    throw new Error('Unsupported canonical cover revision');
  }
  if(!Array.isArray(input.authors)||input.authors.length<1||input.authors.length>16){
    throw new Error('A cover requires 1-16 authors');
  }
  const title=canonicalText(input.title,250,true);
  const authors=input.authors.map(author=>canonicalText(author,120,true));
  const genre=canonicalText(input.genre,80,false);
  const colors=paperbound.mobile[input.theme];
  const palette=[colors.bg,colors.surface,colors.surface2];
  const index=fnv1a(input.workId.toLowerCase()+'|'+genre+'|'+input.templateVersion)%
    palette.length;
  const titleLines=wrapTitle(title);
  const titleFontSize=titleLines.length>3?22:
    titleLines.some(line=>Array.from(line).length>33)?25:
      titleLines.length===3?34:40;
  const titleLineHeight=titleFontSize+9;
  const titleStartY=160-(titleLines.length>3?20:0);
  const lastY=titleStartY+(titleLines.length-1)*titleLineHeight;
  const fullAuthors=wrapWords(authors.join(' • '),34);
  const authorLines=fullAuthors.slice(0,3);
  if(fullAuthors.length>3){
    // Only the visible label is shortened. Accessible label retains ALL authors.
    authorLines[2]=Array.from(authorLines[2]!).slice(0,31).join('').trimEnd()+'…';
  }
  return {
    width:320,height:480,background:palette[index]!,ink:colors.ink,
    accent:colors.accent,titleLines,authorLines,titleFontSize,
    titleLineHeight,titleStartY,authorStartY:Math.max(lastY+44,350),
    footer:input.language.toUpperCase()+(genre?' · '+genre:''),
    accessibleLabel:title+' — '+authors.join(', '),
  };
}

/** This SVG has no scripts, image references, CSS imports, foreignObject,
 * network fetches or embedded third-party art. Identical layout on all themes. */
export function renderFolioCoverSvg(input:FolioCoverInput):string{
  const layout=layoutFolioCover(input);
  const id='folio-cover-'+input.workId.replace(/-/g,'').toLowerCase();
  const title=layout.titleLines.map((line,index)=>{
    const textLength=Array.from(line).length*layout.titleFontSize*.56>260
      ?' textLength="260" lengthAdjust="spacingAndGlyphs"':'';
    return '<text x="30" y="'+(layout.titleStartY+index*layout.titleLineHeight)+
      '" class="title" font-size="'+layout.titleFontSize+'"'+textLength+'>'+
      safeText(line)+'</text>';
  }).join('');
  const authors=layout.authorLines.map((line,index)=>
    '<text x="30" y="'+(layout.authorStartY+index*23)+
      '" class="author">'+safeText(line)+'</text>').join('');
  const footerLength=Array.from(layout.footer).length>36
    ?' textLength="260" lengthAdjust="spacingAndGlyphs"':'';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480" '+
    'viewBox="0 0 320 480" role="img" aria-labelledby="'+id+'">'+
    '<title id="'+id+'">'+safeText(layout.accessibleLabel)+'</title>'+
    '<rect width="320" height="480" fill="'+layout.background+'"/>'+
    '<path d="M 15 22 L 15 458" stroke="'+layout.accent+'" stroke-width="3"/>'+
    '<text x="30" y="57" fill="'+layout.accent+'" font-size="13" font-weight="700" '+
    'font-family="Georgia,serif" letter-spacing="4">FOLIO</text>'+
    '<path d="M 30 83 H 290" stroke="'+layout.accent+'" stroke-width="1"/>'+
    '<g fill="'+layout.ink+'" font-family="Georgia,serif">'+title+authors+'</g>'+
    '<path d="M 30 427 H 290" stroke="'+layout.accent+'" stroke-width="1"/>'+
    '<text x="30" y="450" font-family="Georgia,serif" font-size="12" '+
    'fill="'+layout.accent+'"'+footerLength+'>'+
    safeText(layout.footer)+'</text></svg>';
}
