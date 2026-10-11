import {describe,expect,it} from 'vitest';
import {friendInviteCodeSchema,friendshipActionSchema,friendInviteRedeemSchema,friendshipListSchema} from './friendship.js';

describe('invite-only friendship contract',()=>{
  it('allows only fixed-length nonambiguous invite codes, never account search',()=>{
    expect(friendInviteCodeSchema.parse('ABCDEFGHJKLMNPQR')).toBe('ABCDEFGHJKLMNPQR');
    expect(friendInviteCodeSchema.safeParse('abcdef1234567890').success).toBe(false);
    expect(friendInviteRedeemSchema.safeParse({
      code:'ABCDEFGHJKLMNPQR',userId:'11111111-1111-4111-8111-111111111111',
    }).success).toBe(false);
  });
  it('rejects ambiguous action principal and unbounded listing',()=>{
    const requestId='11111111-1111-4111-8111-111111111111';
    expect(friendshipActionSchema.safeParse({action:'accept',requestId}).success).toBe(true);
    expect(friendshipActionSchema.safeParse({action:'accept',requestId,targetUserId:requestId}).success).toBe(false);
    expect(friendshipListSchema.safeParse({items:Array.from({length:101},()=>({
      requestId,direction:'incoming',state:'pending',displayName:null,
    }))}).success).toBe(false);
  });
});
