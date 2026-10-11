import {describe,expect,it} from 'vitest';
import {approvedAudioRange} from './audio-range';

describe('bounded published audio byte ranges',()=>{
  it('supports initial, bounded, suffix and open-ended chapter seeks',()=>{
    expect(approvedAudioRange(undefined,100)).toBeNull();
    expect(approvedAudioRange('bytes=0-',100)).toEqual({start:0,end:99});
    expect(approvedAudioRange('bytes=15-25',100)).toEqual({start:15,end:25});
    expect(approvedAudioRange('bytes=-10',100)).toEqual({start:90,end:99});
    expect(approvedAudioRange('bytes=98-999',100)).toEqual({start:98,end:99});
  });
  it('fails closed for multi-range, overflow, invalid syntax and malformed seeks',()=>{
    for(const input of ['bytes=0-1,4-6','bytes=100-','bytes=-0','bytes=2-1',
      'bytes=NaN-','bytes=1.5-','bytes=999999999999999999999-',
      'bytes=0-9999999999999999999999','Bytes=0-']){
      expect(()=>approvedAudioRange(input,100)).toThrow();
    }
  });
});
