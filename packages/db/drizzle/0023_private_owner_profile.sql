-- #39: keep owner-only profile and onboarding locale/version in one private row.
ALTER TABLE "user_onboarding" ADD COLUMN "display_name" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD COLUMN "visibility" varchar(12) DEFAULT 'private' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD COLUMN "deletion_requested_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_visibility_ck"
  CHECK ("visibility" IN ('private','friends'));
--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_display_name_ck"
  CHECK (length("display_name")<=80);
