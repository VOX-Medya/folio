import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { UserOwnershipGuard } from './main.js';
const guard = new UserOwnershipGuard();
function context(authUserId: string | undefined, resourceUserId: string): ExecutionContext {
  const req = {auth: authUserId ? {userId: authUserId} : undefined, params: {userId: resourceUserId}};
  return {switchToHttp: () => ({getRequest: () => req})} as unknown as ExecutionContext;
}
describe('fail-closed owner resource boundary', () => {
  it('denies unauthenticated users even if they submit someone else\'s user ID', () => {
    expect(() => guard.canActivate(context(undefined, 'alice'))).toThrow('Authentication required');
  });
  it('denies another user and allows only the trusted same-user principal', () => {
    expect(() => guard.canActivate(context('bob', 'alice'))).toThrow('Resource is not owned by user');
    expect(guard.canActivate(context('alice', 'alice'))).toBe(true);
  });
});
