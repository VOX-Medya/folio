CREATE TABLE "user_onboarding" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "stage" varchar(24) DEFAULT 'welcome' NOT NULL,
  "locale" varchar(2) DEFAULT 'tr' NOT NULL,
  "interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_onboarding_stage_ck" CHECK ("stage" in ('welcome','language','interests','complete')),
  CONSTRAINT "user_onboarding_locale_ck" CHECK ("locale" in ('tr','en')),
  CONSTRAINT "user_onboarding_version_ck" CHECK ("version">=0)
);
--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
