import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql', schema: './src/schema.ts', out: './drizzle',
  dbCredentials: {url: process.env.DATABASE_URL || 'postgres://folio_lab:local-only@127.0.0.1:55432/folio_lab'},
  strict: true, verbose: true,
});
