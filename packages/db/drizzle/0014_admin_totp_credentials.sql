-- Internal-only admin TOTP verifier state (#30). No public route or credentials seeded.
-- The AES-256-GCM key lives outside PostgreSQL, never in migrations or source.
CREATE TABLE "admin_totp_credentials" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."user_accounts"("id") ON DELETE restrict,
  "ciphertext" text NOT NULL,
  "nonce" varchar(24) NOT NULL,
  "tag" varchar(32) NOT NULL,
  "key_version" varchar(12) DEFAULT 'v1' NOT NULL,
  "status" varchar(12) DEFAULT 'pending' NOT NULL,
  "pending_expires_at" timestamp with time zone,
  "enabled_at" timestamp with time zone,
  "last_accepted_step" bigint DEFAULT -1 NOT NULL,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "admin_totp_key_version_ck" CHECK ("key_version"='v1'),
  CONSTRAINT "admin_totp_status_ck" CHECK (
    ("status"='pending' AND "pending_expires_at" IS NOT NULL AND "enabled_at" IS NULL)
    OR ("status"='active' AND "pending_expires_at" IS NULL AND "enabled_at" IS NOT NULL)
  ),
  CONSTRAINT "admin_totp_step_ck" CHECK ("last_accepted_step">=-1),
  CONSTRAINT "admin_totp_failed_attempts_ck" CHECK ("failed_attempts">=0 AND "failed_attempts"<=5)
);
