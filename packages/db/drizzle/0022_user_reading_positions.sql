-- #36: one private, versioned cursor per verified account and immutable revision.
CREATE TABLE "user_reading_positions" (
  "user_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "revision_id" uuid NOT NULL REFERENCES "content_revisions"("id") ON DELETE RESTRICT,
  "work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE RESTRICT,
  "chapter_id" uuid NOT NULL,
  "block_id" uuid NOT NULL,
  "token_offset" integer NOT NULL DEFAULT 0,
  "audio_position_ms" integer,
  "mode" varchar(12) NOT NULL DEFAULT 'normal',
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_reading_positions_pk" PRIMARY KEY ("user_id", "revision_id"),
  CONSTRAINT "user_reading_positions_chapter_fk" FOREIGN KEY ("revision_id","chapter_id")
    REFERENCES "content_chapters"("revision_id","chapter_id") ON DELETE RESTRICT,
  CONSTRAINT "user_reading_positions_block_fk" FOREIGN KEY ("revision_id","block_id")
    REFERENCES "content_blocks"("revision_id","block_id") ON DELETE RESTRICT,
  CONSTRAINT "user_reading_positions_offset_ck" CHECK ("token_offset" BETWEEN 0 AND 30000),
  CONSTRAINT "user_reading_positions_audio_ck" CHECK ("audio_position_ms" IS NULL OR "audio_position_ms" BETWEEN 0 AND 86400000),
  CONSTRAINT "user_reading_positions_mode_ck" CHECK ("mode" IN ('normal','rsvp','audio')),
  CONSTRAINT "user_reading_positions_version_ck" CHECK ("version" BETWEEN 1 AND 2147483647)
);
--> statement-breakpoint
CREATE INDEX "user_reading_positions_work_idx" ON "user_reading_positions" ("work_id");
