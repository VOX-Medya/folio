# #30 - Same-origin web device session management (partial)

The responsive Expo Web profile now has a manually opened device session inventory and owner-only revoke controls when the **existing verified** HttpOnly web session is active. The V1 account endpoint already uses the backend `VerifiedSelfSessionGuard`, PostgreSQL account ownership and device-session audit; this change never introduces a user directory, client-defined account ID, or public account search.

## Browser transport

- `fetchWebDeviceSessions` uses only the browser's exact HTTPS origin and `GET /v1/me/sessions`, with `credentials/mode: same-origin`, no-store, no-referrer and no redirects. The response must be HTTP 200 and match the strict device inventory DTO; unexpected email, bearer, account details or extra fields cause rejection.
- `revokeWebDeviceSession` validates the target UUID **before any network access**, fetches a fresh per-session CSRF proof and sends `DELETE /v1/me/sessions/:sessionId` with only same-origin cookie transport, the CSRF header and no request body. Only HTTP 204 is success. The backend confirms account ownership; foreign/missing IDs are not enumerated.
- No session bearer is ever readable from JavaScript or written into a browser store. Device inventory stays only in component state while the verified panel is mounted. Logout, expired session and self-revocation clear it.
- HTTP Expo dev, SSR and native JavaScript cannot activate this UI. Android/iOS secure key storage and real native device acceptance tests remain separate.

## Negative and CI checks

Vitest covers SSR/non-HTTPS/cross-origin rejection before sending cookies, strict response DTO and no extra sensitive fields, same-origin request metadata, fresh CSRF, invalid UUID rejection, 401/404 server errors, missing CSRF and non-204 DELETE. CI retains Folio-only PostgreSQL/HTTPS smokes, Expo Web/Android/iOS JS exports, Playwright HTTP negative tests and non-deploy Docker build. These tests are not a real browser HTTPS device-management E2E or iOS/Android device build.

This is **partial #30**. Public signup/verified-email delivery, password reset, admin MFA, native secure storage, trusted production TLS topology, actual same-origin HTTPS browser acceptance and #7 dependency release gate remain incomplete. No production deployment or secrets.
