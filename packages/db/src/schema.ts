import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, varchar, timestamp, integer, bigint, primaryKey, index, jsonb, boolean, uniqueIndex, foreignKey, check } from 'drizzle-orm/pg-core';

/** Minimal catalog storage baseline. Rights and revision modules follow their own V1 issues. */
export const authors = pgTable('authors', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalName: text('canonical_name').notNull(),
  sortName: text('sort_name').notNull(),
  metadataVersion: integer('metadata_version').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [index('authors_sort_name_idx').on(t.sortName)]);

export const works = pgTable('works', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalTitle: text('original_title').notNull(),
  originalLanguage: varchar('original_language', { length: 12 }).notNull(),
  firstPublicationYear: integer('first_publication_year'),
  publicationStatus: varchar('publication_status', {length: 24}).notNull().default('draft'),
  metadataVersion: integer('metadata_version').notNull().default(0),
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

/** A validated package is staged once. A dry-run NEVER inserts a batch. */
export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  packageId: text('package_id').notNull(),
  manifestChecksum: varchar('manifest_checksum', {length: 64}).notNull(),
  schemaVersion: varchar('schema_version', {length: 24}).notNull().default('1.0.0'),
  actorId: uuid('actor_id'),
  isDryRun: boolean('is_dry_run').notNull().default(false),
  status: varchar('status', {length: 24}).notNull().default('staged'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
  expectedItems: integer('expected_items').notNull().default(0),
}, t => [uniqueIndex('import_batches_package_unique').on(t.packageId)]);

/** Immutable staged item payloads and work-level resumable checkpoints. */
export const importItems = pgTable('import_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => importBatches.id, {onDelete: 'restrict'}),
  kind: varchar('kind', {length: 24}).notNull(),
  externalId: text('external_id').notNull(),
  payload: jsonb('payload').notNull(),
  payloadSha256: varchar('payload_sha256', {length:64}).notNull(),
  status: varchar('status', {length: 24}).notNull().default('staged'),
  appliedAt: timestamp('applied_at', {withTimezone: true}),
}, t => [
  uniqueIndex('import_items_batch_external_unique').on(t.batchId,t.kind,t.externalId),
  index('import_items_batch_status_idx').on(t.batchId,t.status),
]);

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

/** Ready, externally prepared translation revisions; no generation provider runs here. */
export const translationLinks = pgTable('translation_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceRevisionId: uuid('source_revision_id').notNull().references(()=>contentRevisions.id,{onDelete:'restrict'}),
  targetRevisionId: uuid('target_revision_id').notNull().references(()=>contentRevisions.id,{onDelete:'restrict'}),
  translatorId: uuid('translator_id').references(()=>authors.id,{onDelete:'restrict'}),
  provenance: jsonb('provenance').notNull(),
  status: varchar('status',{length:24}).notNull().default('pending'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  uniqueIndex('translation_link_versions_idx').on(t.sourceRevisionId,t.targetRevisionId),
  uniqueIndex('translation_link_verified_fk_idx').on(t.id,t.sourceRevisionId,t.targetRevisionId),
]);

/** One row per source->target semantic block pairing; supports 1:N and N:1 without fabricating text. */
export const textAlignments = pgTable('text_alignments', {
  linkId: uuid('link_id').notNull(),
  sourceRevisionId: uuid('source_revision_id').notNull(),
  targetRevisionId: uuid('target_revision_id').notNull(),
  sourceBlockId: uuid('source_block_id').notNull(),
  targetBlockId: uuid('target_block_id').notNull(),
  alignmentKind: varchar('alignment_kind',{length:24}).notNull().default('manual'),
  verified: boolean('verified').notNull().default(false),
  verifiedBy: uuid('verified_by'),
  verifiedAt: timestamp('verified_at',{withTimezone:true}),
},t=>[
  primaryKey({columns:[t.linkId,t.sourceBlockId,t.targetBlockId]}),
  foreignKey({columns:[t.linkId,t.sourceRevisionId,t.targetRevisionId],foreignColumns:[translationLinks.id,translationLinks.sourceRevisionId,translationLinks.targetRevisionId],name:'alignments_translation_scope_fk'}).onDelete('restrict'),
  foreignKey({columns:[t.sourceRevisionId,t.sourceBlockId],foreignColumns:[contentBlocks.revisionId,contentBlocks.blockId],name:'alignments_source_block_fk'}).onDelete('restrict'),
  foreignKey({columns:[t.targetRevisionId,t.targetBlockId],foreignColumns:[contentBlocks.revisionId,contentBlocks.blockId],name:'alignments_target_block_fk'}).onDelete('restrict'),
]);

