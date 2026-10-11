import {z} from 'zod';

/** #40: invitations are bearer-like secrets. Neither directory lookup nor user search is allowed. */
export const friendInviteCodeSchema=z.string().regex(/^[A-Z2-9]{16}$/);
export const friendshipActionSchema=z.object({
  action:z.enum(['accept','reject','block']),
  requestId:z.uuid(),
}).strict();
export const friendInviteRedeemSchema=z.object({code:friendInviteCodeSchema}).strict();
export const friendInviteIssueSchema=z.object({rotate:z.literal(true)}).strict();
export const friendshipEntrySchema=z.object({
  requestId:z.uuid(),
  direction:z.enum(['incoming','outgoing']),
  state:z.enum(['pending','accepted','blocked']),
  displayName:z.string().max(80).nullable(),
}).strict();
export const friendshipListSchema=z.object({
  items:z.array(friendshipEntrySchema).max(100),
}).strict();
export type FriendshipAction=z.infer<typeof friendshipActionSchema>;
export type FriendshipList=z.infer<typeof friendshipListSchema>;
