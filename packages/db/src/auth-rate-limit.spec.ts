import {describe,expect,it} from 'vitest';
import {prepareAuthAttemptBuckets} from './auth-rate-limit.js';

const base={
  action:'login',trustedClientIp:'2001:0db8:0:0:0:0:0:0001',
  email:'  ALICE@EXAMPLE.COM ',hmacKeyHex:'a'.repeat(64),
};
describe('privacy-preserving auth attempt admission keys',()=>{
  it('normalizes IPv6/e-mail and separates IP and account quotas',()=>{
    const first=prepareAuthAttemptBuckets(base);
    const equivalent=prepareAuthAttemptBuckets({
      ...base,trustedClientIp:'2001:db8::1',email:'alice@example.com',
    });
    expect(first).toEqual(equivalent);
    expect(first.buckets).toHaveLength(2);
    expect(first.buckets.every(v=>/^[a-f0-9]{64}$/.test(v.digest))).toBe(true);
    expect(new Set(first.buckets.map(v=>v.digest)).size).toBe(2);
    const serialized=JSON.stringify(first);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('2001:');
    expect(serialized).not.toContain('aaaaaaaaaaaaaaaa');
  });
  it('partitions action/key and refuses untrusted address or weak key',()=>{
    const a=prepareAuthAttemptBuckets(base);
    const b=prepareAuthAttemptBuckets({...base,action:'register'});
    const c=prepareAuthAttemptBuckets({...base,hmacKeyHex:'b'.repeat(64)});
    expect(a.buckets.map(v=>v.digest)).not.toEqual(b.buckets.map(v=>v.digest));
    expect(a.buckets.map(v=>v.digest)).not.toEqual(c.buckets.map(v=>v.digest));
    for(const value of ['127.0.0.1, 8.8.8.8','host.local','', '192.0.2.1:1234']){
      expect(()=>prepareAuthAttemptBuckets({...base,trustedClientIp:value})).toThrow();
    }
    expect(()=>prepareAuthAttemptBuckets({...base,hmacKeyHex:'weak'})).toThrow();
    expect(()=>prepareAuthAttemptBuckets({...base,email:'not-email'})).toThrow();
    expect(()=>prepareAuthAttemptBuckets({...base,action:'admin'})).toThrow();
  });
});
