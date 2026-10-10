/**
 * Private M4A/MP4 box-shape PRE-FLIGHT, not an AAC decoder, MP4 renderer,
 * complete ISO-BMFF parser, playable media check or rights grant.
 * 
 * Accepts only a deliberately tiny nonfragmented, single audio-track M4A
 * subset. Any unknown/extended box, external data reference, multiple track,
 * encryption/protection wrapper or sample-table inconsistency FAILS CLOSED.
 * Samples and ES descriptor contents are not decoded, so an attacker can
 * still forge codec metadata or embed arbitrary bytes in mdat/esds.
 */
export interface M4aContainerResult{
  status:'m4a_box_shape_only';
  boxCount:number;
  channelCount:number;
  sampleCount:number;
  containerTimelineMs:number;
  mediaBytes:number;
}
export const M4A_PREFLIGHT_MAX_BYTES=16*1024*1024;
const MAX_BOXES=64;
const MAX_SAMPLES=65536;
const MAX_TIMELINE_SAMPLES=48000*60*60*12;
interface Box{type:string;start:number;end:number;dataStart:number}
function invalid():never{throw new Error('Unsupported M4A quarantine container');}
function scanBoxes(
  bytes:Buffer,start:number,end:number,counter:{count:number},
):Box[]{
  if(start<0||end>bytes.length||end<=start)return invalid();
  const result:Box[]=[];
  let pos=start;
  while(pos<end){
    if(end-pos<8||++counter.count>MAX_BOXES)return invalid();
    const size=bytes.readUInt32BE(pos);
    const type=bytes.toString('ascii',pos+4,pos+8);
    if(!/^[a-z0-9 ]{4}$/.test(type)||size<8||size>end-pos)return invalid();
    result.push({type,start:pos,end:pos+size,dataStart:pos+8});
    pos+=size;
  }
  return result;
}
function exact(boxes:Box[],names:readonly string[]):Box[]{
  if(boxes.length!==names.length||
    boxes.some((box,i)=>box.type!==names[i]))return invalid();
  return boxes;
}
function length(box:Box):number{return box.end-box.dataStart;}
function fullbox(bytes:Buffer,box:Box,expected=0):void{
  if(length(box)<4||bytes.readUInt32BE(box.dataStart)!==expected)invalid();
}
function boundedTimeline(bytes:Buffer,box:Box):{scale:number;samples:number}{
  if(length(box)<20)return invalid();
  fullbox(bytes,box);
  const scale=bytes.readUInt32BE(box.dataStart+12);
  const samples=bytes.readUInt32BE(box.dataStart+16);
  if(scale!==48000||samples===0||samples>MAX_TIMELINE_SAMPLES)invalid();
  return {scale,samples};
}
export function inspectM4aContainer(bytes:Buffer):M4aContainerResult{
  if(!Buffer.isBuffer(bytes)||bytes.length<128||
    bytes.length>M4A_PREFLIGHT_MAX_BYTES)return invalid();
  const counter={count:0};
  const [ftyp,moov,mdat]=exact(scanBoxes(bytes,0,bytes.length,counter),
    ['ftyp','moov','mdat']);
  if(!ftyp||!moov||!mdat)return invalid();
  if(length(ftyp)<12||(length(ftyp)-8)%4!==0||
    bytes.toString('ascii',ftyp.dataStart,ftyp.dataStart+4)!=='M4A '||
    !bytes.subarray(ftyp.dataStart+8,ftyp.end)
      .includes(Buffer.from('M4A ','ascii')))return invalid();
  if(length(mdat)<1)return invalid();
  const [mvhd,trak]=exact(scanBoxes(bytes,moov.dataStart,moov.end,counter),
    ['mvhd','trak']);
  if(!mvhd||!trak)return invalid();
  if(length(mvhd)!==100)return invalid();
  const movie=boundedTimeline(bytes,mvhd);
  const [tkhd,mdia]=exact(scanBoxes(bytes,trak.dataStart,trak.end,counter),
    ['tkhd','mdia']);
  if(!tkhd||!mdia)return invalid();
  if(length(tkhd)!==84)return invalid();
  fullbox(bytes,tkhd,7); // enabled track, version 0
  if(bytes.readUInt32BE(tkhd.dataStart+12)!==1||
    bytes.readUInt32BE(tkhd.dataStart+20)!==movie.samples)return invalid();
  const [mdhd,hdlr,minf]=exact(scanBoxes(bytes,mdia.dataStart,mdia.end,counter),
    ['mdhd','hdlr','minf']);
  if(!mdhd||!hdlr||!minf)return invalid();
  if(length(mdhd)!==24)return invalid();
  const media=boundedTimeline(bytes,mdhd);
  if(media.samples!==movie.samples)return invalid();
  if(length(hdlr)!==24)return invalid();
  fullbox(bytes,hdlr);
  if(bytes.toString('ascii',hdlr.dataStart+8,hdlr.dataStart+12)!=='soun')return invalid();
  const [smhd,dinf,stbl]=exact(scanBoxes(bytes,minf.dataStart,minf.end,counter),
    ['smhd','dinf','stbl']);
  if(!smhd||!dinf||!stbl)return invalid();
  if(length(smhd)!==8)return invalid();
  fullbox(bytes,smhd);
  if(bytes.readUInt32BE(smhd.dataStart+4)!==0)return invalid();

  const [dref]=exact(scanBoxes(bytes,dinf.dataStart,dinf.end,counter),['dref']);
  if(!dref)return invalid();
  if(length(dref)<8)return invalid();
  fullbox(bytes,dref);
  if(bytes.readUInt32BE(dref.dataStart+4)!==1)return invalid();
  const [self]=exact(scanBoxes(bytes,dref.dataStart+8,dref.end,counter),['url ']);
  if(!self)return invalid();
  if(length(self)!==4)return invalid();
  fullbox(bytes,self,1); // self-contained only, NEVER remote URLs

  const [stsd,stts,stsc,stsz,stco]=exact(
    scanBoxes(bytes,stbl.dataStart,stbl.end,counter),
    ['stsd','stts','stsc','stsz','stco']);
  if(!stsd||!stts||!stsc||!stsz||!stco)return invalid();
  if(length(stsd)<8)return invalid();
  fullbox(bytes,stsd);
  if(bytes.readUInt32BE(stsd.dataStart+4)!==1)return invalid();
  const [entry]=exact(scanBoxes(bytes,stsd.dataStart+8,stsd.end,counter),['mp4a']);
  if(!entry)return invalid();
  if(length(entry)<28+13)return invalid();
  if(bytes.subarray(entry.dataStart,entry.dataStart+6).some(x=>x!==0)||
    bytes.readUInt16BE(entry.start+14)!==1||
    bytes.subarray(entry.start+16,entry.start+24).some(x=>x!==0)||
    bytes.subarray(entry.start+28,entry.start+32).some(x=>x!==0))return invalid();
  const channelCount=bytes.readUInt16BE(entry.start+24);
  if((channelCount!==1&&channelCount!==2)||
    bytes.readUInt16BE(entry.start+26)!==16)return invalid();
  const rate=bytes.readUInt32BE(entry.start+32);
  if(rate!==48000*65536&&rate!==44100*65536)return invalid();
  const [esds]=exact(scanBoxes(bytes,entry.start+36,entry.end,counter),['esds']);
  if(!esds)return invalid();
  if(length(esds)<6||length(esds)>256)return invalid();
  fullbox(bytes,esds);
  if(bytes[esds.dataStart+4]!==0x03)return invalid(); // ES descriptor marker only

  if(length(stts)!==16)return invalid();
  fullbox(bytes,stts);
  if(bytes.readUInt32BE(stts.dataStart+4)!==1)return invalid();
  const sampleCount=bytes.readUInt32BE(stts.dataStart+8);
  const sampleDelta=bytes.readUInt32BE(stts.dataStart+12);
  if(sampleCount===0||sampleCount>MAX_SAMPLES||
    sampleDelta===0||sampleDelta>4096||
    sampleCount*sampleDelta!==media.samples)return invalid();
  if(length(stsc)!==20)return invalid();
  fullbox(bytes,stsc);
  if(bytes.readUInt32BE(stsc.dataStart+4)!==1||
    bytes.readUInt32BE(stsc.dataStart+8)!==1||
    bytes.readUInt32BE(stsc.dataStart+12)!==sampleCount||
    bytes.readUInt32BE(stsc.dataStart+16)!==1)return invalid();
  if(length(stsz)<12)return invalid();
  fullbox(bytes,stsz);
  const fixedSize=bytes.readUInt32BE(stsz.dataStart+4);
  if(bytes.readUInt32BE(stsz.dataStart+8)!==sampleCount)return invalid();
  let sampleBytes=0;
  if(fixedSize){
    if(length(stsz)!==12||fixedSize>65536)return invalid();
    sampleBytes=fixedSize*sampleCount;
  }else{
    if(length(stsz)!==12+4*sampleCount)return invalid();
    for(let i=0;i<sampleCount;i++){
      const current=bytes.readUInt32BE(stsz.dataStart+12+i*4);
      if(current<1||current>65536)return invalid();
      sampleBytes+=current;
      if(sampleBytes>M4A_PREFLIGHT_MAX_BYTES)return invalid();
    }
  }
  if(length(stco)!==12)return invalid();
  fullbox(bytes,stco);
  if(bytes.readUInt32BE(stco.dataStart+4)!==1||
    bytes.readUInt32BE(stco.dataStart+8)!==mdat.dataStart||
    sampleBytes!==length(mdat))return invalid();

  const containerTimelineMs=Math.floor(media.samples*1000/media.scale);
  if(containerTimelineMs<1)return invalid();
  return {status:'m4a_box_shape_only',boxCount:counter.count,channelCount,
    sampleCount,containerTimelineMs,mediaBytes:length(mdat)};
}
