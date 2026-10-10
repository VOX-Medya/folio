import 'reflect-metadata';
import {describe,expect,it} from 'vitest';
import {onboardingSnapshotSchema,onboardingUpdateRequestSchema} from '@folio/contracts';

describe('cross-platform onboarding route input and snapshot contracts',()=>{
  it('strictly rejects caller-selected userId, unknown stage, repeats and stale version types',()=>{
    const valid={expectedVersion:0,stage:'language',locale:'en',interests:[]};
    expect(onboardingUpdateRequestSchema.safeParse(valid).success).toBe(true);
    for(const invalid of [
      {...valid,userId:'9c679ec7-bec8-4a65-b102-3b68d9228888'},
      {...valid,expectedVersion:-1},
      {...valid,expectedVersion:'0'},
      {...valid,stage:'premium'},
      {...valid,interests:['reading','reading']},
      {...valid,interests:Array.from({length:21},(_,n)=>'topic-'+n)},
    ]){
      expect(onboardingUpdateRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('accepts only backend-owned user snapshot shapes',()=>{
    const output={
      userId:'9c679ec7-bec8-4a65-b102-3b68d9228888',
      stage:'welcome',locale:'tr',interests:[],version:0,
    };
    expect(onboardingSnapshotSchema.parse(output)).toEqual(output);
    expect(onboardingSnapshotSchema.safeParse({...output,sessionToken:'secret'}).success).toBe(false);
  });
});
