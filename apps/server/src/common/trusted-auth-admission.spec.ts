import {describe,expect,it} from 'vitest';
import {ServiceUnavailableException} from '@nestjs/common';
import {trustedSocketClientIp} from './trusted-auth-admission.js';

describe('direct TCP peer identity for future auth admission',()=>{
  it('never trusts user-controlled forwarding/address headers',()=>{
    const actual=trustedSocketClientIp({
      socket:{remoteAddress:'127.0.0.1'},
      headers:{
        'x-forwarded-for':'198.51.100.250',
        'x-real-ip':'203.0.113.250',
        'forwarded':'for=192.0.2.250',
        'x-user-id':'someone-else',
      },
    });
    expect(actual).toBe('127.0.0.1');
  });
  it('accepts real IPv6 peer without parsing forwarded claims',()=>{
    expect(trustedSocketClientIp({
      socket:{remoteAddress:'2001:db8::1'},
      headers:{'x-forwarded-for':['203.0.113.40','203.0.113.41']},
    })).toBe('2001:db8::1');
  });
  it('fails closed without a valid kernel peer address',()=>{
    for(const address of [undefined,'','not-a-real-ip','1.2.3.4, 5.6.7.8','127.0.0.1:4000']){
      expect(()=>trustedSocketClientIp({socket:{remoteAddress:address}}))
        .toThrow(ServiceUnavailableException);
    }
    expect(()=>trustedSocketClientIp({headers:{'x-forwarded-for':'192.0.2.45'}}))
      .toThrow(ServiceUnavailableException);
  });
});
