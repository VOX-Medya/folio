import {inflateSync} from 'node:zlib';

/**
 * FIFTH private EPUB quarantine-only resource observation.
 *
 * This deliberately accepts only a narrow PNG structural subset.
 * Unsupported raster formats, embedded fonts, NCX and all other opaque
 * non-XHTML/non-CSS manifest resources FAIL CLOSED; they are not decoded.
 *
 * Even a positive result is NOT image decoder hardening, render permission,
 * executable malware clearance, provenance, rights or verified media status.
 */
export type EpubBinaryManifestAsset={readonly path:string;readonly mime:string};
export interface EpubPngResourcesResult {
  status:'png_structure_only';
  imageCount:number;
  imageBytes:number;
  totalPixels:number;
}
const PNG_SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_IMAGES=16;
const MAX_IMAGE_BYTES=1024*1024;
const MAX_TOTAL_BYTES=4*1024*1024;
const MAX_DIMENSION=2048;
const MAX_PIXELS_PER_IMAGE=1_048_576;
const MAX_TOTAL_PIXELS=2_097_152;
const MAX_PNG_CHUNKS=64;
function invalid():never{throw new Error('Unsupported EPUB embedded binary resources');}
function crc32(bytes:Buffer):number{
  let crc=0xffffffff;
  for(const byte of bytes){
    crc^=byte;
    for(let bit=0;bit<8;bit++)crc=(crc&1)?(crc>>>1)^0xedb88320:crc>>>1;
  }
  return (crc^0xffffffff)>>>0;
}
function inspectPng(bytes:Buffer):number{
  if(!Buffer.isBuffer(bytes)||bytes.length<8+25+12+12||
    bytes.length>MAX_IMAGE_BYTES||
    !bytes.subarray(0,8).equals(PNG_SIGNATURE))return invalid();

  let position=8,chunks=0,width=0,height=0,channels=0;
  let stage:'ihdr'|'idat'|'done'='ihdr';
  const compressed:Buffer[]=[];
  let compressedBytes=0;
  while(position<bytes.length){
    if(bytes.length-position<12||++chunks>MAX_PNG_CHUNKS)return invalid();
    const length=bytes.readUInt32BE(position);
    if(length>MAX_IMAGE_BYTES||length>bytes.length-position-12)return invalid();
    const end=position+12+length;
    const tag=bytes.subarray(position+4,position+8);
    const type=tag.toString('ascii');
    if(!/^[A-Za-z]{4}$/.test(type)||
      crc32(bytes.subarray(position+4,position+8+length))!==
        bytes.readUInt32BE(position+8+length))return invalid();
    const data=bytes.subarray(position+8,position+8+length);
    if(type==='IHDR'){
      if(stage!=='ihdr'||length!==13||chunks!==1)return invalid();
      width=data.readUInt32BE(0);
      height=data.readUInt32BE(4);
      const depth=data[8],color=data[9],compression=data[10],
        filter=data[11],interlace=data[12];
      if(width===0||height===0||width>MAX_DIMENSION||height>MAX_DIMENSION||
        width*height>MAX_PIXELS_PER_IMAGE||depth!==8||
        (color!==2&&color!==6)||compression!==0||filter!==0||
        interlace!==0)return invalid();
      channels=color===6?4:3;
      stage='idat';
    }else if(type==='IDAT'){
      if(stage!=='idat'||length===0)return invalid();
      compressed.push(data);
      compressedBytes+=length;
      if(compressedBytes>MAX_IMAGE_BYTES)return invalid();
    }else if(type==='IEND'){
      if(stage!=='idat'||compressedBytes===0||length!==0||
        end!==bytes.length)return invalid();
      stage='done';
    }else{
      // Forbid all metadata/profiles, animation (acTL), palettes, alternate
      // color paths, embedded text and unknown critical/ancillary chunks.
      return invalid();
    }
    position=end;
  }
  if(stage!=='done'||position!==bytes.length)return invalid();
  const expected=height*(1+channels*width);
  if(expected>compressedBytes*100)return invalid();
  let pixels:Buffer;
  try{
    // info:true exposes the consumed compressed-byte count. Do not accept
    // valid deflate followed by garbage, a second stream or hidden data.
    const raw:unknown=inflateSync(Buffer.concat(compressed),{
      maxOutputLength:expected+1,info:true,
    });
    if(typeof raw!=='object'||raw===null||!('buffer' in raw)||
      !('engine' in raw))return invalid();
    const {buffer,engine}=raw as {
      buffer:Buffer;engine:{bytesWritten:number};
    };
    if(!Buffer.isBuffer(buffer)||engine.bytesWritten!==compressedBytes)return invalid();
    pixels=buffer;
  }catch{return invalid();}
  if(pixels.length!==expected)return invalid();
  const stride=1+width*channels;
  for(let row=0;row<height;row++){
    if(pixels[row*stride]!>4)return invalid();
  }
  return width*height;
}

/**
 * Invoked ONLY after the complete OCF ZIP CRC check, OPF manifest relationship,
 * restrictive XHTML gate and CSS-only gate. Every remaining manifest resource
 * must be accounted for by this PNG-only allowlist; fonts/GIF/JPEG/WebP/NCX
 * are denied, regardless of signature, until separately sandbox-validated.
 *
 * No decoded pixels, source path or raw image bytes leave this observation.
 */
export function inspectEpubPngResources(
  entries:ReadonlyMap<string,Buffer>,
  binaryAssets:readonly EpubBinaryManifestAsset[],
):EpubPngResourcesResult{
  if(binaryAssets.length>MAX_IMAGES||
    new Set(binaryAssets.map(x=>x.path)).size!==binaryAssets.length)return invalid();
  let imageBytes=0,totalPixels=0;
  for(const asset of binaryAssets){
    if(asset.mime!=='image/png'||!asset.path.endsWith('.png')||
      asset.path.includes('%')||asset.path.includes('\\')||
      asset.path.split('/').some(p=>!p||p==='.'||p==='..'))return invalid();
    const data=entries.get(asset.path);
    if(!data)return invalid();
    imageBytes+=data.length;
    if(imageBytes>MAX_TOTAL_BYTES)return invalid();
    totalPixels+=inspectPng(data);
    if(totalPixels>MAX_TOTAL_PIXELS)return invalid();
  }
  return {status:'png_structure_only',imageCount:binaryAssets.length,
    imageBytes,totalPixels};
}
