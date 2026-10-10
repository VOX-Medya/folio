import { describe, expect, it } from 'vitest';
import { createFolioApp } from './main.js';

describe('Folio API HTTP contract', () => {
  it('serves live health and an OpenAPI document', async () => {
    const app = await createFolioApp();
    try {
      const server = await app.listen(0, '127.0.0.1');
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('No ephemeral test port');
      const base = `http://127.0.0.1:${addr.port}`;
      const health = await fetch(`${base}/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });
      const documentResponse = await fetch(`${base}/openapi-json`);
      expect(documentResponse.status).toBe(200);
      const document = await documentResponse.json();
      expect(document.openapi).toMatch(/^3\./);
      expect(document.paths['/v1/health'].get).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
