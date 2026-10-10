# #30 - Same-origin browser web session client (partial)

## Implemented
The shared contracts library exports a **browser-only** web session client:
- `loginWebSession(options,{email,password})` posts strict input to `/v1/auth/web/login`, expects HTTP 204 and lets the browser receive the host-only, Secure, HttpOnly, SameSite=Strict cookie
- `fetchWebSessionCsrf(options)` requests `/v1/auth/web/csrf` with browser-managed cookies and only returns a validated 43-character transient HMAC CSRF header; this token must remain in component memory, not local/session storage
- `logoutWebSession(options)` fetches that proof then POSTs `/v1/auth/web/logout`, requiring server-side revocation and cookie clearing

Every call requires an actual browser environment with `window` and `document`, a literal HTTPS API origin identical to the current browser origin, `mode:'same-origin'`, `credentials:'same-origin'`, `cache:'no-store'`, denied redirects and no referrer. Inputs cannot set bearer, cookie, role, user ID or endpoint path. Errors contain only server status, safe code and correlation UUID, never credentials.

## Operational gate and unimplemented work
This client is **not** an enabled login screen. The NestJS backend remains opt-in `FOLIO_WEB_AUTH_MODE=direct-tls-only` and requires genuine TLS on its application socket, configured exact HTTPS origin and server-owned HMAC keys. Dev Expo Web HTTP cannot use these browser authentication methods; no weaker HTTP fallback, cross-origin cookie transport or proxy-header trust is added.

There is no native token persistence in this package. Android/iOS need verified platform Keychain/Keystore adapters, user-facing login and onboarding UI, native E2E and release security QA. Registration, email challenge dispatch, password reset and admin MFA remain open; `#30` is not completed. Dependency vulnerabilities keep `#7` blocked. No live deployment, real accounts, or SMTP are used.
