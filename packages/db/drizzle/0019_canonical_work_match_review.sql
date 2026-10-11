-- #12/#19 editorial candidate identity review, never canonical merge, import apply or publish.
CREATE TABLE "canonical_work_match_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE RESTRICT,
  "candidate_work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE RESTRICT,
  "work_version" integer NOT NULL,
  "candidate_version" integer NOT NULL,
  "evidence_kind" varchar(32) NOT NULL,
  "evidence_digest" varchar(64) NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'pending',
  "review_version" integer NOT NULL DEFAULT 0,
  "proposed_by" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "reviewed_by" uuid REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "rationale" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "canonical_work_match_order_ck" CHECK ("work_id"<"candidate_work_id"),
  CONSTRAINT "canonical_work_match_versions_ck" CHECK ("work_version">=0 AND "candidate_version">=0 AND "review_version">=0),
  CONSTRAINT "canonical_work_match_status_ck" CHECK ("status" IN ('pending','distinct','deferred')),
  CONSTRAINT "canonical_work_match_evidence_ck" CHECK (
    "evidence_kind" IN ('shared_source_sha256','same_title','manual') AND
    "evidence_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "canonical_work_match_decision_ck" CHECK (
    ("status"='pending' AND "reviewed_by" IS NULL AND "rationale" IS NULL) OR
    ("status"<>'pending' AND "reviewed_by" IS NOT NULL AND "rationale" IS NOT NULL AND
      length("rationale") BETWEEN 24 AND 1200 AND "reviewed_by"<>"proposed_by")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_work_match_pair_unique" ON "canonical_work_match_reviews" ("work_id","candidate_work_id");
--> statement-breakpoint
CREATE INDEX "canonical_work_match_peer_idx" ON "canonical_work_match_reviews" ("candidate_work_id","id");
--> statement-breakpoint
CREATE INDEX "canonical_work_match_work_idx" ON "canonical_work_match_reviews" ("work_id","id");
