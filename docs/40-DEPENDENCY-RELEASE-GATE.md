# V1-00 / #7 - Dependency release evidence and blocked gate

This is a release **blocker**, not a claim that the CI build is secure. The existing Metro 0.83.8 structural graph check is separate from registry advisories. After PR #101, the current lockfile excludes image-size and live registry audit reports 2 HIGH (node-forge/braces) plus 5 MODERATE; the former two image-size advisories are resolved at dependency-graph level, not a native-runtime security certification. No suppression or compatibility-breaking override is justified by that mismatch alone.

The command `pnpm audit --json > dependency-audit.json || true; pnpm security:release-check` makes three things explicit:
1. Current advisory totals from the live audit have to be parsed and zero moderate/high/critical for a pass.
2. Any remaining known-vulnerable lockfile versions of node-forge 1.4.0 or braces 3.0.3 fail even if the external audit misses them.
3. Missing/invalid audit evidence fails closed, regardless of successful Expo export, Playwright, or Docker build.

The GitHub CI step remains `continue-on-error` **only because development CI is not a deployment workflow**. Release readiness is blocked until this exact gate exits 0, advisory chains are investigated for reachability/compatible fixed releases, and native/browser acceptance completes. Do not commit `dependency-audit.json`, secrets, or waive this gate for production.

No dependency versions, Docker services, user data or production settings were changed in this PR.

## Scoped transitive hardening candidate (10 October 2026)

Ubuntu-only [dependency diagnostic](https://github.com/VOX-Medya/folio/actions/runs/38066064739) identified all **seven** current audit records, not merely the HIGH entries: `node-forge@1.4.0` (HIGH, `@expo/cli`), `braces@3.0.3` (HIGH, `micromatch` / React Native/Metro), `esbuild@0.18.20` (MODERATE, unused `drizzle-kit -> @esbuild-kit/esm-loader -> @esbuild-kit/core-utils`), `js-yaml@5.3.0` (MODERATE), `uuid@7.0.3` (`xcode` native config), `decode-uri-component@0.2.2` (`expo-router -> query-string@7`), and unpatched `sprintf-js@1.0.3` (`js-yaml@3`).

The scoped pnpm rules now delete the abandoned `drizzle-kit@0.31.11 > @esbuild-kit/esm-loader` edge that upstream confirms is unused, rather than forcing an incompatible `esbuild` binary onto the ORM. The original loader brought its own vulnerable `esbuild@0.18.20`. Separately only **`js-yaml@5.3.0`** is advanced to patched `5.4.1` within the same major, leaving the separate `js-yaml@3` legacy dependency intact. No migration, Expo SDK, React Native, provider, native binary or schema version changes. The new `dependency:hardening-check` runs inside `pnpm check` and its negative tests run in `pnpm ci:contract-test`, preventing these two known removals from regressing.

One-time branch-only Ubuntu lockfile generation [#38066366571](https://github.com/VOX-Medya/folio/actions/runs/38066366571) succeeded, deleted its own write-capable workflow, verified Metro 0.83.8 integrity and Drizzle Kit command availability, and measured **2 HIGH + 3 MODERATE** remaining. The **release check still fails** and is not suppressed. Do **not** override `uuid@7` with incompatible major without testing native Xcode/Expo config parsing; `decode-uri-component@0.5` is ESM-only and cannot simply replace the `query-string@7` CommonJS dependency. No fixed `node-forge`, `braces` or `sprintf-js` version was available in the reported advisory at verification. Closing #7 still requires a future supported Expo/React Native/toolchain update, a zero moderate/high audit and the full release/native acceptance set.
