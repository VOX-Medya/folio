# #30 - Verified Expo Web onboarding steps (partial)

## What is implemented

Only **after a real verified HttpOnly same-origin HTTPS web session** is established, the responsive Paperbound Expo profile mounts `WebOnboardingPanel`. The browser reads `GET /v1/me/onboarding` from the existing `VerifiedSelfSessionGuard` and PostgreSQL-backed account record, then resumes the actual server-owned `welcome → language → interests` stage. It never trusts userId, role, local storage, a fake signed-in state or a cache as authoritative progress.

- Shared `@folio/contracts` functions `fetchWebOnboarding` and `updateWebOnboarding` allow only exact browser HTTPS same-origin with `mode/credentials: same-origin`, `cache: no-store`, no-referrer, no redirects, strict Zod responses and no JavaScript-readable bearer. All PATCH bodies require `expectedVersion`, a server-issued fresh HMAC CSRF proof, stage/locale/interests only, and backend HTTP 200 + valid `OnboardingSnapshot`. A failed PATCH, network outage or 409 never optimistically advances the UI; reload fetches the server truth. A 401 attempts exactly one same-origin expired-cookie bootstrap and drops all private UI.
- Welcome advances to language, TR/EN selection advances to interests; in interests the selectable fiction/history/science/biography labels can be saved with **the same** `interests` stage and a newer optimistic version. The account's persisted locale is mirrored to shell UI preference; no private progress or bearer is put in session/local storage. Component state is discarded on logout, and late requests after unmount are ignored.
- Continuing later is supported by leaving the profile and reloading through the same verified account on another device. Backend owns all versions; race/foreign data is never silently overwritten.
- **Privacy consent is not yet implemented** in the account schema. The UI therefore intentionally does not submit `stage: complete` or claim an accepted privacy notice. For records previously marked complete by trusted internal fixtures, it only reports the server status without claiming that this screen verified consent.
- HTTP Expo Web dev, native and SSR do not expose a functioning authenticated onboarding panel. Responsive shell reuses 320px phone/tablet/desktop tokens and TR/EN, light/dark states.

## Verification and limitations

Seven browser-client Vitest tests cover native/HTTP/cross-origin rejection before network, owner-scoped no-store GET, strict no-leak DTO, CSRF-before-PATCH, invalid CSRF blocking mutation, stale-version 409 preservation, and revoked-cookie 401 best-effort cleanup. The Playwright HTTP negative test requires onboarding UI to be absent. Existing Folio-only PostgreSQL HTTPS smoke tests cover real backend update/409/auth isolation. Full CI also exports Web/Android/iOS **JavaScript only** and builds a non-deployed Docker image.

This is partial #30. Privacy consent persistence/legal approval, native Keychain/Keystore flows, real HTTPS browser accessibility/E2E, actual mobile device tests, public email signup/reset and admin MFA remain unfinished. Dependency release gate #7 stays BLOCKED. Desktop Commander `mehmet` Ubuntu usage is exhausted; GitHub-hosted Ubuntu CI is not a native device substitute. No production/secret changes.
