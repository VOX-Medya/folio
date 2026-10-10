import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, varchar, timestamp, integer, primaryKey, index, jsonb, boolean, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';

/** Minimal catalog storage baseline. Rights and revision modules follow their own V1 issues. */
export const authors = pgTable('authors', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalName: text('canonical_name').notNull(),
  sortName: text('sort_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('authors_sort_name_idx').on(t.sortName)]);

export const works = pgTable('works', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalTitle: text('original_title').notNull(),
  originalLanguage: varchar('original_language', { length: 12 }).notNull(),
  firstPublicationYear: integer('first_publication_year'),
  publicationStatus: varchar('publication_status', {length: 24}).notNull().default('draft'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [
  index('works_original_title_idx').on(t.originalTitle),
  index('works_original_title_trgm_idx').using('gin', sql`${t.originalTitle} gin_trgm_ops`),
]);

export const workAuthors = pgTable('work_authors', {
  workId: uuid('work_id').notNull().references(() => works.id, {onDelete: 'restrict'}),
  authorId: uuid('author_id').notNull().references(() => authors.id, {onDelete: 'restrict'}),
  sortOrder: integer('sort_order').notNull().default(0),
  contribution: varchar('contribution', {length: 32}).notNull().default('author'),
}, t => [primaryKey({columns: [t.workId, t.authorId]}), index('work_authors_author_idx').on(t.authorId)]);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: uuid('entity_id'),
  requestId: uuid('request_id'),
  beforeJson: jsonb('before_json'),
  afterJson: jsonb('after_json'),
  reason: text('reason'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [index('audit_events_created_idx').on(t.createdAt)]);

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  packageId: text('package_id').notNull(),
  manifestChecksum: varchar('manifest_checksum', {length: 64}).notNull(),
  isDryRun: boolean('is_dry_run').notNull().default(true),
  status: varchar('status', {length: 24}).notNull().default('pending'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [index('import_batches_package_idx').on(t.packageId)]);

/** Alternate local names; the canonical author record remains unchanged. */
export const authorAliases = pgTable('author_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  authorId: uuid('author_id').notNull().references(() => authors.id, {onDelete: 'restrict'}),
  locale: varchar('locale', {length: 12}),
  name: text('name').notNull(),
}, t => [index('author_aliases_author_idx').on(t.authorId)]);

export const authorExternalIds = pgTable('author_external_ids', {
  authorId: uuid('author_id').notNull().references(() => authors.id, {onDelete: 'restrict'}),
  source: varchar('source', {length: 80}).notNull(),
  externalId: text('external_id').notNull(),
}, t => [primaryKey({columns: [t.source, t.externalId]}), index('author_external_ids_author_idx').on(t.authorId)]);

export const workTitles = pgTable('work_titles', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id, {onDelete: 'restrict'}),
  language: varchar('language', {length: 12}).notNull(),
  title: text('title').notNull(),
  kind: varchar('kind', {length: 24}).notNull().default('alternate'),
}, t => [index('work_titles_work_idx').on(t.workId)]);

/** Editions and translations belong to the same work, but are independently identified. */
export const editions = pgTable('editions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id, {onDelete: 'restrict'}),
  language: varchar('language', {length: 12}).notNull(),
  label: text('label').notNull(),
  publisher: text('publisher'),
  publishedAt: timestamp('published_at', {withTimezone: true}),
  status: varchar('status', {length: 24}).notNull().default('draft'),
}, t => [index('editions_work_idx').on(t.workId)]);

/** ISBN and other identifiers cannot be used as globally unique work IDs. */
export const editionIdentifiers = pgTable('edition_identifiers', {
  editionId: uuid('edition_id').notNull().references(() => editions.id, {onDelete: 'restrict'}),
  kind: varchar('kind', {length: 24}).notNull(),
  value: text('value').notNull(),
}, t => [primaryKey({columns: [t.editionId, t.kind, t.value]})]);

