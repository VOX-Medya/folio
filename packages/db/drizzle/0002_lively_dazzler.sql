CREATE TABLE "content_blocks" (
	"revision_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"parent_block_id" uuid,
	"ordinal" integer NOT NULL,
	"kind" varchar(32) NOT NULL,
	"source_locator" jsonb NOT NULL,
	"text_sha256" varchar(64) NOT NULL,
	"source_text" text NOT NULL,
	"include_normal" boolean DEFAULT true NOT NULL,
	"include_rsvp" boolean DEFAULT false NOT NULL,
	"include_audio" boolean DEFAULT false NOT NULL,
	CONSTRAINT "content_blocks_revision_id_block_id_pk" PRIMARY KEY("revision_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "content_chapters" (
	"revision_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text NOT NULL,
	CONSTRAINT "content_chapters_revision_id_chapter_id_pk" PRIMARY KEY("revision_id","chapter_id")
);
--> statement-breakpoint
CREATE TABLE "content_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"edition_id" uuid NOT NULL,
	"language" varchar(12) NOT NULL,
	"parent_revision_id" uuid,
	"raw_artifact_key" text NOT NULL,
	"raw_sha256" varchar(64) NOT NULL,
	"normalized_sha256" varchar(64) NOT NULL,
	"parser_version" text NOT NULL,
	"provenance_id" uuid NOT NULL,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_provenance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_external_id" text,
	"license_claim" text,
	"source_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_revision_id_content_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_blocks" ADD CONSTRAINT "content_blocks_chapter_fk" FOREIGN KEY ("revision_id","chapter_id") REFERENCES "public"."content_chapters"("revision_id","chapter_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_chapters" ADD CONSTRAINT "content_chapters_revision_id_content_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_revisions" ADD CONSTRAINT "content_revisions_provenance_id_source_provenance_id_fk" FOREIGN KEY ("provenance_id") REFERENCES "public"."source_provenance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_block_order_unique" ON "content_blocks" USING btree ("revision_id","chapter_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "content_chapter_order_unique" ON "content_chapters" USING btree ("revision_id","ordinal");--> statement-breakpoint
CREATE INDEX "content_revisions_edition_idx" ON "content_revisions" USING btree ("edition_id");
--> statement-breakpoint
CREATE FUNCTION folio_reject_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Folio source and semantic blocks are immutable; create a new revision';
END; $$;
--> statement-breakpoint
CREATE TRIGGER folio_source_provenance_immutable BEFORE UPDATE OR DELETE ON "source_provenance"
FOR EACH ROW EXECUTE FUNCTION folio_reject_source_mutation();
--> statement-breakpoint
CREATE TRIGGER folio_content_chapters_immutable BEFORE UPDATE OR DELETE ON "content_chapters"
FOR EACH ROW EXECUTE FUNCTION folio_reject_source_mutation();
--> statement-breakpoint
CREATE TRIGGER folio_content_blocks_immutable BEFORE UPDATE OR DELETE ON "content_blocks"
FOR EACH ROW EXECUTE FUNCTION folio_reject_source_mutation();
--> statement-breakpoint
CREATE FUNCTION folio_restrict_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Folio content revisions cannot be deleted'; END IF;
  IF (NEW.edition_id, NEW.language, NEW.parent_revision_id, NEW.raw_artifact_key, NEW.raw_sha256,
      NEW.normalized_sha256, NEW.parser_version, NEW.provenance_id, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM
     (OLD.edition_id, OLD.language, OLD.parent_revision_id, OLD.raw_artifact_key, OLD.raw_sha256,
      OLD.normalized_sha256, OLD.parser_version, OLD.provenance_id, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'Folio content revision source identity is immutable'; END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER folio_content_revisions_protect BEFORE UPDATE OR DELETE ON "content_revisions"
FOR EACH ROW EXECUTE FUNCTION folio_restrict_revision_update();
