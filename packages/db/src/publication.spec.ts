import {describe,it,expect} from 'vitest';
import {permitsPublication} from './publication.js';
import type {schema} from './index.js';

type Rights=typeof schema.rightsRecords.$inferSelect;
const now=new Date('2026-10-11T12:00:00.000Z');
const record={
  reviewStatus:'approved',reviewedAt:new Date('2026-10-10T12:00:00.000Z'),
  reviewedBy:'11111111-1111-4111-8111-111111111111',
  displayAllowed:true,territories:['TR'],expiresAt:null,
} as Rights;
describe('MVP publication rights gate',()=>{
  it('accepts current reviewed territory-scoped display permission',()=>{
    expect(permitsPublication(record,'TR',now)).toBe(true);
  });
  it('defaults to deny missing, unreviewed, wrong country, revoked and expired claims',()=>{
    expect(permitsPublication(undefined,'TR',now)).toBe(false);
    expect(permitsPublication({...record,reviewStatus:'pending'},'TR',now)).toBe(false);
    expect(permitsPublication({...record,reviewStatus:'withdrawn'},'TR',now)).toBe(false);
    expect(permitsPublication({...record,reviewedBy:null},'TR',now)).toBe(false);
    expect(permitsPublication({...record,displayAllowed:false},'TR',now)).toBe(false);
    expect(permitsPublication(record,'US',now)).toBe(false);
    expect(permitsPublication({...record,expiresAt:now},'TR',now)).toBe(false);
  });
});
