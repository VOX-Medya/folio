import {defineConfig} from '@playwright/test';

/** Nested ONLY from admin-catalog-https-smoke with Folio-only folio_test DB,
 * direct Nest TLS, same-origin HTTPS proxy and synthetic MFA fixture. */
export default defineConfig({
  testDir:'./e2e',
  testMatch:'admin-catalog-live.spec.ts',
  timeout:110_000,
  workers:1,
  retries:0,
  use:{browserName:'chromium',channel:'chrome',headless:true,ignoreHTTPSErrors:true},
  webServer:[{
    command:'pnpm --filter @folio/admin exec vite --host 127.0.0.1 --port 4173 --strictPort',
    url:'http://127.0.0.1:4173',
    reuseExistingServer:false,
    timeout:90_000,
  }],
});
