CREATE TABLE "rights_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"edition_id" uuid,
	"revision_id" uuid,
	"source_url" text,
	"evidence" text NOT NULL,
	"license_kind" varchar(60) NOT NULL,
	"territories" varchar(2)[] NOT NULL,
	"display_allowed" boolean DEFAULT false NOT NULL,
	"translation_allowed" boolean DEFAULT false NOT NULL,
	"audio_allowed" boolean DEFAULT false NOT NULL,
	"sharing_allowed" boolean DEFAULT false NOT NULL,
	"review_status" varchar(24) DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rights_records" ADD CONSTRAINT "rights_records_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_records" ADD CONSTRAINT "rights_records_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_records" ADD CONSTRAINT "rights_records_revision_id_content_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."content_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rights_records_work_idx" ON "rights_records" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "rights_records_edition_idx" ON "rights_records" USING btree ("edition_id");--> statement-breakpoint
CREATE INDEX "rights_records_revision_idx" ON "rights_records" USING btree ("revision_id");