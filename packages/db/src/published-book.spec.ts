import {describe,expect,it} from 'vitest';
import {hasCurrentCatalogGrant} from './published-book.js';
import type {schema} from './index.js';

type Rights=typeof schema.rightsRecords.$inferSelect;
const now=new Date('2026-10-11T12:00:00.000Z');
const approved={
  reviewStatus:'approved',reviewedBy:'11111111-1111-4111-8111-111111111111',
  reviewedAt:new Date('2026-10-10T10:00:00.000Z'),territories:['TR'],
  expiresAt:null,displayAllowed:true,audioAllowed:false,
} as Rights;
describe('public published book permission',()=>{
  it('grants reviewed display only in current approved territory',()=>{
    expect(hasCurrentCatalogGrant(approved,'display','TR',now)).toBe(true);
    expect(hasCurrentCatalogGrant(approved,'display','US',now)).toBe(false);
    expect(hasCurrentCatalogGrant(approved,'audio','TR',now)).toBe(false);
  });
  it('rejects absent, pending, withdrawn and expired rights without fallback',()=>{
    expect(hasCurrentCatalogGrant(undefined,'display','TR',now)).toBe(false);
    expect(hasCurrentCatalogGrant({...approved,reviewStatus:'pending'},'display','TR',now)).toBe(false);
    expect(hasCurrentCatalogGrant({...approved,reviewStatus:'withdrawn'},'display','TR',now)).toBe(false);
    expect(hasCurrentCatalogGrant({...approved,reviewedAt:null},'display','TR',now)).toBe(false);
    expect(hasCurrentCatalogGrant({...approved,reviewedBy:null},'display','TR',now)).toBe(false);
    expect(hasCurrentCatalogGrant({...approved,expiresAt:now},'display','TR',now)).toBe(false);
    expect(hasCurrentCatalogGrant({...approved,displayAllowed:false},'display','TR',now)).toBe(false);
  });
});