/** Internal-only media metadata. Neither verified bytes nor publication
 * rights may be inferred from a submitted manifest or its storage key.
 * Legacy catalog references MUST NEVER be interpreted as filesystem paths.
 */
export const mediaAssets=pgTable('media_assets',{
  id:uuid('id').primaryKey().defaultRandom(),
  ownerScope:varchar('owner_scope',{length:24}).notNull(),
  ownerUserId:uuid('owner_user_id'),
  storageKey:text('storage_key').notNull(),
  sha256:varchar('sha256',{length:64}).notNull(),
  sizeBytes:integer('size_bytes').notNull(),
  mime:varchar('mime',{length:80}).notNull(),
  durationMs:integer('duration_ms'),
  status:varchar('status',{length:24}).notNull().default('pending_verify'),
  verifiedAt:timestamp('verified_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  index('media_assets_owner_status_idx').on(t.ownerScope,t.ownerUserId,t.status),
  uniqueIndex('media_assets_id_owner_unique').on(t.id,t.ownerUserId),
  check('media_assets_owner_ck',sql`(
    (${t.ownerScope}='catalog' and ${t.ownerUserId} is null) or
    (${t.ownerScope}='private-user' and ${t.ownerUserId} is not null)
  )`),
  check('media_assets_private_key_ck',sql`${t.ownerScope}<>'private-user' or
    ${t.storageKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`),
  check('media_assets_integrity_ck',sql`
    ${t.sha256} ~ '^[0-9a-f]{64}$' and
    ${t.sizeBytes}>0 and ${t.sizeBytes}<=1073741824 and
    ${t.mime} in ('text/plain','application/pdf','application/epub+zip','audio/mp4','audio/ogg') and
    (${t.durationMs} is null or ${t.durationMs}>0)`),
  check('media_assets_status_ck',sql`
    ${t.status} in ('pending_verify','verified','rejected','deleted') and
    (${t.status}<>'verified' or ${t.verifiedAt} is not null) and
    (${t.status}<>'pending_verify' or ${t.verifiedAt} is null)`),
]);
/** Reservation rows serialize quota admission across PostgreSQL connections.
 * This is PRIVATE-USER only; catalog imports have separate editorial rights.
 * A reservation is NOT proof that uploaded bytes or MIME are verified.
 */
export const storageUploadReservations=pgTable('storage_upload_reservations',{
  id:uuid('id').primaryKey().defaultRandom(),
  ownerUserId:uuid('owner_user_id').notNull(),
  reservedBytes:integer('reserved_bytes').notNull(),
  status:varchar('status',{length:24}).notNull().default('reserved'),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  committedAssetId:uuid('committed_asset_id').references(()=>mediaAssets.id,{onDelete:'restrict'}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  index('storage_upload_reservations_owner_status_idx').on(t.ownerUserId,t.status),
  uniqueIndex('storage_upload_reservations_asset_unique').on(t.committedAssetId),
  check('storage_upload_reservations_positive_ck',sql`${t.reservedBytes}>0`),
  check('storage_upload_reservations_status_ck',sql`${t.status} in ('reserved','committed','released')`),
  check('storage_upload_reservations_commit_shape_ck',sql`(
    (${t.status}='committed' and ${t.committedAssetId} is not null) or
    (${t.status}<>'committed' and ${t.committedAssetId} is null)
  )`),
  check('storage_upload_reservations_bounded_ck',sql`${t.reservedBytes}<=1073741824`),
  foreignKey({columns:[t.committedAssetId,t.ownerUserId],
    foreignColumns:[mediaAssets.id,mediaAssets.ownerUserId],
    name:'storage_upload_reservations_asset_owner_fk'}).onDelete('restrict'),
]);

/** V1 self-hosted accounts. No existing catalog rows, rights, or admin roles are modified. */
export const userAccounts=pgTable('user_accounts',{
  id:uuid('id').primaryKey().defaultRandom(),
  normalizedEmail:varchar('normalized_email',{length:254}).notNull(),
  status:varchar('status',{length:24}).notNull().default('pending_email'),
  emailVerifiedAt:timestamp('email_verified_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  uniqueIndex('user_accounts_normalized_email_unique').on(t.normalizedEmail),
  check('user_accounts_email_lower_ck',sql`${t.normalizedEmail}=lower(${t.normalizedEmail})`),
  check('user_accounts_status_ck',sql`${t.status} in ('pending_email','active','disabled')`),
]);

/** Password secrets are salted, slow-hashed and never stored in audit records. */
export const passwordCredentials=pgTable('password_credentials',{
  userId:uuid('user_id').primaryKey().references(()=>userAccounts.id,{onDelete:'restrict'}),
  passwordSalt:varchar('password_salt',{length:32}).notNull(),
  passwordDigest:varchar('password_digest',{length:128}).notNull(),
  scheme:varchar('scheme',{length:24}).notNull().default('scrypt-v1'),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
});

/** A verification or recovery challenge is single-use and stores SHA-256, not bearer bytes. */
export const authChallenges=pgTable('auth_challenges',{
  id:uuid('id').primaryKey().defaultRandom(),
  userId:uuid('user_id').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  purpose:varchar('purpose',{length:24}).notNull(),
  tokenDigest:varchar('token_digest',{length:64}).notNull(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  consumedAt:timestamp('consumed_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  uniqueIndex('auth_challenges_token_unique').on(t.tokenDigest),
  index('auth_challenges_user_purpose_idx').on(t.userId,t.purpose),
  check('auth_challenges_purpose_ck',sql`${t.purpose} in ('verify_email','password_reset')`),
]);

/** Revocable per-device bearer tokens are persisted ONLY as irreversible hashes. */
export const userSessions=pgTable('user_sessions',{
  id:uuid('id').primaryKey().defaultRandom(),
  userId:uuid('user_id').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  tokenDigest:varchar('token_digest',{length:64}).notNull(),
  deviceLabel:varchar('device_label',{length:80}).notNull(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
  revokedAt:timestamp('revoked_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  uniqueIndex('user_sessions_token_unique').on(t.tokenDigest),
  index('user_sessions_user_active_idx').on(t.userId,t.revokedAt),
]);

/** Database-owned admin roles. No HTTP caller can grant roles, and an ordinary
 * verified password session does not acquire any admin permissions. */
export const adminRoleMemberships=pgTable('admin_role_memberships',{
  userId:uuid('user_id').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  role:varchar('role',{length:24}).notNull(),
  grantedBy:uuid('granted_by').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  grantedAt:timestamp('granted_at',{withTimezone:true}).notNull().defaultNow(),
  revokedAt:timestamp('revoked_at',{withTimezone:true}),
},t=>[
  primaryKey({columns:[t.userId,t.role]}),
  index('admin_role_memberships_revocation_idx').on(t.userId,t.revokedAt),
  check('admin_role_memberships_role_ck',
    sql`${t.role} in ('superadmin','editor','rights','audio','moderator','read-only')`),
  check('admin_role_memberships_revocation_ck',
    sql`${t.revokedAt} is null or ${t.revokedAt}>=${t.grantedAt}`),
]);

/** MFA proof is tied to ONE already verified device session. An actual TOTP or
 * WebAuthn verifier must be built before any production row can be issued.
 * No default, no role auto-activation, and max proof duration is 12 hours. */
export const adminSessionMfa=pgTable('admin_session_mfa',{
  sessionId:uuid('session_id').primaryKey().references(()=>userSessions.id,{onDelete:'restrict'}),
  userId:uuid('user_id').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  method:varchar('method',{length:24}).notNull(),
  verifiedAt:timestamp('verified_at',{withTimezone:true}).notNull(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>[
  index('admin_session_mfa_user_idx').on(t.userId),
  check('admin_session_mfa_method_ck',
    sql`${t.method} in ('totp','webauthn')`),
  check('admin_session_mfa_expiry_ck',
    sql`${t.expiresAt}>${t.verifiedAt} and ${t.expiresAt}<=${t.verifiedAt}+interval '12 hours'`),
]);

/** TOTP seed is ALWAYS 256-bit AES-GCM encrypted with a server-only key.
 * Enrollment never grants privilege; lastAcceptedStep is a PostgreSQL-backed
 * monotonic replay fence shared by every device. No row/seed is provisioned. */
export const adminTotpCredentials=pgTable('admin_totp_credentials',{
  userId:uuid('user_id').primaryKey().references(()=>userAccounts.id,{onDelete:'restrict'}),
  ciphertext:text('ciphertext').notNull(),
  nonce:varchar('nonce',{length:24}).notNull(),
  tag:varchar('tag',{length:32}).notNull(),
  keyVersion:varchar('key_version',{length:12}).notNull().default('v1'),
  status:varchar('status',{length:12}).notNull().default('pending'),
  pendingExpiresAt:timestamp('pending_expires_at',{withTimezone:true}),
  enabledAt:timestamp('enabled_at',{withTimezone:true}),
  lastAcceptedStep:bigint('last_accepted_step',{mode:'number'}).notNull().default(-1),
  failedAttempts:integer('failed_attempts').notNull().default(0),
  lockedUntil:timestamp('locked_until',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  check('admin_totp_key_version_ck',sql`${t.keyVersion} in ('v1','v2')`),
  check('admin_totp_status_ck',sql`(
    (${t.status}='pending' and ${t.pendingExpiresAt} is not null and ${t.enabledAt} is null)
    or (${t.status}='active' and ${t.pendingExpiresAt} is null and ${t.enabledAt} is not null)
  )`),
  check('admin_totp_step_ck',sql`${t.lastAcceptedStep}>=-1`),
  check('admin_totp_failed_attempts_ck',
    sql`${t.failedAttempts}>=0 and ${t.failedAttempts}<=5`),
]);

/** Only dual-superadmin human REVIEW, never an MFA factor reset.
 * Pending/approved requests are unique per target and become immutable audit
 * evidence after cancellation or expiry. No recovery tokens are generated. */
export const adminMfaRecoveryRequests=pgTable('admin_mfa_recovery_requests',{
  id:uuid('id').primaryKey().defaultRandom(),
  targetUserId:uuid('target_user_id').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  proposedBy:uuid('proposed_by').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  proposalReference:varchar('proposal_reference',{length:64}).notNull(),
  reason:text('reason').notNull(),
  status:varchar('status',{length:12}).notNull().default('pending'),
  approvedBy:uuid('approved_by').references(()=>userAccounts.id,{onDelete:'restrict'}),
  approvedAt:timestamp('approved_at',{withTimezone:true}),
  closedAt:timestamp('closed_at',{withTimezone:true}),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  expiresAt:timestamp('expires_at',{withTimezone:true}).notNull(),
},t=>[
  uniqueIndex('admin_mfa_recovery_one_open_per_target_idx')
    .on(t.targetUserId).where(sql`${t.status} in ('pending','approved')`),
  index('admin_mfa_recovery_target_created_idx').on(t.targetUserId,t.createdAt),
  check('admin_mfa_recovery_status_ck',
    sql`${t.status} in ('pending','approved','cancelled','expired')`),
  check('admin_mfa_recovery_approvers_ck',
    sql`${t.proposedBy}<>${t.targetUserId} and (
      ${t.approvedBy} is null or
      (${t.approvedBy}<>${t.proposedBy} and ${t.approvedBy}<>${t.targetUserId})
    )`),
  check('admin_mfa_recovery_expires_ck',
    sql`${t.expiresAt}>${t.createdAt} and
      ${t.expiresAt}<=${t.createdAt}+interval '24 hours'`),
  check('admin_mfa_recovery_approval_ck',sql`(
    (${t.status}='pending' and ${t.approvedBy} is null
      and ${t.approvedAt} is null and ${t.closedAt} is null)
    or (${t.status}='approved' and ${t.approvedBy} is not null
      and ${t.approvedAt} is not null and ${t.closedAt} is null)
    or (${t.status} in ('cancelled','expired') and ${t.closedAt} is not null
      and ((${t.approvedBy} is null and ${t.approvedAt} is null)
        or (${t.approvedBy} is not null and ${t.approvedAt} is not null)))
  )`),
]);

/** Persistent, privacy-preserving 15-minute auth-attempt counters. No raw IP/e-mail. */
export const authAttemptWindows=pgTable('auth_attempt_windows',{
  bucketKey:varchar('bucket_key',{length:64}).notNull(),
  windowStart:timestamp('window_start',{withTimezone:true}).notNull(),
  kind:varchar('kind',{length:12}).notNull(),
  action:varchar('action',{length:24}).notNull(),
  attempts:integer('attempts').notNull().default(1),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  primaryKey({columns:[t.bucketKey,t.windowStart]}),
  index('auth_attempt_windows_expiry_idx').on(t.windowStart),
  check('auth_attempt_windows_kind_ck',sql`${t.kind} in ('ip','account')`),
  check('auth_attempt_windows_action_ck',sql`${t.action} in ('login','register','password_reset')`),
  check('auth_attempt_windows_attempts_ck',sql`${t.attempts}>0`),
]);

/** Language/interests/onboarding progress belongs to the backend, not a device cache. */
export const userOnboarding=pgTable('user_onboarding',{
  userId:uuid('user_id').primaryKey().references(()=>userAccounts.id,{onDelete:'restrict'}),
  stage:varchar('stage',{length:24}).notNull().default('welcome'),
  locale:varchar('locale',{length:2}).notNull().default('tr'),
  interests:jsonb('interests').$type<string[]>().notNull().default([]),
  version:integer('version').notNull().default(0),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  check('user_onboarding_stage_ck',sql`${t.stage} in ('welcome','language','interests','complete')`),
  check('user_onboarding_locale_ck',sql`${t.locale} in ('tr','en')`),
  check('user_onboarding_version_ck',sql`${t.version}>=0`),
]);

/** Every replacement is a distinct complete variant, so old listener cursors remain valid. */
export const audioVariants=pgTable('audio_variants',{
  id:uuid('id').primaryKey().defaultRandom(),
  contentRevisionId:uuid('content_revision_id').notNull().references(()=>contentRevisions.id,{onDelete:'restrict'}),
  language:varchar('language',{length:12}).notNull(),
  voiceId:text('voice_id').notNull(),
  sourceLabel:text('source_label').notNull(),
  codec:varchar('codec',{length:24}).notNull(),
  variantVersion:integer('variant_version').notNull(),
  supersedesVariantId:uuid('supersedes_variant_id'),
  status:varchar('status',{length:24}).notNull().default('draft'),
  createdBy:uuid('created_by').notNull(),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  index('audio_variants_revision_idx').on(t.contentRevisionId),
  uniqueIndex('audio_variants_version_idx').on(t.contentRevisionId,t.language,t.voiceId,t.variantVersion),
]);

export const audioSegments=pgTable('audio_segments',{
  variantId:uuid('variant_id').notNull().references(()=>audioVariants.id,{onDelete:'restrict'}),
  chapterId:uuid('chapter_id').notNull(),
  ordinal:integer('ordinal').notNull(),
  assetId:uuid('asset_id').notNull().references(()=>mediaAssets.id,{onDelete:'restrict'}),
  textBlockId:uuid('text_block_id').notNull(),
  textSha256:varchar('text_sha256',{length:64}).notNull(),
  startMs:integer('start_ms').notNull(),
  endMs:integer('end_ms').notNull(),
},t=>[
  primaryKey({columns:[t.variantId,t.chapterId,t.ordinal]}),
  index('audio_segments_asset_idx').on(t.assetId),
]);

/** Completion receipt is committed atomically with each job's DB side effects. */
export const jobCompletionReceipts = pgTable('job_completion_receipts', {
  queueName: varchar('queue_name', {length: 80}).notNull(),
  operationKey: varchar('operation_key', {length: 200}).notNull(),
  payloadSha256: varchar('payload_sha256', {length: 64}).notNull(),
  firstJobId: uuid('first_job_id').notNull(),
  completedAt: timestamp('completed_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [primaryKey({columns: [t.queueName, t.operationKey]})]);

/** Editor review of a canonical pair, not an import merge or publication grant. */
export const canonicalWorkMatchReviews=pgTable('canonical_work_match_reviews',{
  id:uuid('id').primaryKey().defaultRandom(),
  workId:uuid('work_id').notNull().references(()=>works.id,{onDelete:'restrict'}),
  candidateWorkId:uuid('candidate_work_id').notNull().references(()=>works.id,{onDelete:'restrict'}),
  workVersion:integer('work_version').notNull(),
  candidateVersion:integer('candidate_version').notNull(),
  evidenceKind:varchar('evidence_kind',{length:32}).notNull(),
  evidenceDigest:varchar('evidence_digest',{length:64}).notNull(),
  status:varchar('status',{length:24}).notNull().default('pending'),
  reviewVersion:integer('review_version').notNull().default(0),
  proposedBy:uuid('proposed_by').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  reviewedBy:uuid('reviewed_by').references(()=>userAccounts.id,{onDelete:'restrict'}),
  rationale:text('rationale'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  uniqueIndex('canonical_work_match_pair_unique').on(t.workId,t.candidateWorkId),
  index('canonical_work_match_peer_idx').on(t.candidateWorkId,t.id),
  index('canonical_work_match_work_idx').on(t.workId,t.id),
  check('canonical_work_match_order_ck',sql`${t.workId}<${t.candidateWorkId}`),
  check('canonical_work_match_versions_ck',sql`${t.workVersion}>=0 AND ${t.candidateVersion}>=0 AND ${t.reviewVersion}>=0`),
  check('canonical_work_match_status_ck',sql`${t.status} IN ('pending','distinct','deferred')`),
  check('canonical_work_match_evidence_ck',sql`${t.evidenceKind} IN ('shared_source_sha256','shared_isbn','same_title','manual') AND ${t.evidenceDigest} ~ '^[0-9a-f]{64}$'`),
  check('canonical_work_match_decision_ck',sql`(
    (${t.status}='pending' AND ${t.reviewedBy} IS NULL AND ${t.rationale} IS NULL) OR
    (${t.status}<>'pending' AND ${t.reviewedBy} IS NOT NULL AND
      ${t.rationale} IS NOT NULL AND length(${t.rationale}) BETWEEN 24 AND 1200 AND
      ${t.reviewedBy}<>${t.proposedBy})
  )`),
]);

/** A CLAIMED incoming package work compared to an existing canonical work.
 * It NEVER approves staging, canonical merge, rights or publication. */
export const importCandidateReviews=pgTable('import_candidate_reviews',{
  id:uuid('id').primaryKey().defaultRandom(),
  packageId:uuid('package_id').notNull(),
  manifestChecksum:varchar('manifest_checksum',{length:64}).notNull(),
  incomingWorkId:uuid('incoming_work_id').notNull(),
  incomingTitle:text('incoming_title').notNull(),
  incomingLanguage:varchar('incoming_language',{length:12}).notNull(),
  claimedSourceSha256:varchar('claimed_source_sha256',{length:64}),
  inputDigest:varchar('input_digest',{length:64}).notNull(),
  candidateWorkId:uuid('candidate_work_id').notNull().references(()=>works.id,{onDelete:'restrict'}),
  candidateWorkVersion:integer('candidate_work_version').notNull(),
  candidateWorkStatus:varchar('candidate_work_status',{length:24}).notNull(),
  evidenceKind:varchar('evidence_kind',{length:32}).notNull(),
  evidenceDigest:varchar('evidence_digest',{length:64}).notNull(),
  status:varchar('status',{length:24}).notNull().default('pending'),
  reviewVersion:integer('review_version').notNull().default(0),
  proposedBy:uuid('proposed_by').notNull().references(()=>userAccounts.id,{onDelete:'restrict'}),
  reviewedBy:uuid('reviewed_by').references(()=>userAccounts.id,{onDelete:'restrict'}),
  rationale:text('rationale'),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
  updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  uniqueIndex('import_candidate_review_identity_unique').on(t.packageId,t.incomingWorkId,t.candidateWorkId),
  index('import_candidate_review_candidate_idx').on(t.candidateWorkId,t.id),
  index('import_candidate_review_package_idx').on(t.packageId,t.id),
  check('import_candidate_review_different_id_ck',sql`${t.incomingWorkId}<>${t.candidateWorkId}`),
  check('import_candidate_review_lang_ck',sql`${t.incomingLanguage} IN ('tr','en')`),
  check('import_candidate_review_title_ck',sql`length(${t.incomingTitle}) BETWEEN 1 AND 600`),
  check('import_candidate_review_digests_ck',sql`
    ${t.manifestChecksum} ~ '^[a-f0-9]{64}$' AND
    ${t.inputDigest} ~ '^[a-f0-9]{64}$' AND
    ${t.evidenceDigest} ~ '^[a-f0-9]{64}$' AND
    (${t.claimedSourceSha256} IS NULL OR ${t.claimedSourceSha256} ~ '^[a-f0-9]{64}$')
  `),
  check('import_candidate_review_versions_ck',sql`${t.candidateWorkVersion}>=0 AND ${t.reviewVersion}>=0`),
  check('import_candidate_review_evidence_ck',sql`${t.evidenceKind} IN ('claimed_source_sha256','claimed_title')`),
  check('import_candidate_review_status_ck',sql`${t.status} IN ('pending','distinct','deferred')`),
  check('import_candidate_review_decision_ck',sql`(
    (${t.status}='pending' AND ${t.reviewedBy} IS NULL AND ${t.rationale} IS NULL) OR
    (${t.status}<>'pending' AND ${t.reviewedBy} IS NOT NULL AND
      ${t.rationale} IS NOT NULL AND length(${t.rationale}) BETWEEN 24 AND 1200 AND
      ${t.proposedBy}<>${t.reviewedBy})
  )`),
]);
