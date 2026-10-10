CREATE TABLE "author_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"locale" varchar(12),
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "author_external_ids" (
	"author_id" uuid NOT NULL,
	"source" varchar(80) NOT NULL,
	"external_id" text NOT NULL,
	CONSTRAINT "author_external_ids_source_external_id_pk" PRIMARY KEY("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "edition_contributors" (
	"edition_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"role" varchar(32) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "edition_contributors_edition_id_author_id_role_pk" PRIMARY KEY("edition_id","author_id","role")
);
--> statement-breakpoint
CREATE TABLE "edition_identifiers" (
	"edition_id" uuid NOT NULL,
	"kind" varchar(24) NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "edition_identifiers_edition_id_kind_value_pk" PRIMARY KEY("edition_id","kind","value")
);
--> statement-breakpoint
CREATE TABLE "editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"language" varchar(12) NOT NULL,
	"label" text NOT NULL,
	"publisher" text,
	"published_at" timestamp with time zone,
	"status" varchar(24) DEFAULT 'draft' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"language" varchar(12) NOT NULL,
	"title" text NOT NULL,
	"kind" varchar(24) DEFAULT 'alternate' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "author_aliases" ADD CONSTRAINT "author_aliases_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_external_ids" ADD CONSTRAINT "author_external_ids_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_contributors" ADD CONSTRAINT "edition_contributors_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_contributors" ADD CONSTRAINT "edition_contributors_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_identifiers" ADD CONSTRAINT "edition_identifiers_edition_id_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."editions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editions" ADD CONSTRAINT "editions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_titles" ADD CONSTRAINT "work_titles_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "author_aliases_author_idx" ON "author_aliases" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "author_external_ids_author_idx" ON "author_external_ids" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "edition_contributors_author_idx" ON "edition_contributors" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "editions_work_idx" ON "editions" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "work_titles_work_idx" ON "work_titles" USING btree ("work_id");