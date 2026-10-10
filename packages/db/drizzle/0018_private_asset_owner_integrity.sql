-- #26: forward-only, fail-closed integrity constraints. Existing rows, source
-- revisions, audit history and private byte volumes are NEVER rewritten.
-- If prior rows violate these invariants migration intentionally aborts; a
-- human must review them rather than silently granting "verified" status.
ALTER TABLE "media_assets"
  ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_owner_ck" CHECK (
    ("owner_scope"='catalog' AND "owner_user_id" IS NULL) OR
    ("owner_scope"='private-user' AND "owner_user_id" IS NOT NULL)
  );
--> statement-breakpoint
-- Only private-user assets are guaranteed to have opaque adapter keys.
-- Legacy catalog manifests may contain logical paths; never pass them to FS.
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_private_key_ck" CHECK (
    "owner_scope"<>'private-user' OR
    "storage_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
--> statement-breakpoint
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_integrity_ck" CHECK (
    "sha256" ~ '^[0-9a-f]{64}$' AND
    "size_bytes">0 AND "size_bytes"<=1073741824 AND
    "mime" IN ('text/plain','application/pdf','application/epub+zip','audio/mp4','audio/ogg') AND
    ("duration_ms" IS NULL OR "duration_ms">0)
  );
--> statement-breakpoint
-- The future scanner must bind verifiedAt to an actual scanned byte digest.
-- No API or scanner transitions are introduced by this migration.
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_status_ck" CHECK (
    "status" IN ('pending_verify','verified','rejected','deleted') AND
    ("status"<>'verified' OR "verified_at" IS NOT NULL) AND
    ("status"<>'pending_verify' OR "verified_at" IS NULL)
  );
--> statement-breakpoint
CREATE INDEX "media_assets_owner_status_idx"
  ON "media_assets" ("owner_scope","owner_user_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_id_owner_unique"
  ON "media_assets" ("id","owner_user_id");
--> statement-breakpoint
ALTER TABLE "storage_upload_reservations"
  ADD CONSTRAINT "storage_upload_reservations_commit_shape_ck" CHECK (
    ("status"='committed' AND "committed_asset_id" IS NOT NULL) OR
    ("status"<>'committed' AND "committed_asset_id" IS NULL)
  );
--> statement-breakpoint
ALTER TABLE "storage_upload_reservations"
  ADD CONSTRAINT "storage_upload_reservations_bounded_ck"
  CHECK ("reserved_bytes"<=1073741824);
--> statement-breakpoint
-- A committed quota reservation MUST refer to a media asset of its own owner.
-- It cannot borrow an asset ID from a different private owner or catalog scope.
ALTER TABLE "storage_upload_reservations"
  ADD CONSTRAINT "storage_upload_reservations_asset_owner_fk"
  FOREIGN KEY ("committed_asset_id","owner_user_id")
    REFERENCES "media_assets" ("id","owner_user_id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
