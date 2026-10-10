CREATE TABLE "storage_upload_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"reserved_bytes" integer NOT NULL,
	"status" varchar(24) DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"committed_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_upload_reservations_positive_ck" CHECK ("reserved_bytes" > 0),
	CONSTRAINT "storage_upload_reservations_status_ck" CHECK ("status" in ('reserved','committed','released'))
);
--> statement-breakpoint
ALTER TABLE "storage_upload_reservations" ADD CONSTRAINT "storage_upload_reservations_committed_asset_id_media_assets_id_fk" FOREIGN KEY ("committed_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "storage_upload_reservations_owner_status_idx" ON "storage_upload_reservations" USING btree ("owner_user_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_upload_reservations_asset_unique" ON "storage_upload_reservations" USING btree ("committed_asset_id");
