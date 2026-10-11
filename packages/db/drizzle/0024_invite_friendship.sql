-- #40: private invitation codes, exactly one pair per two verified accounts.
CREATE TABLE "friend_invites" (
  "owner_id" uuid PRIMARY KEY NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "code_hash" varchar(64) NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "friend_invites_hash_ck" CHECK ("code_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "friend_invites_hash_unique" ON "friend_invites"("code_hash");
--> statement-breakpoint
CREATE TABLE "friend_pairs" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "lower_user_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "higher_user_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "requested_by_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "status" varchar(12) DEFAULT 'pending' NOT NULL,
  "blocked_by_id" uuid REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "friend_pairs_order_ck" CHECK ("lower_user_id" < "higher_user_id"),
  CONSTRAINT "friend_pairs_requester_ck" CHECK ("requested_by_id" IN ("lower_user_id","higher_user_id")),
  CONSTRAINT "friend_pairs_state_ck" CHECK ("status" IN ('pending','accepted','rejected','blocked')),
  CONSTRAINT "friend_pairs_blocked_ck" CHECK (
    ("status"='blocked' AND "blocked_by_id" IN ("lower_user_id","higher_user_id"))
    OR ("status"<>'blocked' AND "blocked_by_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "friend_pairs_unique" ON "friend_pairs"("lower_user_id","higher_user_id");
--> statement-breakpoint
CREATE INDEX "friend_pairs_higher_idx" ON "friend_pairs"("higher_user_id");
