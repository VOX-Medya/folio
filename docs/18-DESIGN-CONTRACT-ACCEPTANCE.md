# Paperbound UI scope freeze / issue #8 acceptance evidence

## Source and scope
The two `design/reference` HTML prototypes are the authority for the **design specification**, not application feature code. `node tools/design/generate-screen-matrix.mjs --check` uses their 58 mobile and 30 admin source route IDs, verifies policy completeness and checks generated `docs/10-UI-SCREEN-MATRIX.md` plus `packages/ui-tokens/src/screen-matrix.generated.json` for drift.

V1: 52 mobile + 22 admin = 74 route contracts with one intended action, read/write state set (including loading, empty/validation, error, offline, permission) and explicit phone/tablet/desktop layout guidance. AFTER-V1: 6 mobile + 8 admin = 14 disabled routes without a V1 action/endpoint contract. User discovery/search and friend recommendations are not V1 routes; book/author search is V1. All of these counts are asserted automatically in `tools/design/screen-matrix.test.mjs`. This is **not** a claim that all prototype screens are already implemented.

The default V1 system is Paperbound/Parşömen. Semantic shared tokens cover mobile/admin light and dark surfaces, contrast-safe text, spacing, radius, typography, breakpoints (600, 1024), and minimum 44pt interactive targets. Final visual signoff is deferred to the actual production UI acceptance tests; no alternative theme engines are switched on. Both Expo Web and admin placeholder shells now honor the OS dark/light preference, without enabling any demo-only or AFTER-V1 feature.

## Ubuntu test evidence: 10 October 2026
- `pnpm ci:contract-test`: all manifest and cross-target JavaScript export verifier tests passed (4/4).
- `pnpm check`: lint, TypeScript, unit/HTTP tests, Web Admin builds, design matrix drift and OpenAPI snapshot passed.
- `pnpm e2e`: Chrome headless **14/14 PASS** for admin + Expo Web shells at widths **320, 390, 768, 1024, 1440, 1920** (no horizontal overflow), plus Paperbound light and dark rendered backgrounds for both shells.
- Earlier platform JS export contract verified Expo Web, Android Hermes and iOS Hermes bundles on Ubuntu. Native builds and actual tablet/phone visual QA remain under #29/#45/#48.

Acceptance here freezes the design matrix and token contract only. Real account, catalog, reader, admin CRUD, error/empty/offline/permission implementations and platform accessibility E2E belong to their corresponding feature issues; closing #8 does not mark those screens as delivered.
