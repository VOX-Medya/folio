CREATE TABLE "user_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "normalized_email" varchar(254) NOT NULL,
  "status" varchar(24) DEFAULT 'pending_email' NOT NULL,
  "email_verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_accounts_email_lower_ck" CHECK ("normalized_email"=lower("normalized_email")),
  CONSTRAINT "user_accounts_status_ck" CHECK ("status" in ('pending_email','active','disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_accounts_normalized_email_unique" ON "user_accounts" USING btree ("normalized_email");
--> statement-breakpoint
CREATE TABLE "password_credentials" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "password_salt" varchar(32) NOT NULL,
  "password_digest" varchar(128) NOT NULL,
  "scheme" varchar(24) DEFAULT 'scrypt-v1' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "purpose" varchar(24) NOT NULL,
  "token_digest" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_challenges_purpose_ck" CHECK ("purpose" in ('verify_email','password_reset'))
);
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_challenges_token_unique" ON "auth_challenges" USING btree ("token_digest");
--> statement-breakpoint
CREATE INDEX "auth_challenges_user_purpose_idx" ON "auth_challenges" USING btree ("user_id","purpose");
--> statement-breakpoint
CREATE TABLE "user_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token_digest" varchar(64) NOT NULL,
  "device_label" varchar(80) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_user_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_accounts"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_unique" ON "user_sessions" USING btree ("token_digest");
--> statement-breakpoint
CREATE INDEX "user_sessions_user_active_idx" ON "user_sessions" USING btree ("user_id","revoked_at");
