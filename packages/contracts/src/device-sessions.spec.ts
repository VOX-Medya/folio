import {describe,expect,it} from 'vitest';
import {deviceSessionIdSchema,deviceSessionInventorySchema} from './index.js';

const id='7e38fd6a-1214-4fdd-89ee-92c0cb8a10ba';
const item={
  id,deviceLabel:'android',isCurrent:true,
  createdAt:'2026-10-10T07:00:00.000Z',expiresAt:'2026-11-09T07:00:00.000Z',
};
describe('owner-only device session contract',()=>{
  it('accepts only minimal metadata and rejects sensitive extra properties',()=>{
    expect(deviceSessionIdSchema.parse(id)).toBe(id);
    expect(deviceSessionInventorySchema.parse({items:[item]})).toEqual({items:[item]});
    for(const changed of [
      {...item,tokenDigest:'1'.repeat(64)},{...item,sessionToken:'A'.repeat(43)},
      {...item,userId:id},{...item,deviceLabel:''},{...item,isCurrent:'true'},
    ])expect(deviceSessionInventorySchema.safeParse({items:[changed]}).success).toBe(false);
  });
  it('rejects invalid UUIDs, dates and more than 100 records',()=>{
    expect(deviceSessionIdSchema.safeParse('foreign-user').success).toBe(false);
    expect(deviceSessionInventorySchema.safeParse({
      items:[{...item,expiresAt:'invalid'}],
    }).success).toBe(false);
    expect(deviceSessionInventorySchema.safeParse({
      items:Array.from({length:101},()=>item),
    }).success).toBe(false);
  });
});
