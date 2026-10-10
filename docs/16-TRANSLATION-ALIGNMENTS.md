# Ready TR/EN translated revisions and verified text alignment (#15)

## V1 manual import boundary
`translation_links` connects an existing source content revision and **separate**, already prepared target-language revision through their actual editions under the same canonical work. Both revisions retain their own UUID, original UTF-8 content, SHA-256, chapter/block identities and source provenance. The translator is an existing author/contributor record, and the provenance is explicitly `manual_import`. No AI translation generation, corpus scraping, provider calls, or automatic target-text repairs are enabled.

`text_alignments` permits many rows for the same source and/or target block, supporting one-to-many and many-to-one paragraph mapping with revision-qualified composite foreign keys. The generated migration requires the unique index on the link revision triple **before** adding the composite alignment FK; this migration order is explicitly reviewed and tested. Submitted edges are initially `verified=false`; a trusted internal reviewer must verify alignment evidence and generate an audit entry. Human permissions and editorial review UI are not yet implemented, so this internal call is not a public endpoint.

For a switch, `resolveTranslationSwitch` selects **only verified** edges and sorts resulting target IDs by canonical chapter/block order. It never assumes two languages have the same number of tokens or copies a token offset. For pending/unverified/unmatched blocks, it returns only the corresponding chapter (or first chapter if missing), plus an explicit uncertainty warning. Future reader code (#36) must use this contract with rights and authentication before showing any actual book.

## Ubuntu test evidence
`pnpm check` validates TypeScript strict, lint, unit/API, build and OpenAPI drift. `bash infra/lab.sh migrate` and `bash infra/lab.sh test-db` pass using Folio-only PostgreSQL databases. `bash infra/lab.sh translation-smoke` passes on `folio_test`: separately authored EN source/TR target revisions with translator, 1:N and N:1 manually verified joins, rejection of wrong-revision block edges by FK and rollback, pending/unmapped chapter fallback, audit and confirmation the work remains unpublished. Only hand-authored synthetic fixture text is used. No real translation rights were claimed.

The shared batch manifest ingestion pipeline, actual translation file upload, editor review UI, rights-aware public reading and cross-device switch E2E remain under related V1 issues, so #15 stays open pending complete acceptance.
