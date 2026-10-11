/** #35 One bounded HTTP byte range, for native/browser chapter seeking. */
export function approvedAudioRange(value:unknown,sizeBytes:number):
  {start:number;end:number}|null{
  if(value===undefined)return null;
  if(typeof value!=='string'||!Number.isSafeInteger(sizeBytes)||sizeBytes<1||
     sizeBytes>16*1024*1024)throw new Error('Invalid audio range');
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!match||(!match[1]&&!match[2]))throw new Error('Invalid audio range');
  let start=0,end=sizeBytes-1;
  if(match[1]){
    start=Number(match[1]);
    if(match[2]){
      const requestedEnd=Number(match[2]);
      if(!Number.isSafeInteger(requestedEnd))throw new Error('Invalid audio range');
      end=Math.min(requestedEnd,end);
    }
  }else{
    const suffix=Number(match[2]);
    if(!Number.isSafeInteger(suffix)||suffix<1)throw new Error('Invalid audio range');
    start=Math.max(0,sizeBytes-suffix);
  }
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||
     start>=sizeBytes||end<start)throw new Error('Invalid audio range');
  return {start,end};
}
