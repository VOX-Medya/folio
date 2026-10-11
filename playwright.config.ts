import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/admin-catalog-live.spec.ts',
  timeout: 45000,
  workers: 2,
  use: { browserName: 'chromium', channel: 'chrome', headless: true },
  webServer: [
    {
      command: 'pnpm --filter @folio/admin exec vite --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 90000,
    },
    {
      command: 'CI=1 pnpm --filter @folio/mobile exec expo start --web --port 4174 --host localhost',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
