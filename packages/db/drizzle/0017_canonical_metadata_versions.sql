-- #12: scalar canonical metadata optimistic concurrency. Existing work and
-- author identities, editions, source content and rights are untouched.
ALTER TABLE "authors"
  ADD COLUMN "metadata_version" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "authors_metadata_version_nonnegative_ck" CHECK ("metadata_version" >= 0);
--> statement-breakpoint
ALTER TABLE "works"
  ADD COLUMN "metadata_version" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "works_metadata_version_nonnegative_ck" CHECK ("metadata_version" >= 0);
