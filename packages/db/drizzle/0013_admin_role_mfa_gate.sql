-- V1 #30/#43: Persist memberships, but never grant them from a password login.
-- No seed, bootstrap admin, MFA issuance endpoint, or privileged API route.
CREATE TABLE "admin_role_memberships" (
  "user_id" uuid NOT NULL REFERENCES "public"."user_accounts"("id") ON DELETE restrict,
  "role" varchar(24) NOT NULL,
  "granted_by" uuid NOT NULL REFERENCES "public"."user_accounts"("id") ON DELETE restrict,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "admin_role_memberships_pk" PRIMARY KEY ("user_id","role"),
  CONSTRAINT "admin_role_memberships_role_ck"
    CHECK ("role" IN ('superadmin','editor','rights','audio','moderator','read-only')),
  CONSTRAINT "admin_role_memberships_revocation_ck"
    CHECK ("revoked_at" IS NULL OR "revoked_at">="granted_at")
);
--> statement-breakpoint
CREATE INDEX "admin_role_memberships_revocation_idx"
  ON "admin_role_memberships" ("user_id","revoked_at");
--> statement-breakpoint
-- Future verified MFA challenges alone may produce this row. No production
-- writer exists in V1 yet: default deny, including active superadmins.
CREATE TABLE "admin_session_mfa" (
  "session_id" uuid PRIMARY KEY NOT NULL
    REFERENCES "public"."user_sessions"("id") ON DELETE restrict,
  "user_id" uuid NOT NULL
    REFERENCES "public"."user_accounts"("id") ON DELETE restrict,
  "method" varchar(24) NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "admin_session_mfa_method_ck"
    CHECK ("method" IN ('totp','webauthn')),
  CONSTRAINT "admin_session_mfa_expiry_ck"
    CHECK ("expires_at">"verified_at"
      AND "expires_at"<="verified_at"+INTERVAL '12 hours')
);
--> statement-breakpoint
CREATE INDEX "admin_session_mfa_user_idx" ON "admin_session_mfa" ("user_id");
