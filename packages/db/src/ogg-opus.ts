/**
 * Private Ogg Opus container PRE-FLIGHT ONLY, not an audio decoder or player.
 * This intentionally supports a narrow one-packet-per-page, single-serial,
 * one-stream Ogg Opus subset. Valid but more complex Ogg files are rejected.
 *
 * A successful result DOES NOT verify encoded Opus frame integrity, audible
 * duration, malware safety, copyright, rights or any playback permission.
 * No source bytes, tags, serial number or file paths leave this module.
 */
export interface OggOpusContainerResult{
  status:'ogg_opus_container_only';
  pageCount:number;
  audioPacketCount:number;
  channelCount:number;
  granuleTimelineMs:number;
}
export const OGG_OPUS_PREFLIGHT_MAX_BYTES=16*1024*1024;
const MAX_PAGES=4096;
const MAX_PACKET_BYTES=64*1024;
const MAX_TIMELINE_SAMPLES=48_000n*60n*60n*12n; // 12-hour review cap
const OGG_MAGIC=Buffer.from('OggS','ascii');
const OPUS_HEAD=Buffer.from('OpusHead','ascii');
const OPUS_TAGS=Buffer.from('OpusTags','ascii');
const TABLE=new Uint32Array(256);
for(let n=0;n<256;n++){
  let c=n<<24;
  for(let i=0;i<8;i++)c=(c&0x80000000)?(c<<1)^0x04c11db7:c<<1;
  TABLE[n]=c>>>0;
}
function invalid():never{throw new Error('Unsupported Ogg Opus quarantine container');}
function checksum(page:Buffer):number{
  let value=0;
  for(let i=0;i<page.length;i++){
    const byte=i>=22&&i<26?0:page[i]!;
    value=((value<<8)^TABLE[((value>>>24)^byte)&255]!)>>>0;
  }
  return value>>>0;
}

export function inspectOggOpusContainer(source:Buffer):OggOpusContainerResult{
  if(!Buffer.isBuffer(source)||source.length<27*3||
    source.length>OGG_OPUS_PREFLIGHT_MAX_BYTES)return invalid();
  let offset=0,pageCount=0,audioPacketCount=0,channelCount=0,preskip=0;
  let serial:number|undefined,previousGranule=0n,ended=false;
  while(offset<source.length){
    if(++pageCount>MAX_PAGES||source.length-offset<28)return invalid();
    if(!source.subarray(offset,offset+4).equals(OGG_MAGIC)||
      source[offset+4]!==0)return invalid();
    const flags=source[offset+5]!;
    // No continuation, multiplexing, chained streams or unknown flags.
    if(flags&~0x06)return invalid();
    if(pageCount===1?flags!==0x02:
      flags!==0&&flags!==0x04)return invalid();
    const granule=source.readBigUInt64LE(offset+6);
    const currentSerial=source.readUInt32LE(offset+14);
    if(serial===undefined)serial=currentSerial;
    else if(serial!==currentSerial)return invalid();
    if(source.readUInt32LE(offset+18)!==pageCount-1)return invalid();
    const segmentCount=source[offset+26]!;
    if(segmentCount<1||source.length-offset<27+segmentCount)return invalid();
    let length=0;
    for(let s=0;s<segmentCount;s++){
      const segment=source[offset+27+s]!;
      if(s<segmentCount-1?segment!==255:segment===255)return invalid();
      length+=segment;
    }
    if(length<1||length>MAX_PACKET_BYTES||
      source.length-offset<27+segmentCount+length)return invalid();
    const end=offset+27+segmentCount+length;
    if(checksum(source.subarray(offset,end))!==
      source.readUInt32LE(offset+22))return invalid();
    const packet=source.subarray(offset+27+segmentCount,end);
    if(pageCount===1){
      if(granule!==0n||packet.length!==19||
        !packet.subarray(0,8).equals(OPUS_HEAD)||
        packet[8]!==1||(packet[9]!==1&&packet[9]!==2)||
        packet.readUInt32LE(12)!==48000||
        packet.readInt16LE(16)!==0||packet[18]!==0)return invalid();
      preskip=packet.readUInt16LE(10);
      if(preskip>3840)return invalid();
      channelCount=packet[9]!;
    }else if(pageCount===2){
      if(granule!==0n||packet.length<16||
        !packet.subarray(0,8).equals(OPUS_TAGS))return invalid();
      const vendorLength=packet.readUInt32LE(8);
      if(vendorLength>128||packet.length!==16+vendorLength||
        packet.readUInt32LE(12+vendorLength)!==0)return invalid();
    }else{
      if(packet.length<2||packet.subarray(0,8).equals(OPUS_HEAD)||
        packet.subarray(0,8).equals(OPUS_TAGS))return invalid();
      // Granule positions are container CLAIMS, not decoded frame duration.
      if(granule<=previousGranule||granule>MAX_TIMELINE_SAMPLES+
        BigInt(preskip))return invalid();
      previousGranule=granule;
      audioPacketCount++;
    }
    if(flags===0x04){
      if(pageCount<3||end!==source.length||
        granule<=BigInt(preskip)+480n)return invalid();
      ended=true;
    }else if(end===source.length)return invalid();
    offset=end;
  }
  if(!ended||pageCount<3||audioPacketCount<1)return invalid();
  const granuleTimelineMs=Math.floor(Number(previousGranule-BigInt(preskip))/48);
  if(!Number.isSafeInteger(granuleTimelineMs)||granuleTimelineMs<=0)return invalid();
  return {
    status:'ogg_opus_container_only',pageCount,audioPacketCount,
    channelCount,granuleTimelineMs,
  };
}
