# Folio V1 API implementation baseline (#9)

## Runtime and intended ownership
The API is a NestJS modular monolith, currently exposing only `/v1/health` and `/v1/system/capabilities`. OpenAPI docs at `/openapi`, JSON at `/openapi-json`, snapshot at `docs/api/openapi.v1.json`. The capability endpoint deliberately returns `available: false` until each product API is actually implemented. There are no mock users or catalog records.

- Every request receives a server-generated `x-request-id`, independent of untrusted incoming headers; the response error includes the same UUID.
- `@folio/contracts` contains cross-platform Zod validation and cursor/page/error schemas. The typed `fetchCapabilities` client can run on web/native/admin without Node-only Buffer use.
- Cursor pagination enforces bounded result size (1-50), a strict query shape and a canonical opaque cursor. Invalid and unknown cursors result in HTTP 400.
- An owner resource guard accepts a user context only when it is provided by trusted auth middleware. It denies absent or mismatched principal IDs; client-supplied IDs alone cannot authenticate a user. Real session attachment will be implemented with #30.
- Liveness `/v1/health` checks the process only; DB and queue readiness endpoints will be added as #10 integrates them. 200 liveness is not an assertion that Postgres is healthy.
- Contracts and error formats are tested over a real loopback HTTP listener. OpenAPI drift is blocked by `pnpm --filter @folio/server openapi:check` during `pnpm check`. Snapshot updates use `pnpm --filter @folio/server openapi:write`, followed by review and test.

## Future module boundaries
Auth/permissions, catalog/rights, reading/progress, social/invites, storage, import/export, audit and jobs share **one API** and **one DB**. No independent microservices, Redis, scraping, AI translation/TTS, or active provider integration is required for V1.

This baseline does not claim full RBAC, authentication, persistence, request throttling, content sanitization, or production readiness; those are tracked under V1 tasks #10, #12-#30, #45-#48. All private resources remain unavailable until proper authorization is implemented.
