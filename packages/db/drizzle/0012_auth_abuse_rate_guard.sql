CREATE TABLE "auth_rate_buckets" (
  "bucket_digest" varchar(64) PRIMARY KEY NOT NULL,
  "action" varchar(24) NOT NULL,
  "scope" varchar(12) NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "blocked_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_rate_buckets_scope_ck" CHECK ("scope" in ('account','network')),
  CONSTRAINT "auth_rate_buckets_action_ck" CHECK ("action" in ('login','signup','reset')),
  CONSTRAINT "auth_rate_buckets_attempts_ck" CHECK ("attempts">=0)
);
--> statement-breakpoint
CREATE INDEX "auth_rate_buckets_updated_idx" ON "auth_rate_buckets" USING btree ("updated_at");
