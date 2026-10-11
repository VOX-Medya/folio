# Folio development CI acceleration, temporary, scoped

**Scope:** Development checks and manually selected CI feedback only. GitHub-hosted Ubuntu Actions is the **primary automated development/test environment**; local Desktop Commander `mehmet` is optional, not a CI prerequisite. GitHub Actions is NOT the live application host. This does NOT bypass account security, publishing-rights, package integrity, RBAC/MFA/CSRF, local-storage isolation or application-level audit. The complete test pipeline remains available; production build/publish/deploy is not enabled.

## Trigger matrix

| Event | `check` | `full-regression` | `clamav-native-protocol` |
| --- | --- | --- | --- |
| Ordinary PR | **required rapid unit/lint/TypeScript/OpenAPI and Metro/dependency-hardening** | skipped intentionally | skipped intentionally |
| PR labeled `ci:full` | rapid checks | **all existing comprehensive tests** | synthetic real ClamAV |
| Push to `main` | rapid checks | **all existing comprehensive tests** | synthetic real ClamAV |
| Every day 03:17 UTC | rapid checks | **all existing comprehensive tests** | synthetic real ClamAV |
| Manual `workflow_dispatch`, `validation=fast` | rapid checks | skipped intentionally | skipped intentionally |
| Manual `workflow_dispatch`, `validation=full` (default) | rapid checks | **all existing comprehensive tests** | synthetic real ClamAV |

`full-regression` is **the entire original `check` job**, unchanged: `pnpm check`, isolated Folio-only PostgreSQL and durable job integrations, all real HTTPS auth/RBAC/CSRF/rights/metadata smoke, Expo Web/Android/iOS JavaScript exports, CI negative tests, licenses, browser Playwright E2E, local non-deploy Docker build, and the dependency audit. It is no longer a **default PR** gate, but runs automatically on main and nightly, manually, or by adding the explicit `ci:full` label. The `check` job name is retained so an existing required check is not silently renamed or impersonated by a skipped job; it now explicitly reports only the rapid suite. Branch-protection settings have **not** been modified (access unavailable). Manually verify required statuses before altering them.

Manual `validation=fast` is only for quick development feedback, not for marking an issue complete or authorizing a release. Dependency advisory findings remain visible and nonblocking in development, while any failing `pnpm security:release-check` is **still a release blocker**, not a waived vulnerability. Do not disable runtime guards, privacy, audit, source integrity, or rights validation to make a PR green.

The rapid PR job still uses frozen pnpm lockfile, TypeScript builds and checks, ESLint, all available unit tests, OpenAPI snapshot and structural Metro/dependency-hardening checks. This is a **reduced test scope**, not evidence of successful PostgreSQL/Expo/device/Playwright validation. All missing full acceptance criteria must be recorded on the GitHub issue; do **not** close an issue or claim `completed` using only the rapid job.

For a feature touching database schema, auth, permissions, CSRF, user/private data, file handling, rights, publishing, import apply/resume, source revisions, storage, or releases, request `ci:full` on the PR **before merging** and wait for full success. For cosmetic and documentation-only work, full suite may run automatically on main/nightly. Security bug fixes must not be shipped without full verification.

## Re-enable full validation for release

Before any production build or live deployment:
1. Restore `full-regression` and `clamav-native-protocol` as required jobs on every PR and protect the main branch; do not rely on the rapid `check` status alone.
2. Run and verify the full isolated Ubuntu CI from the exact target SHA, including real device tests through the approved Ubuntu/Mac lab boundaries.
3. Resolve `node-forge`, `braces`, other HIGH/MODERATE advisories, then **enforce** `pnpm security:release-check` as a failure-producing deployment/release job (currently informational). No audit waivers in a production pipeline.
4. Verify content source file SHA-256, per-work import idempotency, rights/territory/translation/audio approvals, backups and restoration drills.
5. Obtain explicit user approval for any production build or deploy. This document is not that approval.

Current development is permitted only with these boundaries. This is not a release-readiness statement.
