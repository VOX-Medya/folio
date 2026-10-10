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
