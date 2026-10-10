# V1-00 / #7 - Dependency release evidence and blocked gate

This is a release **blocker**, not a claim that the CI build is secure. The existing Metro 0.83.8 structural graph check is separate from registry advisories. After PR #101, the current lockfile excludes image-size and live registry audit reports 2 HIGH (node-forge/braces) plus 5 MODERATE; the former two image-size advisories are resolved at dependency-graph level, not a native-runtime security certification. No suppression or compatibility-breaking override is justified by that mismatch alone.

The command `pnpm audit --json > dependency-audit.json || true; pnpm security:release-check` makes three things explicit:
1. Current advisory totals from the live audit have to be parsed and zero moderate/high/critical for a pass.
2. Any remaining known-vulnerable lockfile versions of node-forge 1.4.0 or braces 3.0.3 fail even if the external audit misses them.
3. Missing/invalid audit evidence fails closed, regardless of successful Expo export, Playwright, or Docker build.

The GitHub CI step remains `continue-on-error` **only because development CI is not a deployment workflow**. Release readiness is blocked until this exact gate exits 0, advisory chains are investigated for reachability/compatible fixed releases, and native/browser acceptance completes. Do not commit `dependency-audit.json`, secrets, or waive this gate for production.

No dependency versions, Docker services, user data or production settings were changed in this PR.
