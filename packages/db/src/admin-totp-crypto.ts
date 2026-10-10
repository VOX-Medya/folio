import {
  createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual,
} from 'node:crypto';

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

/** Secret text is returned exactly once for enrollment; never audited/logged.
 * Associated data pins ciphertext to the account UUID, preventing cross-user
 * ciphertext transplant even when a database write is compromised. */
export function newEncryptedTotpSeed(userId:string,keyHex:string){
  const key=serverKey(keyHex);
  const seed=randomBytes(20);
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('folio:admin-totp:v1:'+userId,'utf8'));
  const ciphertext=Buffer.concat([cipher.update(seed),cipher.final()]);
  const tag=cipher.getAuthTag();
  const secretBase32=base32(seed);
  seed.fill(0);
  key.fill(0);
  return {
    secretBase32,
    record:{
      nonce:nonce.toString('base64url'),
      ciphertext:ciphertext.toString('base64url'),
      tag:tag.toString('base64url'),
      keyVersion:'v1',
    },
  };
}

export function decryptTotpSeed(
  userId:string,record:{nonce:string;ciphertext:string;tag:string;keyVersion:string},
  keyHex:string,
):Buffer{
  if(record.keyVersion!=='v1')throw new Error('Unsupported TOTP encryption version');
  const key=serverKey(keyHex);
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,
      Buffer.from(record.nonce,'base64url'));
    decipher.setAAD(Buffer.from('folio:admin-totp:v1:'+userId,'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag,'base64url'));
    const seed=Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext,'base64url')),
      decipher.final(),
    ]);
    if(seed.length!==20)throw new Error('Invalid TOTP ciphertext');
    return seed;
  }finally{
    key.fill(0);
  }
}
