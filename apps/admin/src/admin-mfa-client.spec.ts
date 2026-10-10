import {describe,expect,it} from 'vitest';
import {
  AdminMfaClientError,isSafeAdminMfaOrigin,isValidTotpCode,
  parseTotpEnrollment,parseTotpProof,
} from './admin-mfa-client.js';

const expiresAt='2026-10-11T00:00:00.000Z';
const secret='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
describe('Admin MFA browser contract (without persisted secrets)',()=>{
  it('rejects insecure HTTP, file and JavaScript protocols',()=>{
    expect(isSafeAdminMfaOrigin('https:')).toBe(true);
    expect(isSafeAdminMfaOrigin('http:')).toBe(false);
    expect(isSafeAdminMfaOrigin('file:')).toBe(false);
    expect(isSafeAdminMfaOrigin('javascript:')).toBe(false);
  });
  it('accepts only exactly six ASCII digits for a TOTP code',()=>{
    expect(isValidTotpCode('012345')).toBe(true);
    for(const wrong of ['12345','1234567','123 45','12345\n','١٢٣٤٥٦','abcdef','']){
      expect(isValidTotpCode(wrong)).toBe(false);
    }
  });
  it('validates exactly the server enrollment response with a 160-bit seed',()=>{
    expect(parseTotpEnrollment({secretBase32:secret,expiresAt}))
      .toEqual({secretBase32:secret,expiresAt});
    for(const wrong of [
      {secretBase32:secret.toLowerCase(),expiresAt},
      {secretBase32:'ABC',expiresAt},
      {secretBase32:secret,expiresAt:'not-a-date'},
      {secretBase32:secret,expiresAt,token:'raw-session-token'},
      {secretBase32:secret,expiresAt,role:'superadmin'},
      null,[],secret,
    ]){
      expect(()=>parseTotpEnrollment(wrong)).toThrow(AdminMfaClientError);
    }
  });
  it('rejects hidden access tokens and unverified proof JSON',()=>{
    expect(parseTotpProof({verified:true,expiresAt}))
      .toEqual({verified:true,expiresAt});
    for(const wrong of [
      {verified:false,expiresAt},
      {verified:true,expiresAt,token:'leaked-bearer'},
      {verified:true,expiresAt,adminRoles:['superadmin']},
      {verified:'true',expiresAt},
      {verified:true,expiresAt:'malformed'},
      {},null,
    ]){
      expect(()=>parseTotpProof(wrong)).toThrow(AdminMfaClientError);
    }
  });
});
