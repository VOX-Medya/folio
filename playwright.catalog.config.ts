import {defineConfig} from '@playwright/test';

/** One real Expo Web -> direct HTTPS Nest -> Folio-only PostgreSQL journey. */
export default defineConfig({
  testDir:'./e2e',
  testMatch:['public-shelf-live.spec.ts','private-profile-live.spec.ts'],
  timeout:110_000,workers:1,retries:0,
  use:{browserName:'chromium',channel:'chrome',headless:true,ignoreHTTPSErrors:true},
  webServer:[{
    command:'CI=1 pnpm --filter @folio/mobile exec expo start --web --port 4174 --host localhost',
    url:'http://127.0.0.1:4174',reuseExistingServer:false,timeout:120_000,
  }],
});
