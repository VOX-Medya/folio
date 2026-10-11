-- #40: invite-only mutual friendship, no user directory or discoverable profile.
CREATE TABLE "user_friend_invites" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "code_hash" varchar(64) NOT NULL UNIQUE,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "user_friend_invites_hash_ck" CHECK ("code_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "user_friend_links" (
  "left_user_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "right_user_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "requested_by" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "status" varchar(12) DEFAULT 'pending' NOT NULL,
  "blocked_by" uuid REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "user_friend_links_pk" PRIMARY KEY ("left_user_id","right_user_id"),
  CONSTRAINT "user_friend_links_pair_ck" CHECK ("left_user_id"<"right_user_id"),
  CONSTRAINT "user_friend_links_requester_ck" CHECK ("requested_by" IN ("left_user_id","right_user_id")),
  CONSTRAINT "user_friend_links_status_ck" CHECK ("status" IN ('pending','accepted','blocked')),
  CONSTRAINT "user_friend_links_block_ck" CHECK (
    ("status"='blocked' AND "blocked_by" IN ("left_user_id","right_user_id"))
    OR ("status"<>'blocked' AND "blocked_by" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "user_friend_links_right_idx" ON "user_friend_links" ("right_user_id");
