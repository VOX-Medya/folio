-- #12 additional editor-only bibliographic clue.
-- Existing reviews and decisions are retained; ISBN is not a unique work ID,
-- import approval, merge permission, or proof of publication rights.
ALTER TABLE "canonical_work_match_reviews"
  DROP CONSTRAINT "canonical_work_match_evidence_ck";
--> statement-breakpoint
ALTER TABLE "canonical_work_match_reviews"
  ADD CONSTRAINT "canonical_work_match_evidence_ck" CHECK (
    "evidence_kind" IN ('shared_source_sha256','shared_isbn','same_title','manual') AND
    "evidence_digest" ~ '^[0-9a-f]{64}$'
  );
