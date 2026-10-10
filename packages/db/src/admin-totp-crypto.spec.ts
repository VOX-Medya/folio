import {randomBytes} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {
  acceptedTotpStep,decodeTotpBase32,decryptTotpSeed,
  newEncryptedTotpSeed,totpCodeAtStep,TOTP_STEP_MS,
} from './admin-totp-crypto.js';

describe('RFC 6238 and encrypted admin TOTP verifier (#30)',()=>{
  it('matches SHA1 six-digit RFC 6238 vectors without user-chosen clock',()=>{
    const rfcSeed=Buffer.from('12345678901234567890','ascii');
    for(const [time,code] of [
      [59,'287082'],[1111111109,'081804'],[1111111111,'050471'],
      [1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130'],
    ] as const){
      const step=Math.floor(time/30);
      expect(totpCodeAtStep(rfcSeed,step)).toBe(code);
      expect(acceptedTotpStep(rfcSeed,code,step-1,time*1000)).toBe(step);
      expect(acceptedTotpStep(rfcSeed,code,step,time*1000)).toBeNull();
    }
  });
  it('accepts only a six-digit code within +/- one window, once',()=>{
    const secret=Buffer.from('12345678901234567890','ascii');
    const step=50_000,now=step*TOTP_STEP_MS+15_000;
    expect(acceptedTotpStep(secret,totpCodeAtStep(secret,step-1),-1,now))
      .toBe(step-1);
    expect(acceptedTotpStep(secret,totpCodeAtStep(secret,step),step-1,now))
      .toBe(step);
    expect(acceptedTotpStep(secret,totpCodeAtStep(secret,step+1),step,now))
      .toBe(step+1);
    expect(acceptedTotpStep(secret,'00000',-1,now)).toBeNull();
    expect(acceptedTotpStep(secret,'1234567',-1,now)).toBeNull();
    expect(acceptedTotpStep(secret,'abcdef',-1,now)).toBeNull();
    expect(acceptedTotpStep(secret,totpCodeAtStep(secret,step),step,now))
      .toBeNull();
  });
  it('encrypts 160 random seed bits with AES-256-GCM bound to user ID',()=>{
    const user='b946d7a4-678e-4d3e-82d8-2f29ef724b6f';
    const key=randomBytes(32).toString('hex');
    const generated=newEncryptedTotpSeed(user,key);
    const seed=decodeTotpBase32(generated.secretBase32);
    expect(seed.length).toBe(20);
    expect(generated.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(JSON.stringify(generated.record)).not.toContain(generated.secretBase32);
    expect(decryptTotpSeed(user,generated.record,key)).toEqual(seed);
    expect(()=>decryptTotpSeed('48ef95ef-e3e2-49d6-994f-11664c99835b',
      generated.record,key)).toThrow();
    expect(()=>decryptTotpSeed(user,generated.record,
      randomBytes(32).toString('hex'))).toThrow();
    expect(()=>newEncryptedTotpSeed(user,'bad-key')).toThrow();
    expect(()=>newEncryptedTotpSeed(user,'')).toThrow();
    expect(()=>decryptTotpSeed(user,{
      ...generated.record,ciphertext:'AA'+generated.record.ciphertext.slice(2),
    },key)).toThrow();
  });
});
