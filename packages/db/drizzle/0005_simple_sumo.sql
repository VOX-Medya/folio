CREATE TABLE "audio_segments" (
	"variant_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"asset_id" uuid NOT NULL,
	"text_block_id" uuid NOT NULL,
	"text_sha256" varchar(64) NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	CONSTRAINT "audio_segments_variant_id_chapter_id_ordinal_pk" PRIMARY KEY("variant_id","chapter_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "audio_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_revision_id" uuid NOT NULL,
	"language" varchar(12) NOT NULL,
	"voice_id" text NOT NULL,
	"source_label" text NOT NULL,
	"codec" varchar(24) NOT NULL,
	"variant_version" integer NOT NULL,
	"supersedes_variant_id" uuid,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_scope" varchar(24) NOT NULL,
	"owner_user_id" uuid,
	"storage_key" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime" varchar(80) NOT NULL,
	"duration_ms" integer,
	"status" varchar(24) DEFAULT 'pending_verify' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_variant_id_audio_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."audio_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_variants" ADD CONSTRAINT "audio_variants_content_revision_id_content_revisions_id_fk" FOREIGN KEY ("content_revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_segments_asset_idx" ON "audio_segments" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "audio_variants_revision_idx" ON "audio_variants" USING btree ("content_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_variants_version_idx" ON "audio_variants" USING btree ("content_revision_id","language","voice_id","variant_version");