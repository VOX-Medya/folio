import {describe,expect,it} from 'vitest';
import {rightsRecordCreateSchema,rightsDecisionQuerySchema} from '@folio/contracts';

describe('rights must be a separate reviewed gate',()=>{
  const uid='68ac5e65-5d1b-4c6d-9a3f-c097a8f50011';
  const base={workId:uid,evidence:'Provenance and rights evidence reference',licenseKind:'review-required',territories:['TR','GB'],displayAllowed:true};
  it('allows explicit work-only evidence with no implied approval',()=>{
    const result=rightsRecordCreateSchema.parse(base);
    expect(result.displayAllowed).toBe(true);
    expect(result.audioAllowed).toBe(false);
    expect(result.sharingAllowed).toBe(false);
  });
  it('rejects invalid country format, ambiguous territory and revision without edition',()=>{
    expect(rightsRecordCreateSchema.safeParse({...base,territories:['tr']}).success).toBe(false);
    expect(rightsRecordCreateSchema.safeParse({...base,territories:['TR','TR']}).success).toBe(false);
    expect(rightsRecordCreateSchema.safeParse({...base,revisionId:uid}).success).toBe(false);
    expect(rightsDecisionQuerySchema.safeParse({...base,territory:'US',action:'display'}).success).toBe(false);
  });
});
