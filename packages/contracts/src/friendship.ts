import {z} from 'zod';

/** #40: invitation codes are secrets, never searchable account identifiers. */
export const friendInviteCodeSchema=z.string().regex(/^[A-Z2-9]{16}$/);
export const friendInviteIssueSchema=z.object({rotate:z.literal(true)}).strict();
export const friendInviteIssuedSchema=z.object({
  code:friendInviteCodeSchema,expiresAt:z.iso.datetime({offset:true}),
}).strict();
export const friendInviteRedeemSchema=z.object({code:friendInviteCodeSchema}).strict();
export const friendRequestResultSchema=z.object({
  requestId:z.uuid(),state:z.literal('pending'),
}).strict();
export const friendshipActionSchema=z.object({
  action:z.enum(['accept','reject','block']),
  requestId:z.uuid(),
}).strict();
export const friendshipDecisionResultSchema=z.object({
  state:z.enum(['accepted','rejected','blocked']),
}).strict();
export const friendshipEntrySchema=z.object({
  requestId:z.uuid(),
  direction:z.enum(['incoming','outgoing']),
  state:z.enum(['pending','accepted','blocked']),
  displayName:z.string().max(80).nullable(),
}).strict();
export const friendshipListSchema=z.object({
  items:z.array(friendshipEntrySchema).max(100),
}).strict();
export type FriendInviteIssued=z.infer<typeof friendInviteIssuedSchema>;
export type FriendRequestResult=z.infer<typeof friendRequestResultSchema>;
export type FriendshipAction=z.infer<typeof friendshipActionSchema>;
export type FriendshipDecisionResult=z.infer<typeof friendshipDecisionResultSchema>;
export type FriendshipList=z.infer<typeof friendshipListSchema>;
