import {describe, expect, it} from 'vitest';
import {apiErrorSchema, capabilityPageSchema, cursorQuerySchema, decodeCursor, encodeCursor, paginateCapabilities,readinessResponseSchema} from './index.js';

const items = [
  {id: 'read', available: false, note: 'Not deployed'},
  {id: 'audio', available: false, note: 'Not deployed'},
  {id: 'search', available: false, note: 'Not deployed'},
] as const;
describe('shared API contracts', () => {
  it('paginates without duplicate items and provides a deterministic cursor', () => {
    const first = paginateCapabilities(items, {limit: '2'});
    expect(first.items.map(item => item.id)).toEqual(['audio', 'read']);
    const second = paginateCapabilities(items, {limit: '2', cursor: first.nextCursor});
    expect(second.items.map(item => item.id)).toEqual(['search']);
    expect(second.nextCursor).toBeNull();
    expect(capabilityPageSchema.safeParse(first).success).toBe(true);
  });
  it('rejects invalid parameters and non-canonical or injected cursors', () => {
    expect(cursorQuerySchema.safeParse({limit: '0'}).success).toBe(false);
    expect(cursorQuerySchema.safeParse({limit: '51'}).success).toBe(false);
    expect(cursorQuerySchema.safeParse({limit: ['2']}).success).toBe(false);
    expect(() => decodeCursor('%%%')).toThrow();
    expect(() => decodeCursor('A'.repeat(181))).toThrow();
    expect(() => paginateCapabilities(items, {cursor: encodeCursor('unknown')})).toThrow('Unknown cursor');
  });
  it('requires a request ID in normalized API error output', () => {
    expect(apiErrorSchema.safeParse({error: {code: 'NOT_FOUND', message: 'Not found', requestId: 'not-a-uuid'}}).success).toBe(false);
    expect(readinessResponseSchema.parse({status:'ready'})).toEqual({status:'ready'});
    expect(readinessResponseSchema.safeParse({status:'ok'}).success).toBe(false);
  });
});
