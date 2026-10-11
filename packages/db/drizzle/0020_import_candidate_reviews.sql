-- #19: unverified incoming package metadata review ONLY. No import staging or merge.
CREATE TABLE "import_candidate_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "package_id" uuid NOT NULL,
  "manifest_checksum" varchar(64) NOT NULL,
  "incoming_work_id" uuid NOT NULL,
  "incoming_title" text NOT NULL,
  "incoming_language" varchar(12) NOT NULL,
  "claimed_source_sha256" varchar(64),
  "input_digest" varchar(64) NOT NULL,
  "candidate_work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE RESTRICT,
  "candidate_work_version" integer NOT NULL,
  "candidate_work_status" varchar(24) NOT NULL,
  "evidence_kind" varchar(32) NOT NULL,
  "evidence_digest" varchar(64) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'pending',
  "review_version" integer NOT NULL DEFAULT 0,
  "proposed_by" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "reviewed_by" uuid REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "rationale" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "import_candidate_review_different_id_ck" CHECK ("incoming_work_id"<>"candidate_work_id"),
  CONSTRAINT "import_candidate_review_lang_ck" CHECK ("incoming_language" IN ('tr','en')),
  CONSTRAINT "import_candidate_review_title_ck" CHECK (length("incoming_title") BETWEEN 1 AND 600),
  CONSTRAINT "import_candidate_review_digests_ck" CHECK (
    "manifest_checksum" ~ '^[a-f0-9]{64}$' AND
    "input_digest" ~ '^[a-f0-9]{64}$' AND
    "evidence_digest" ~ '^[a-f0-9]{64}$' AND
    ("claimed_source_sha256" IS NULL OR "claimed_source_sha256" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "import_candidate_review_versions_ck" CHECK ("candidate_work_version">=0 AND "review_version">=0),
  CONSTRAINT "import_candidate_review_evidence_ck" CHECK ("evidence_kind" IN ('claimed_source_sha256','claimed_title')),
  CONSTRAINT "import_candidate_review_status_ck" CHECK ("status" IN ('pending','distinct','deferred')),
  CONSTRAINT "import_candidate_review_decision_ck" CHECK (
    ("status"='pending' AND "reviewed_by" IS NULL AND "rationale" IS NULL) OR
    ("status"<>'pending' AND "reviewed_by" IS NOT NULL AND "rationale" IS NOT NULL AND
      length("rationale") BETWEEN 24 AND 1200 AND "proposed_by"<>"reviewed_by")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "import_candidate_review_identity_unique"
  ON "import_candidate_reviews" ("package_id","incoming_work_id","candidate_work_id");
--> statement-breakpoint
CREATE INDEX "import_candidate_review_candidate_idx"
  ON "import_candidate_reviews" ("candidate_work_id","id");
--> statement-breakpoint
CREATE INDEX "import_candidate_review_package_idx"
  ON "import_candidate_reviews" ("package_id","id");
