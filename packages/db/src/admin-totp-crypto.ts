import {
  createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual,
} from 'node:crypto';

/** Version labels identify the exact deployment key and AAD namespace.
 * A v2 key MUST differ from v1. Legacy string arguments are v1 only. */
export type TotpKeyVersion='v1'|'v2';
export type TotpKeyring={
  activeVersion:TotpKeyVersion;
  v1?:string;
  v2?:string;
};
export type TotpKeyMaterial=string|TotpKeyring;
export type TotpEnvelopeRecord={
  nonce:string;ciphertext:string;tag:string;keyVersion:string;
};

export function requireTotpKeyring(raw:TotpKeyMaterial):TotpKeyring {
  const ring:TotpKeyring=typeof raw==='string'?{activeVersion:'v1',v1:raw}:raw;
  if(!ring||!['v1','v2'].includes(ring.activeVersion)||
    (ring.v1!==undefined&&!/^[a-fA-F0-9]{64}$/.test(ring.v1))||
    (ring.v2!==undefined&&!/^[a-fA-F0-9]{64}$/.test(ring.v2))||
    (ring.v1&&ring.v2&&ring.v1.toLowerCase()===ring.v2.toLowerCase())||
    !ring[ring.activeVersion]){
    throw new Error('TOTP encryption keyring unavailable');
  }
  return ring;
}

export function requireVersionedTotpKey(
  material:TotpKeyMaterial,version:string,
):string {
  const ring=requireTotpKeyring(material);
  if(version!=='v1'&&version!=='v2'){
    throw new Error('Unsupported TOTP encryption version');
  }
  const key=ring[version];
  if(!key)throw new Error('TOTP encryption key version unavailable');
  return key;
}

const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_MS=30_000;
export const TOTP_MAX_FAILURES=5;
export const TOTP_LOCK_MS=15*60_000;
export const ADMIN_MFA_PROOF_MS=15*60_000;
export const ENROLLMENT_MS=10*60_000;

/** Only an explicitly configured server-side 32-byte key may decrypt a seed. */
function serverKey(raw:string):Buffer{
  if(typeof raw!=='string'||!/^[a-fA-F0-9]{64}$/.test(raw)){
    throw new Error('TOTP encryption key not configured');
  }
  return Buffer.from(raw,'hex');
}

function base32(bytes:Buffer):string{
  let value=0,bits=0,out='';
  for(const byte of bytes){
    value=(value<<8)|byte;
    bits+=8;
    while(bits>=5){
      out+=ALPHABET[(value>>>(bits-5))&31];
      bits-=5;
    }
    value&=(1<<bits)-1;
  }
  if(bits)out+=ALPHABET[(value<<(5-bits))&31];
  return out;
}

/** Internal decoding for provisioning tests; NEVER accept a user-supplied seed
 * as authentication evidence. Only the server-encrypted DB seed is trusted. */
export function decodeTotpBase32(text:string):Buffer{
  if(typeof text!=='string'||!/^[A-Z2-7]{32}$/.test(text)){
    throw new Error('Invalid TOTP seed format');
  }
  let value=0,bits=0;
  const decoded:number[]=[];
  for(const char of text){
    const digit=ALPHABET.indexOf(char);
    value=(value<<5)|digit;
    bits+=5;
    if(bits>=8){
      decoded.push((value>>>(bits-8))&255);
      bits-=8;
      value&=(1<<bits)-1;
    }
  }
  if(decoded.length!==20)throw new Error('Invalid TOTP seed size');
  return Buffer.from(decoded);
}

/** RFC 6238 HMAC-SHA1, six digits, 30-second moving counter. */
export function totpCodeAtStep(seed:Buffer,step:number):string{
  if(seed.length!==20||!Number.isSafeInteger(step)||step<0){
    throw new Error('Invalid TOTP parameters');
  }
  const counter=Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac=createHmac('sha1',seed).update(counter).digest();
  const offset=mac[19]!&15;
  const binary=(mac.readUInt32BE(offset)&0x7fffffff)%1_000_000;
  return String(binary).padStart(6,'0');
}

export function acceptedTotpStep(
  seed:Buffer,rawCode:string,lastAcceptedStep:number,clockMs:number,
):number|null{
  if(typeof rawCode!=='string'||!/^\d{6}$/.test(rawCode)||
    !Number.isSafeInteger(clockMs)||clockMs<0)return null;
  const current=Math.floor(clockMs/TOTP_STEP_MS);
  let accepted:number|null=null;
  const candidate=Buffer.from(rawCode,'ascii');
  for(const delta of [-1,0,1]){
    const step=current+delta;
    if(step<0)continue;
    const expected=Buffer.from(totpCodeAtStep(seed,step),'ascii');
    if(timingSafeEqual(expected,candidate)&&step>lastAcceptedStep){
      accepted=step;
    }
  }
  return accepted;
}

/** Encrypts an unchanged 160-bit TOTP seed with a fresh IV, a specific
 * server-side key version and account-specific authenticated data.
 * Used by controlled key rewrapping, NOT to reset a user's MFA factor. */
export function encryptTotpSeedForVersion(
  userId:string,seed:Buffer,keyHex:string,version:TotpKeyVersion,
):TotpEnvelopeRecord {
  if(seed.length!==20||!['v1','v2'].includes(version)){
    throw new Error('Invalid TOTP factor encryption parameters');
  }
  const key=serverKey(keyHex);
  try{
    const nonce=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(Buffer.from('folio:admin-totp:'+version+':'+userId,'utf8'));
    const ciphertext=Buffer.concat([cipher.update(seed),cipher.final()]);
    return {
      nonce:nonce.toString('base64url'),
      ciphertext:ciphertext.toString('base64url'),
      tag:cipher.getAuthTag().toString('base64url'),
      keyVersion:version,
    };
  }finally{key.fill(0);}
}

/** Random enrollment seed is returned once over verified TLS and NEVER
 * persisted as plaintext or logged. The database stores only its GCM record. */
export function newEncryptedTotpSeed(
  userId:string,keyHex:string,version:TotpKeyVersion='v1',
){
  const seed=randomBytes(20);
  try{
    return {secretBase32:base32(seed),
      record:encryptTotpSeedForVersion(userId,seed,keyHex,version)};
  }finally{seed.fill(0);}
}

export function decryptTotpSeed(
  userId:string,record:TotpEnvelopeRecord,keyHex:string,
):Buffer{
  if(record.keyVersion!=='v1'&&record.keyVersion!=='v2'){
    throw new Error('Unsupported TOTP encryption version');
  }
  const key=serverKey(keyHex);
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,
      Buffer.from(record.nonce,'base64url'));
    decipher.setAAD(Buffer.from(
      'folio:admin-totp:'+record.keyVersion+':'+userId,'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag,'base64url'));
    const seed=Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext,'base64url')),
      decipher.final(),
    ]);
    if(seed.length!==20)throw new Error('Invalid TOTP ciphertext');
    return seed;
  }finally{key.fill(0);}
}
