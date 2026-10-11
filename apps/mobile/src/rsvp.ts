/** Display-only RSVP words from an already rights-checked published reader response.
 * Respect semantic includeRsvp exclusions, and never interpret the source as HTML. */
export type RsvpTextBlock={text:string;includeRsvp:boolean};
export const RSVP_MIN_WPM=100;
export const RSVP_MAX_WPM=700;
export const RSVP_WPM_STEP=50;

export function tokenizeRsvpWords(blocks:readonly RsvpTextBlock[]):string[]{
  const words:string[]=[];
  for(const block of blocks){
    if(!block.includeRsvp)continue;
    // Verbatim TR/EN Unicode words plus their attached punctuation; whitespace
    // separates visible units. No generated/repaired text or locale mutation.
    const chunk=block.text.match(/\S+/gu);
    if(chunk)words.push(...chunk);
  }
  return words;
}
export function rsvpGroup(words:readonly string[],start:number,size:number):string{
  return words.slice(start,start+size).join(' ');
}
export function rsvpNextStart(length:number,start:number,size:number):number{
  if(length<=0||size<1)return 0;
  const current=Math.floor(Math.max(0,start)/size)*size;
  const last=Math.floor((length-1)/size)*size;
  return Math.min(last,current+size);
}
export function rsvpPreviousStart(start:number,size:number):number{
  if(size<1)return 0;
  return Math.max(0,Math.floor(Math.max(0,start)/size)*size-size);
}
export function rsvpTickMilliseconds(wpm:number,groupSize:number):number{
  if(!Number.isInteger(wpm)||wpm<RSVP_MIN_WPM||wpm>RSVP_MAX_WPM||
    ![1,2,3].includes(groupSize)){
    throw new Error('Unsupported MVP RSVP pace');
  }
  return Math.round(60_000*groupSize/wpm);
}
