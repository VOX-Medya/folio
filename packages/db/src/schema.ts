import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, varchar, timestamp, integer, primaryKey, index, jsonb, boolean } from 'drizzle-orm/pg-core';

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
