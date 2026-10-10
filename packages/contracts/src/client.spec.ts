import { describe, expect, it } from 'vitest';
import { fetchCapabilities } from './index.js';

describe('shared HTTP client contract for native/web/admin', () => {
  it('parses only real valid response data with an encoded query', async () => {
    let requested = '';
    const fetcher = async (url: string | URL | Request): Promise<Response> => {
      requested = String(url);
      return new Response(JSON.stringify({items: [{id: 'rsvp', available: false, note: 'Not deployed'}], nextCursor: null}), {status: 200});
    };
    const result = await fetchCapabilities('http://localhost:3100/', {limit: 1}, fetcher as typeof fetch);
    expect(result.items[0]?.available).toBe(false);
    expect(requested).toBe('http://localhost:3100/v1/system/capabilities?limit=1');
  });
  it('never treats an error response as success', async () => {
    const fetcher = async () => new Response(JSON.stringify({error: {code: 'BAD_REQUEST', message: 'Invalid query', requestId: '3a4b32b1-879c-4c36-9580-c214a0dc4eb9'}}), {status: 400});
    await expect(fetchCapabilities('http://localhost:3100', {}, fetcher as typeof fetch)).rejects.toThrow('BAD_REQUEST');
  });
});
