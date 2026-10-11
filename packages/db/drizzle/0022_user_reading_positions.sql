-- #36: private per-account, immutable-revision reading cursor. One CAS version.
CREATE TABLE "user_reading_positions" (
  "user_id" uuid NOT NULL REFERENCES "user_accounts"("id") ON DELETE RESTRICT,
  "revision_id" uuid NOT NULL REFERENCES "content_revisions"("id") ON DELETE RESTRICT,
  "chapter_id" uuid NOT NULL,
  "block_id" uuid NOT NULL,
  "word_index" integer NOT NULL DEFAULT 0,
  "audio_second" integer NOT NULL DEFAULT 0,
  "mode" varchar(12) NOT NULL DEFAULT 'normal',
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_reading_positions_pk" PRIMARY KEY ("user_id","revision_id"),
  CONSTRAINT "user_reading_position_chapter_fk"
    FOREIGN KEY ("revision_id","chapter_id")
      REFERENCES "content_chapters"("revision_id","chapter_id") ON DELETE RESTRICT,
  CONSTRAINT "user_reading_position_block_fk"
    FOREIGN KEY ("revision_id","block_id")
      REFERENCES "content_blocks"("revision_id","block_id") ON DELETE RESTRICT,
  CONSTRAINT "user_reading_position_cursor_ck"
    CHECK ("word_index" BETWEEN 0 AND 100000 AND
      "audio_second" BETWEEN 0 AND 43200 AND "version">=1),
  CONSTRAINT "user_reading_position_mode_ck"
    CHECK ("mode" IN ('normal','rsvp','audio'))
);
