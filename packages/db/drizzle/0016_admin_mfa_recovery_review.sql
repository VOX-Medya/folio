-- #30: durable dual-control REVIEW ONLY, not a factor reset/permission issuer.
-- Every request requires an existing factor and two independently MFA-verified
-- superadmins. No operator action here resets OTP data or creates admin roles.
CREATE TABLE "admin_mfa_recovery_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_user_id" uuid NOT NULL REFERENCES "public"."user_accounts"("id") ON DELETE restrict,
  "proposed_by" uuid NOT NULL REFERENCES "public"."user_accounts"("id") ON DELETE restrict,
  "proposal_reference" varchar(64) NOT NULL,
  "reason" text NOT NULL,
  "status" varchar(12) DEFAULT 'pending' NOT NULL,
  "approved_by" uuid REFERENCES "public"."user_accounts"("id") ON DELETE restrict,
  "approved_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "admin_mfa_recovery_status_ck" CHECK ("status" IN ('pending','approved','cancelled','expired')),
  CONSTRAINT "admin_mfa_recovery_approvers_ck" CHECK (
    "proposed_by" <> "target_user_id"
    AND ("approved_by" IS NULL OR ("approved_by" <> "proposed_by" AND "approved_by" <> "target_user_id"))
  ),
  CONSTRAINT "admin_mfa_recovery_expires_ck" CHECK (
    "expires_at" > "created_at" AND
    "expires_at" <= "created_at" + interval '24 hours'
  ),
  CONSTRAINT "admin_mfa_recovery_approval_ck" CHECK (
    ("status" = 'pending' AND "approved_by" IS NULL AND "approved_at" IS NULL AND "closed_at" IS NULL)
    OR ("status" = 'approved' AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "closed_at" IS NULL)
    OR ("status" IN ('cancelled','expired') AND "closed_at" IS NOT NULL
      AND (("approved_by" IS NULL AND "approved_at" IS NULL) OR
           ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL)))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_mfa_recovery_one_open_per_target_idx"
ON "admin_mfa_recovery_requests" ("target_user_id")
WHERE "status" IN ('pending','approved');
--> statement-breakpoint
CREATE INDEX "admin_mfa_recovery_target_created_idx"
ON "admin_mfa_recovery_requests" ("target_user_id","created_at");
