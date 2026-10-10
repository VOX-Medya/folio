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

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const safeText=(value:string):string=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function assertCoverInput(input:FolioCoverInput):void {
  if(!uuid.test(input.workId))throw new Error('Cover must belong to a canonical work UUID');
  if(input.templateVersion!=='paperbound-v1'||!['tr','en'].includes(input.language)||
    !['light','dark'].includes(input.theme))throw new Error('Unsupported cover revision');
  if(input.title.trim().length<1||input.title.length>250)throw new Error('Invalid canonical title');
  if(input.authors.length<1||input.authors.length>16||
    input.authors.some(a=>a.trim().length<1||a.length>120))throw new Error('Invalid canonical authors');
  if(input.genre.length>80)throw new Error('Invalid cover genre');
}

function fnv1a(value:string):number {
  let hash=0x811c9dc5;
  for(const char of value){
    hash^=char.codePointAt(0)!;
    hash=Math.imul(hash,0x01000193);
  }
  return hash>>>0;
}

function wrapWords(original:string,maxColumns:number):string[] {
  const words=original.normalize('NFC').trim().split(/\s+/u);
  const lines:string[]=[];
  let current='';
  const push=()=>{if(current){lines.push(current);current='';}};
  for(const word of words){
    const pieces=Array.from(word);
    if(pieces.length>maxColumns){
      push();
      for(let index=0;index<pieces.length;index+=maxColumns)lines.push(pieces.slice(index,index+maxColumns).join(''));
      continue;
    }
    if(!current){current=word;}
    else if(Array.from(current+' '+word).length<=maxColumns){current+=' '+word;}
    else {push();current=word;}
  }
  push();
  return lines;
}

function wrapCoverTitle(title:string):string[] {
  const length=Array.from(title.normalize('NFC')).length;
  let columns=Math.max(16,Math.ceil(length/3)+2);
  let lines=wrapWords(title,columns);
  while(lines.length>3&&columns<90){columns+=2;lines=wrapWords(title,columns);}
  return lines;
}

/** Deterministic, original, no source publisher artwork, no remote font/image dependency. */
export function renderFolioCoverSvg(input:FolioCoverInput):string {
  assertCoverInput(input);
  const base=paperbound.mobile[input.theme];
  const seeds=[base.bg,base.surface,base.surface2];
  const index=fnv1a(input.workId+'|'+input.genre+'|'+input.templateVersion)%seeds.length;
  const bg=seeds[index]!;
  const ink=base.ink;
  const accent=base.accent;
  const titleLines=wrapCoverTitle(input.title);
  const titleSize=titleLines.length>3?22:titleLines.some(s=>Array.from(s).length>33)?25:
    titleLines.length===3?34:40;
  const lineHeight=titleSize+9;
  const startY=160-(titleLines.length>3?20:0);
  const lastY=startY+(titleLines.length-1)*lineHeight;
  const authorLines=wrapWords(input.authors.join(' • '),34).slice(0,3);
  const authorStart=Math.max(lastY+44,350);
  const id='folio-cover-'+input.workId.replace(/-/g,'');
  const title=titleLines.map((line,n)=>{
    const fit=Array.from(line).length*titleSize*.56>260
      ?' textLength="260" lengthAdjust="spacingAndGlyphs"':'';
    return '<text x="30" y="'+(startY+n*lineHeight)+
      '" class="title" font-size="'+titleSize+'"'+fit+'>'+safeText(line)+'</text>';
  }).join('');
  const author=authorLines.map((line,n)=>'<text x="30" y="'+(authorStart+n*23)+
    '" class="author">'+safeText(line)+'</text>').join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480" '+
    'viewBox="0 0 320 480" role="img" aria-labelledby="'+id+'">'+
    '<title id="'+id+'">'+safeText(input.title+' — '+input.authors.join(', '))+'</title>'+
    '<rect width="320" height="480" fill="'+bg+'"/>'+
    '<path d="M 15 22 L 15 458" stroke="'+accent+'" stroke-width="3"/>'+
    '<text x="30" y="57" fill="'+accent+'" font-size="13" font-weight="700" '+
    'font-family="Georgia,serif" letter-spacing="4">FOLIO</text>'+
    '<path d="M 30 83 H 290" stroke="'+accent+'" stroke-width="1"/>'+
    '<g fill="'+ink+'" font-family="Georgia,serif">'+title+author+'</g>'+
    '<path d="M 30 427 H 290" stroke="'+accent+'" stroke-width="1"/>'+
    '<text x="30" y="450" font-family="Georgia,serif" font-size="12" '+
    'fill="'+accent+'">'+safeText(input.language.toUpperCase()+' · '+input.genre)+'</text>'+
    '</svg>';
}
