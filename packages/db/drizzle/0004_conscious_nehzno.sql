CREATE TABLE "text_alignments" (
	"link_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"source_block_id" uuid NOT NULL,
	"target_block_id" uuid NOT NULL,
	"alignment_kind" varchar(24) DEFAULT 'manual' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	CONSTRAINT "text_alignments_link_id_source_block_id_target_block_id_pk" PRIMARY KEY("link_id","source_block_id","target_block_id")
);
--> statement-breakpoint
CREATE TABLE "translation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"translator_id" uuid,
	"provenance" jsonb NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "translation_link_versions_idx" ON "translation_links" USING btree ("source_revision_id","target_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_link_verified_fk_idx" ON "translation_links" USING btree ("id","source_revision_id","target_revision_id");--> statement-breakpoint
ALTER TABLE "text_alignments" ADD CONSTRAINT "alignments_translation_scope_fk" FOREIGN KEY ("link_id","source_revision_id","target_revision_id") REFERENCES "public"."translation_links"("id","source_revision_id","target_revision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_alignments" ADD CONSTRAINT "alignments_source_block_fk" FOREIGN KEY ("source_revision_id","source_block_id") REFERENCES "public"."content_blocks"("revision_id","block_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_alignments" ADD CONSTRAINT "alignments_target_block_fk" FOREIGN KEY ("target_revision_id","target_block_id") REFERENCES "public"."content_blocks"("revision_id","block_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_links" ADD CONSTRAINT "translation_links_source_revision_id_content_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_links" ADD CONSTRAINT "translation_links_target_revision_id_content_revisions_id_fk" FOREIGN KEY ("target_revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_links" ADD CONSTRAINT "translation_links_translator_id_authors_id_fk" FOREIGN KEY ("translator_id") REFERENCES "public"."authors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
