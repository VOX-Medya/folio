# #14 Rights reviewer concurrency negative test

A rights record may be reviewed only by a trusted internal RBAC caller. A withdrawal is irreversible for that record; a separate new rights-evidence record and independent human review would be required for any later license claim.

The `reviewRightsEvidence` PostgreSQL transaction now locks the selected `rights_records` row with `SELECT ... FOR UPDATE` **before** reading its `review_status` and writing the reviewer decision. Without this row-level serialization, two reviewers can both read the same pending status and an approval may write *after* a withdrawal, falsely restoring access. After the change, if approval wins first, withdrawal commits last; if withdrawal wins first, the other approval sees `withdrawn` and fails. Withdrawal audits remain tied to the same transaction.

`packages/db/scripts/rights-smoke.ts` runs four concurrent approval/withdrawal attempts using two independent PostgreSQL pools on isolated `folio_test`. Each contested record must finish **withdrawn**; the withdrawal audit is present exactly once. The test also continues to cover three-scope approval, territory limits, prohibited audio/translation/sharing, expiry, revocation and default deny.

This is an **internal** domain hardening only. No public media access, signed URL, unrestricted rights review endpoint or automatic catalog publication is enabled. Full #14 acceptance still requires auth/RBAC, all API and media route guards, strict territory binding to trusted request context and cache revocation after withdrawal. Production deployment requires separate approval.
