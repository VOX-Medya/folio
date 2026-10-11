-- #31: Minimal personal shelf metadata. No user file uploads or public owner browsing.
CREATE TABLE "user_shelf_items" (
  "user_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE RESTRICT,
  "status" varchar(20) NOT NULL DEFAULT 'to-read',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_shelf_items_pk" PRIMARY KEY ("user_id","work_id"),
  CONSTRAINT "user_shelf_items_status_ck" CHECK ("status" IN ('to-read','reading'))
);
--> statement-breakpoint
CREATE INDEX "user_shelf_items_work_idx" ON "user_shelf_items" ("work_id");
