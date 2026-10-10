import { describe, expect, it } from 'vitest';
import { apiErrorSchema, capabilityPageSchema } from '@folio/contracts';
import { createFolioApp } from './main.js';

describe('Folio API live HTTP contract', () => {
  it('supports typed health, pagination, malformed parameter errors and OpenAPI', async () => {
    const app = await createFolioApp();
    try {
      const server = await app.listen(0, '127.0.0.1');
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('No ephemeral test port');
      const base = `http://127.0.0.1:${addr.port}`;
      const health = await fetch(`${base}/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({status: 'ok'});
      const requestId = health.headers.get('x-request-id');
      expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
      const firstResponse = await fetch(`${base}/v1/system/capabilities?limit=2`);
      expect(firstResponse.status).toBe(200);
      const first = capabilityPageSchema.parse(await firstResponse.json());
      expect(first.items).toHaveLength(2);
      expect(first.items.every(item => !item.available)).toBe(true);
      expect(first.nextCursor).toBeTruthy();
      const nextResponse = await fetch(`${base}/v1/system/capabilities?limit=2&cursor=${first.nextCursor}`);
      const next = capabilityPageSchema.parse(await nextResponse.json());
      expect(next.items).toHaveLength(2);
      expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
      for (const query of ['limit=0', 'limit=51', 'cursor=malformed', 'limit=3&foo=unexpected']) {
        const bad = await fetch(`${base}/v1/system/capabilities?${query}`);
        expect(bad.status).toBe(400);
        const error = apiErrorSchema.parse(await bad.json());
        expect(error.error.code).toBe('BAD_REQUEST');
        expect(error.error.requestId).toBe(bad.headers.get('x-request-id'));
      }
      const notFound = await fetch(`${base}/v1/not-existing`);
      expect(notFound.status).toBe(404);
      expect(apiErrorSchema.parse(await notFound.json()).error.code).toBe('NOT_FOUND');
      const ready = await fetch(`${base}/v1/ready`);
      if (!process.env.DATABASE_URL) {
        expect(ready.status).toBe(503);
        expect(apiErrorSchema.parse(await ready.json()).error.code).toBe('SERVICE_UNAVAILABLE');
      }
      const documentResponse = await fetch(`${base}/openapi-json`);
      expect(documentResponse.status).toBe(200);
      const document = await documentResponse.json();
      expect(document.openapi).toMatch(/^3\./);
      expect(document.paths['/v1/health'].get).toBeDefined();
      expect(document.paths['/v1/ready'].get).toBeDefined();
      expect(document.paths['/v1/system/capabilities'].get).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
