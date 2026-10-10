CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" varchar(24) NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" varchar(64) NOT NULL,
	"status" varchar(24) DEFAULT 'staged' NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "import_batches_package_idx";--> statement-breakpoint
ALTER TABLE "import_batches" ALTER COLUMN "is_dry_run" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "import_batches" ALTER COLUMN "status" SET DEFAULT 'staged';--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "schema_version" varchar(24) DEFAULT '1.0.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_items_batch_external_unique" ON "import_items" USING btree ("batch_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "import_items_batch_status_idx" ON "import_items" USING btree ("batch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_package_unique" ON "import_batches" USING btree ("package_id");