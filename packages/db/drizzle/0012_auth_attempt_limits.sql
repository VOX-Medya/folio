CREATE TABLE "auth_attempt_windows" (
  "bucket_key" varchar(64) NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "kind" varchar(12) NOT NULL,
  "action" varchar(24) NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_attempt_windows_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start"),
  CONSTRAINT "auth_attempt_windows_kind_ck" CHECK ("kind" in ('ip','account')),
  CONSTRAINT "auth_attempt_windows_action_ck" CHECK ("action" in ('login','register','password_reset')),
  CONSTRAINT "auth_attempt_windows_attempts_ck" CHECK ("attempts">0)
);
--> statement-breakpoint
CREATE INDEX "auth_attempt_windows_expiry_idx" ON "auth_attempt_windows" USING btree ("window_start");