export const editionContributors = pgTable('edition_contributors', {
  editionId: uuid('edition_id').notNull().references(() => editions.id, {onDelete: 'restrict'}),
  authorId: uuid('author_id').notNull().references(() => authors.id, {onDelete: 'restrict'}),
  role: varchar('role', {length: 32}).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, t => [primaryKey({columns: [t.editionId, t.authorId, t.role]}), index('edition_contributors_author_idx').on(t.authorId)]);

/** Provenance stores immutable source claims; rights approval remains a separate gate. */
export const sourceProvenance = pgTable('source_provenance', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceName: text('source_name').notNull(),
  sourceUrl: text('source_url'),
  sourceExternalId: text('source_external_id'),
  licenseClaim: text('license_claim'),
  sourceSnapshot: jsonb('source_snapshot'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
});

/** Text revisions point at immutable raw artifact hash/key; no original text is overwritten. */
export const contentRevisions = pgTable('content_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  editionId: uuid('edition_id').notNull().references(() => editions.id, {onDelete:'restrict'}),
  language: varchar('language', {length: 12}).notNull(),
  parentRevisionId: uuid('parent_revision_id'),
  rawArtifactKey: text('raw_artifact_key').notNull(),
  rawSha256: varchar('raw_sha256', {length:64}).notNull(),
  normalizedSha256: varchar('normalized_sha256', {length:64}).notNull(),
  parserVersion: text('parser_version').notNull(),
  provenanceId: uuid('provenance_id').notNull().references(() => sourceProvenance.id,{onDelete:'restrict'}),
  status: varchar('status', {length:24}).notNull().default('draft'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t => [index('content_revisions_edition_idx').on(t.editionId)]);

export const contentChapters = pgTable('content_chapters', {
  revisionId: uuid('revision_id').notNull().references(() => contentRevisions.id, {onDelete:'restrict'}),
  chapterId: uuid('chapter_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  heading: text('heading').notNull(),
},t => [
  primaryKey({columns:[t.revisionId,t.chapterId]}),
  uniqueIndex('content_chapter_order_unique').on(t.revisionId,t.ordinal),
]);

export const contentBlocks = pgTable('content_blocks', {
  revisionId: uuid('revision_id').notNull().references(() => contentRevisions.id,{onDelete:'restrict'}),
  blockId: uuid('block_id').notNull(),
  chapterId: uuid('chapter_id').notNull(),
  parentBlockId: uuid('parent_block_id'),
  ordinal: integer('ordinal').notNull(),
  kind: varchar('kind',{length:32}).notNull(),
  sourceLocator: jsonb('source_locator').notNull(),
  textSha256: varchar('text_sha256',{length:64}).notNull(),
  sourceText: text('source_text').notNull(),
  includeNormal: boolean('include_normal').notNull().default(true),
  includeRsvp: boolean('include_rsvp').notNull().default(false),
  includeAudio: boolean('include_audio').notNull().default(false),
},t => [
  primaryKey({columns:[t.revisionId,t.blockId]}),
  uniqueIndex('content_block_order_unique').on(t.revisionId,t.chapterId,t.ordinal),
  foreignKey({columns:[t.revisionId,t.chapterId],foreignColumns:[contentChapters.revisionId,contentChapters.chapterId],name:'content_blocks_chapter_fk'}).onDelete('restrict'),
]);

/** Scope-specific rights are reviewed independently and default to deny. */
export const rightsRecords = pgTable('rights_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  workId: uuid('work_id').notNull().references(() => works.id,{onDelete:'restrict'}),
  editionId: uuid('edition_id').references(() => editions.id,{onDelete:'restrict'}),
  revisionId: uuid('revision_id').references(() => contentRevisions.id,{onDelete:'restrict'}),
  sourceUrl: text('source_url'),
  evidence: text('evidence').notNull(),
  licenseKind: varchar('license_kind',{length:60}).notNull(),
  territories: varchar('territories',{length:2}).array().notNull(),
  displayAllowed: boolean('display_allowed').notNull().default(false),
  translationAllowed: boolean('translation_allowed').notNull().default(false),
  audioAllowed: boolean('audio_allowed').notNull().default(false),
  sharingAllowed: boolean('sharing_allowed').notNull().default(false),
  reviewStatus: varchar('review_status',{length:24}).notNull().default('pending'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at',{withTimezone:true}),
  expiresAt: timestamp('expires_at',{withTimezone:true}),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  index('rights_records_work_idx').on(t.workId),
  index('rights_records_edition_idx').on(t.editionId),
  index('rights_records_revision_idx').on(t.revisionId),
]);
