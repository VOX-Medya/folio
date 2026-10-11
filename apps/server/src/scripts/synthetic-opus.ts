/**
 * A 12-second synthetic silent Ogg/Opus stream for Folio CI only.
 * Uses the same valid CRC32/OpusHead/OpusTags/20 ms packet fixture as the
 * existing private Ogg structure tests. No ffmpeg or media source download.
 * THIS IS NOT publisher audio or a codec approval mechanism.
 */
function crc(page:Buffer):number{
  let value=0;
  for(let i=0;i<page.length;i++){
    const b=i>=22&&i<26?0:page[i]!;
    value^=b<<24;
    for(let n=0;n<8;n++){
      value=(value&0x80000000)?(value<<1)^0x04c11db7:value<<1;
    }
  }
  return value>>>0;
}
function oggPage(payload:Buffer,sequence:number,flags:number,granule:bigint):Buffer{
  if(payload.length>=255)throw new Error('CI packet must use one lace segment');
  const page=Buffer.alloc(28+payload.length);
  page.write('OggS',0,'ascii');
  page[4]=0;page[5]=flags;page.writeBigUInt64LE(granule,6);
  page.writeUInt32LE(77,14);page.writeUInt32LE(sequence,18);
  page[26]=1;page[27]=payload.length;
  payload.copy(page,28);
  page.writeUInt32LE(crc(page),22);
  return page;
}
export function syntheticSilentOggOpus(seconds=12):Buffer{
  if(!Number.isInteger(seconds)||seconds<1||seconds>30)throw Error('CI duration out of bounds');
  const head=Buffer.alloc(19);
  head.write('OpusHead',0,'ascii');head[8]=1;head[9]=1;
  head.writeUInt16LE(312,10);head.writeUInt32LE(48000,12);
  const tags=Buffer.alloc(16);
  tags.write('OpusTags',0,'ascii');
  const packet=Buffer.from([0xf8,0xff,0xfe]); // valid 20ms Opus silence
  const frames=seconds*50;
  const pages=[oggPage(head,0,2,0n),oggPage(tags,1,0,0n)];
  for(let frame=1;frame<=frames;frame++){
    pages.push(oggPage(packet,frame+1,frame===frames?4:0,
      BigInt(312+frame*960)));
  }
  return Buffer.concat(pages);
}
