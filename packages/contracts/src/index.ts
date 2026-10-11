import { z } from 'zod';
import { Base64 } from 'js-base64';

/** Contracts may be used by web, native and admin without framework imports. */
export const healthResponseSchema = z.object({status: z.literal('ok')}).strict();
export const readinessResponseSchema = z.object({status: z.literal('ready')}).strict();
/** Real admin TOTP endpoints remain explicitly gated by direct TLS.
 * Caller identity, admin role, server time and encryption key are NEVER inputs. */
export const adminTotpCodeRequestSchema=z.object({
  code:z.string().regex(/^\d{6}$/),
}).strict();
export const adminTotpEnrollResponseSchema=z.object({
  secretBase32:z.string().regex(/^[A-Z2-7]{32}$/),
  expiresAt:z.iso.datetime({offset:true}),
}).strict();
export const adminTotpVerifyResponseSchema=z.object({
  verified:z.literal(true),
  expiresAt:z.iso.datetime({offset:true}),
}).strict();
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.uuid(),
  }).strict(),
}).strict();

export const cursorQuerySchema = z.object({
  limit: z.preprocess(value => {
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return value;
  }, z.number().int().min(1).max(50).default(20)),
  cursor: z.string().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();

export const capabilitySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  available: z.boolean(),
  note: z.string(),
}).strict();
export const capabilityPageSchema = z.object({
  items: z.array(capabilitySchema),
  nextCursor: z.string().nullable(),
}).strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type CursorQuery = z.infer<typeof cursorQuerySchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type CapabilityPage = z.infer<typeof capabilityPageSchema>;

const MAX_CURSOR_BYTES = 128;
export function encodeCursor(id: string): string {
  if (!capabilitySchema.shape.id.safeParse(id).success) throw new Error('Invalid cursor identifier');
  return Base64.encodeURI(JSON.stringify({id, v: 1}));
}
export function decodeCursor(value: string): string {
  if (value.length > 180 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Malformed cursor');
  try {
    const decodedText = Base64.decode(value);
    if (decodedText.length > MAX_CURSOR_BYTES || Base64.encodeURI(decodedText) !== value) throw new Error('Malformed cursor');
    const decoded: unknown = JSON.parse(decodedText);
    const parsed = z.object({id: capabilitySchema.shape.id, v: z.literal(1)}).strict().safeParse(decoded);
    if (!parsed.success) throw new Error('Malformed cursor');
    return parsed.data.id;
  } catch {
    throw new Error('Malformed cursor');
  }
}

/** Stable, bounded, lexicographic opaque cursor pagination. */
export function paginateCapabilities(items: readonly Capability[], raw: unknown): CapabilityPage {
  const query = cursorQuerySchema.parse(raw);
  const cursorId = query.cursor ? decodeCursor(query.cursor) : null;
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const offset = cursorId === null ? 0 : sorted.findIndex(item => item.id === cursorId) + 1;
  if (cursorId !== null && offset === 0) throw new Error('Unknown cursor');
  const page = sorted.slice(offset, offset + query.limit);
  const hasMore = sorted.length > offset + query.limit;
  return capabilityPageSchema.parse({
    items: page,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!.id) : null,
  });
}

/** Safe shared system transport for responsive Web, Expo native and admin. */
export {fetchCapabilities,fetchSystemHealth,fetchSystemReadiness,SystemHttpError} from './system-client.js';

/** Safe, strictly bounded ADMIN-ONLY canonical search metadata.
 * No publication rights are inferred and no personal book content is returned. */
export const adminCatalogSearchQuerySchema=z.object({
  q:z.string().trim().min(1).max(120),
  limit:z.preprocess(value=>
    typeof value==='string'&&/^[1-9][0-9]?$/.test(value)?Number(value):value,
    z.number().int().min(1).max(50).default(20)),
  cursor:z.uuid().optional(),
}).strict();
export const adminCatalogWorkPageSchema=z.object({
  items:z.array(z.object({
    id:z.uuid(),
    originalTitle:z.string().min(1),
    originalLanguage:z.enum(['tr','en']),
    publicationStatus:z.string().min(1).max(24),
  }).strict()).max(50),
  nextCursor:z.uuid().nullable(),
}).strict();
export const adminCatalogAuthorPageSchema=z.object({
  items:z.array(z.object({
    id:z.uuid(),canonicalName:z.string().min(1),sortName:z.string().min(1),
  }).strict()).max(50),
  nextCursor:z.uuid().nullable(),
}).strict();
export type AdminCatalogWorkPage=z.infer<typeof adminCatalogWorkPageSchema>;
export type AdminCatalogAuthorPage=z.infer<typeof adminCatalogAuthorPageSchema>;

/** Internal draft-only canonical catalog commands. No public CRUD is exposed until RBAC. */
export const authorCreateSchema = z.object({
  canonicalName: z.string().trim().min(1).max(240),
  sortName: z.string().trim().min(1).max(240).optional(),
  aliases: z.array(z.object({name: z.string().trim().min(1).max(240), locale: z.string().min(2).max(12).optional()}).strict()).max(30).default([]),
  externalIds: z.array(z.object({source: z.string().min(1).max(80), externalId: z.string().min(1).max(400)}).strict()).max(30).default([]),
}).strict();
export const workCreateSchema = z.object({
  originalTitle: z.string().trim().min(1).max(600),
  originalLanguage: z.enum(['tr', 'en']),
  firstPublicationYear: z.number().int().min(-4000).max(2500).nullable().optional(),
  authors: z.array(z.object({
    authorId: z.uuid(), contribution: z.enum(['author', 'co-author', 'editor']).default('author'),
    sortOrder: z.number().int().min(0).max(10000).default(0),
  }).strict()).min(1).max(50),
  titles: z.array(z.object({language: z.enum(['tr', 'en']), title: z.string().trim().min(1).max(600), kind: z.enum(['original','translation','alternate'])}).strict()).max(40).default([]),
  editions: z.array(z.object({
    language: z.enum(['tr', 'en']), label: z.string().trim().min(1).max(400),
    publisher: z.string().trim().max(240).optional(),
    identifiers: z.array(z.object({kind: z.enum(['isbn-10','isbn-13','other']), value: z.string().trim().min(1).max(150)}).strict()).max(30).default([]),
    contributors: z.array(z.object({authorId: z.uuid(), role: z.enum(['author','translator','editor','illustrator']), sortOrder: z.number().int().min(0).default(0)}).strict()).max(50).default([]),
  }).strict()).max(50).default([]),
}).strict().superRefine((data, ctx) => {
  const ids = data.authors.map(a => a.authorId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: 'Duplicate work-author links'});
  if (!data.authors.some(a => a.contribution === 'author' || a.contribution === 'co-author')) ctx.addIssue({code:'custom',message:'Every work needs an author'});
});
export type AuthorCreate = z.infer<typeof authorCreateSchema>;
export type WorkCreate = z.infer<typeof workCreateSchema>;

/** Privileged metadata-only edits, never edition content or publishing status.
 * expectedVersion is the persisted canonical scalar metadata revision. */
const metadataVersionSchema=z.number().int().min(0).max(2147483647);
const expectedMetadataVersionSchema=z.number().int().min(0).max(2147483646);
export const canonicalAuthorMetadataPatchSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  canonicalName:z.string().trim().min(1).max(240).optional(),
  sortName:z.string().trim().min(1).max(240).optional(),
  aliases:z.array(z.object({
    name:z.string().trim().min(1).max(240),
    locale:z.string().min(2).max(12).optional(),
  }).strict()).max(30).optional(),
  externalIds:z.array(z.object({
    source:z.string().min(1).max(80),externalId:z.string().min(1).max(400),
  }).strict()).max(30).optional(),
}).strict().superRefine((input,ctx)=>{
  if(input.canonicalName===undefined&&input.sortName===undefined&&
    input.aliases===undefined&&input.externalIds===undefined){
    ctx.addIssue({code:'custom',message:'An author metadata change is required'});
  }
  if(input.externalIds){
    const keys=input.externalIds.map(x=>x.source+'\\0'+x.externalId);
    if(new Set(keys).size!==keys.length){
      ctx.addIssue({code:'custom',message:'Duplicate external author source IDs'});
    }
  }
});
export const canonicalWorkMetadataPatchSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  originalTitle:z.string().trim().min(1).max(600).optional(),
  firstPublicationYear:z.number().int().min(-4000).max(2500).nullable().optional(),
}).strict().superRefine((input,ctx)=>{
  if(input.originalTitle===undefined&&input.firstPublicationYear===undefined){
    ctx.addIssue({code:'custom',message:'A work metadata change is required'});
  }
});
export type CanonicalAuthorMetadataPatch=z.infer<typeof canonicalAuthorMetadataPatchSchema>;
export type CanonicalWorkMetadataPatch=z.infer<typeof canonicalWorkMetadataPatchSchema>;
export const canonicalAuthorMetadataUpdatedSchema=z.object({
  id:z.uuid(),metadataVersion:metadataVersionSchema,
}).strict();
export const canonicalWorkMetadataUpdatedSchema=z.object({
  id:z.uuid(),metadataVersion:metadataVersionSchema,
  publicationStatus:z.literal('draft'),
}).strict();


/** Append metadata-only draft relationships under an already-verified
 * canonical work. Never import text, approve rights, or publish a revision. */
export const adminCatalogEditionAppendSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  language:z.enum(['tr','en']),
  label:z.string().trim().min(1).max(400),
  publisher:z.string().trim().max(240).optional(),
  identifiers:z.array(z.object({
    kind:z.enum(['isbn-10','isbn-13','other']),
    value:z.string().trim().min(1).max(150),
  }).strict()).max(30).default([]),
  contributors:z.array(z.object({
    authorId:z.uuid(),
    role:z.enum(['author','translator','editor','illustrator']),
    sortOrder:z.number().int().min(0).max(10000).default(0),
  }).strict()).max(50).default([]),
}).strict().superRefine((input,ctx)=>{
  const ids=input.identifiers.map(row=>row.kind+'\\0'+row.value);
  if(new Set(ids).size!==ids.length){
    ctx.addIssue({code:'custom',message:'Duplicate edition identifier'});
  }
  const roles=input.contributors.map(row=>row.authorId+'\\0'+row.role);
  if(new Set(roles).size!==roles.length){
    ctx.addIssue({code:'custom',message:'Duplicate edition contributor role'});
  }
});
/** Only metadata on an already DRAFT edition within a DRAFT work.
 * Never mutate edition language (revision alignment), source text, rights or
 * publication. A caller must explicitly supply the current parent work
 * metadataVersion; provided arrays are COMPLETE replacement lists. */
export const adminCatalogEditionMetadataPatchSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  label:z.string().trim().min(1).max(400).optional(),
  publisher:z.string().trim().max(240).nullable().optional(),
  identifiers:z.array(z.object({
    kind:z.enum(['isbn-10','isbn-13','other']),
    value:z.string().trim().min(1).max(150),
  }).strict()).max(30).optional(),
  contributors:z.array(z.object({
    authorId:z.uuid(),role:z.enum(['author','translator','editor','illustrator']),
    sortOrder:z.number().int().min(0).max(10000).default(0),
  }).strict()).max(50).optional(),
}).strict().superRefine((input,ctx)=>{
  if(input.label===undefined&&input.publisher===undefined&&
    input.identifiers===undefined&&input.contributors===undefined){
    ctx.addIssue({code:'custom',message:'Edition metadata change required'});
  }
  if(input.identifiers){
    const keys=input.identifiers.map(row=>row.kind+'\\0'+row.value);
    if(new Set(keys).size!==keys.length){
      ctx.addIssue({code:'custom',message:'Duplicate edition identifiers'});
    }
  }
  if(input.contributors){
    const keys=input.contributors.map(row=>row.authorId+'\\0'+row.role);
    if(new Set(keys).size!==keys.length){
      ctx.addIssue({code:'custom',message:'Duplicate contributor role'});
    }
  }
});
export type AdminCatalogEditionMetadataPatch=z.infer<typeof adminCatalogEditionMetadataPatchSchema>;
export const adminCatalogEditionMetadataUpdatedSchema=z.object({
  id:z.uuid(),workId:z.uuid(),metadataVersion:metadataVersionSchema,
  status:z.literal('draft'),
}).strict();

export const adminCatalogTitleAppendSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  language:z.enum(['tr','en']),
  title:z.string().trim().min(1).max(600),
  kind:z.enum(['translation','alternate']),
}).strict();
export const adminCatalogWorkAuthorAppendSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  authorId:z.uuid(),
  contribution:z.enum(['author','co-author','editor']).default('author'),
  sortOrder:z.number().int().min(0).max(10000).default(0),
}).strict();
export type AdminCatalogEditionAppend=z.infer<typeof adminCatalogEditionAppendSchema>;
export type AdminCatalogTitleAppend=z.infer<typeof adminCatalogTitleAppendSchema>;
export type AdminCatalogWorkAuthorAppend=z.infer<typeof adminCatalogWorkAuthorAppendSchema>;
/** Strict versioned edits to optional DRAFT work relations.
 * ORIGINAL title and last real author are protected by DB-side checks. */
export const adminCatalogTitleMetadataPatchSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  title:z.string().trim().min(1).max(600).optional(),
  language:z.enum(['tr','en']).optional(),
  kind:z.enum(['alternate','translation']).optional(),
}).strict().superRefine((v,ctx)=>{
  if(v.title===undefined&&v.language===undefined&&v.kind===undefined){
    ctx.addIssue({code:'custom',message:'Optional title change required'});
  }
});
export const adminCatalogWorkAuthorMetadataPatchSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  contribution:z.enum(['author','co-author','editor']).optional(),
  sortOrder:z.number().int().min(0).max(10000).optional(),
}).strict().superRefine((v,ctx)=>{
  if(v.contribution===undefined&&v.sortOrder===undefined){
    ctx.addIssue({code:'custom',message:'Author relation change required'});
  }
});
export type AdminCatalogTitleMetadataPatch=z.infer<typeof adminCatalogTitleMetadataPatchSchema>;
export type AdminCatalogWorkAuthorMetadataPatch=z.infer<typeof adminCatalogWorkAuthorMetadataPatchSchema>;
export const adminCatalogEditionRemovedSchema=z.object({
  id:z.uuid(),workId:z.uuid(),metadataVersion:metadataVersionSchema,
  removed:z.literal(true),
}).strict();

/** Removal only affects a DRAFT work's optional title/author link. */
export const adminCatalogRelationRemoveSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
}).strict();
export type AdminCatalogRelationRemove=z.infer<typeof adminCatalogRelationRemoveSchema>;
export const adminCatalogEditionAppendedSchema=z.object({
  id:z.uuid(),workId:z.uuid(),
  metadataVersion:metadataVersionSchema,
  status:z.literal('draft'),
}).strict();
export const adminCatalogTitleAppendedSchema=z.object({
  id:z.uuid(),workId:z.uuid(),metadataVersion:metadataVersionSchema,
}).strict();
export const adminCatalogWorkAuthorAppendedSchema=z.object({
  workId:z.uuid(),authorId:z.uuid(),
  metadataVersion:metadataVersionSchema,
}).strict();

/** Administrative work identity evidence ledger. A decision is NOT a
 * canonical merge, import approval, rights grant or publication. */
export const adminWorkMatchProposeSchema=z.object({
  candidateWorkId:z.uuid(),
}).strict();
export const adminWorkMatchDecisionSchema=z.object({
  expectedVersion:expectedMetadataVersionSchema,
  decision:z.enum(['distinct','deferred']),
  rationale:z.string().trim().min(24).max(1200),
}).strict();
const workMatchStatus=z.enum(['pending','distinct','deferred']);
const workMatchEvidence=z.enum(['shared_source_sha256','same_title','manual']);
export const adminWorkMatchResultSchema=z.object({
  id:z.uuid(),workId:z.uuid(),candidateWorkId:z.uuid(),
  status:workMatchStatus,reviewVersion:metadataVersionSchema,changed:z.boolean(),
}).strict();
export const adminWorkMatchQuerySchema=z.object({
  cursor:z.uuid().optional(),
}).strict();
export const adminWorkMatchPageSchema=z.object({
  items:z.array(z.object({
    id:z.uuid(),workId:z.uuid(),candidateWorkId:z.uuid(),
    peerWorkId:z.uuid(),peerTitle:z.string().min(1).max(600),
    status:workMatchStatus,evidenceKind:workMatchEvidence,
    reviewVersion:metadataVersionSchema,snapshotCurrent:z.boolean(),
  }).strict()).max(20),
  nextCursor:z.uuid().nullable(),
}).strict();
export type AdminWorkMatchPropose=z.infer<typeof adminWorkMatchProposeSchema>;
export type AdminWorkMatchDecision=z.infer<typeof adminWorkMatchDecisionSchema>;
export type AdminWorkMatchResult=z.infer<typeof adminWorkMatchResultSchema>;
export type AdminWorkMatchPage=z.infer<typeof adminWorkMatchPageSchema>;

/** #19 package metadata CLAIM, not a verified manifest or import permit.
 * Only an existing canonical work candidate is selected by the URL. */
export const adminImportCandidateProposeSchema=z.object({
  packageId:z.uuid(),
  manifestChecksum:z.string().regex(/^[a-f0-9]{64}$/),
  incomingWorkId:z.uuid(),
  incomingTitle:z.string().trim().min(1).max(600),
  incomingLanguage:z.enum(['tr','en']),
  sourceSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const importCandidateEvidence=z.enum(['claimed_source_sha256','claimed_title']);
export const adminImportCandidateResultSchema=z.object({
  id:z.uuid(),candidateWorkId:z.uuid(),packageId:z.uuid(),incomingWorkId:z.uuid(),
  status:workMatchStatus,reviewVersion:metadataVersionSchema,changed:z.boolean(),
  provenanceVerified:z.literal(false),
}).strict();
export const adminImportCandidatePageSchema=z.object({
  items:z.array(z.object({
    id:z.uuid(),candidateWorkId:z.uuid(),packageId:z.uuid(),incomingWorkId:z.uuid(),
    incomingTitle:z.string().min(1).max(600),incomingLanguage:z.enum(['tr','en']),
    status:workMatchStatus,evidenceKind:importCandidateEvidence,
    reviewVersion:metadataVersionSchema,snapshotCurrent:z.boolean(),
    provenanceVerified:z.literal(false),
  }).strict()).max(20),
  nextCursor:z.uuid().nullable(),
}).strict();
export type AdminImportCandidatePropose=z.infer<typeof adminImportCandidateProposeSchema>;
export type AdminImportCandidateResult=z.infer<typeof adminImportCandidateResultSchema>;
export type AdminImportCandidatePage=z.infer<typeof adminImportCandidatePageSchema>;

/** HTTP draft creation acknowledges opaque canonical IDs only.
 * No arbitrary publication status, owner or raw text may be returned. */
export const adminCatalogAuthorCreatedSchema=z.object({
  id:z.uuid(),
}).strict();
export const adminCatalogWorkCreatedSchema=z.object({
  id:z.uuid(),publicationStatus:z.literal('draft'),
}).strict();

/** Strict canonical resource IDs from authenticated admin URL params. */
export const adminCatalogIdSchema=z.uuid();

/** ADMIN ONLY: a safe projection of ONE repeatable-read relational snapshot.
 * Public catalog/rights access is a different, still default-deny workflow. */
const catalogDetailWorkSchema=z.object({
  id:z.uuid(),
  originalTitle:z.string().min(1),
  originalLanguage:z.enum(['tr','en']),
  firstPublicationYear:z.number().int().nullable(),
  publicationStatus:z.string().min(1).max(24),
  metadataVersion:metadataVersionSchema,
}).strict();
const catalogDetailWorkAuthorSchema=z.object({
  id:z.uuid(),name:z.string().min(1),
  role:z.enum(['author','co-author','editor']),
  sortOrder:z.number().int().min(0),
}).strict();
const catalogDetailTitleSchema=z.object({
  id:z.uuid(),language:z.enum(['tr','en']),
  title:z.string().min(1),kind:z.enum(['original','translation','alternate']),
}).strict();
const catalogDetailEditionSchema=z.object({
  id:z.uuid(),language:z.enum(['tr','en']),
  label:z.string().min(1),publisher:z.string().nullable(),
  status:z.string().min(1).max(24),
  identifiers:z.array(z.object({
    kind:z.enum(['isbn-10','isbn-13','other']),value:z.string().min(1),
  }).strict()).max(250),
  contributors:z.array(z.object({
    authorId:z.uuid(),
    role:z.enum(['author','translator','editor','illustrator']),
    sortOrder:z.number().int().min(0),
  }).strict()).max(250),
}).strict();
export const adminCatalogWorkDetailSchema=z.object({
  work:catalogDetailWorkSchema,
  authors:z.array(catalogDetailWorkAuthorSchema).max(250),
  titles:z.array(catalogDetailTitleSchema).max(250),
  editions:z.array(catalogDetailEditionSchema).max(250),
}).strict();
export const adminCatalogAuthorDetailSchema=z.object({
  author:z.object({
    id:z.uuid(),canonicalName:z.string().min(1),sortName:z.string().min(1),
    metadataVersion:metadataVersionSchema,
  }).strict(),
  aliases:z.array(z.object({
    id:z.uuid(),name:z.string().min(1),locale:z.string().nullable(),
  }).strict()).max(500),
  externalIds:z.array(z.object({
    source:z.string().min(1),externalId:z.string().min(1),
  }).strict()).max(500),
}).strict();
export type AdminCatalogWorkDetail=z.infer<typeof adminCatalogWorkDetailSchema>;
export type AdminCatalogAuthorDetail=z.infer<typeof adminCatalogAuthorDetailSchema>;



/** Input is parsed verbatim from a validated, text-bearing local source; no OCR/AI recovery. */
export const contentBlockKindSchema = z.enum([
  'paragraph','heading','footnote','page_number','running_header','publisher_note',
  'preface','endnote','poetry','quote','list','image_ref',
]);
export const contentRevisionCreateSchema = z.object({
  editionId: z.uuid(),
  language: z.enum(['tr','en']),
  parentRevisionId: z.uuid().optional(),
  rawArtifactKey: z.string().min(1).max(512),
  rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: z.string().min(1).max(100),
  provenance: z.object({
    sourceName: z.string().min(1).max(240),
    sourceUrl: z.url().optional(),
    sourceExternalId: z.string().max(400).optional(),
    licenseClaim: z.string().max(1000).optional(),
  }).strict(),
  chapters: z.array(z.object({
    chapterId: z.uuid(),ordinal: z.number().int().min(0),heading: z.string(),
    blocks: z.array(z.object({
      blockId: z.uuid(),ordinal: z.number().int().min(0),
      parentBlockId: z.uuid().optional(),
      kind: contentBlockKindSchema,
      locator: z.object({format:z.enum(['epub','pdf','text']),path:z.string().min(1)}).strict(),
      sourceText: z.string().min(1),
      textSha256: z.string().regex(/^[a-f0-9]{64}$/),
      includeNormal: z.boolean().default(true),
      includeRsvp: z.boolean().default(false),
      includeAudio: z.boolean().default(false),
    }).strict()).min(1),
  }).strict()).min(1),
}).strict().superRefine((input,ctx) => {
  const allBlockIds = input.chapters.flatMap(ch=>ch.blocks.map(b=>b.blockId));
  if (new Set(allBlockIds).size!==allBlockIds.length) ctx.addIssue({code:'custom',message:'Block IDs must remain unique per revision'});
  const chapterIds = input.chapters.map(ch=>ch.chapterId);
  if (new Set(chapterIds).size!==chapterIds.length) ctx.addIssue({code:'custom',message:'Duplicate chapter identity'});
  input.chapters.forEach(ch=>{
    const order=ch.blocks.map(b=>b.ordinal).sort((a,b)=>a-b);
    if (order.some((n,i)=>n!==i)) ctx.addIssue({code:'custom',message:'Block order must be complete and reliable'});
    const aux=new Set(['footnote','endnote','page_number','running_header','publisher_note','image_ref']);
    for (const block of ch.blocks) {
      if (aux.has(block.kind)&&(block.includeRsvp||block.includeAudio)) ctx.addIssue({code:'custom',message:`Auxiliary block ${block.kind} cannot enter RSVP/audio`});
      if (block.parentBlockId && !allBlockIds.includes(block.parentBlockId)) ctx.addIssue({code:'custom',message:'Parent block must exist in this revision'});
    }
  });
  const chapterOrder=input.chapters.map(ch=>ch.ordinal).sort((a,b)=>a-b);
  if (chapterOrder.some((n,i)=>n!==i)) ctx.addIssue({code:'custom',message:'Chapter order must be complete and reliable'});
});
export type ContentRevisionCreate = z.infer<typeof contentRevisionCreateSchema>;

/** Admin-only unpublished chapter preview: no private artifact keys or rights claims. */
export const adminContentChapterResponseSchema=z.object({
  workId:z.uuid(),editionId:z.uuid(),
  revision:z.object({
    id:z.uuid(),parentRevisionId:z.uuid().nullable(),
    language:z.enum(['tr','en']),status:z.string().min(1),
    sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
    provenanceId:z.uuid(),
  }).strict(),
  chapter:z.object({
    id:z.uuid(),ordinal:z.number().int().min(0),heading:z.string(),
  }).strict(),
  blocks:z.array(z.object({
    id:z.uuid(),ordinal:z.number().int().min(0),
    kind:contentBlockKindSchema,sourceText:z.string().min(1),
    textSha256:z.string().regex(/^[a-f0-9]{64}$/),
    includeNormal:z.boolean(),includeRsvp:z.boolean(),includeAudio:z.boolean(),
  }).strict()),
}).strict();
export type AdminContentChapterResponse=z.infer<typeof adminContentChapterResponseSchema>;


/** Privileged RIGHTS:READ evidence claims ledger. This is NOT a rights
 * decision or grant. Never include raw legal evidence, source URL, reviewer,
 * owner identity, private object locations or any user library data. */
export const adminCatalogRightsLedgerQuerySchema=z.object({
  cursor:z.uuid().optional(),
  limit:z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export const adminCatalogRightsLedgerSchema=z.object({
  workId:z.uuid(),
  items:z.array(z.object({
    id:z.uuid(),
    editionId:z.uuid().nullable(),
    revisionId:z.uuid().nullable(),
    reviewStatus:z.enum(['pending','approved','rejected','withdrawn']),
    territories:z.array(z.string().regex(/^[A-Z]{2}$/)).max(250),
    claims:z.object({
      display:z.boolean(),translation:z.boolean(),
      audio:z.boolean(),sharing:z.boolean(),
    }).strict(),
    expiresAt:z.iso.datetime({offset:true}).nullable(),
  }).strict()).max(50),
  nextCursor:z.uuid().nullable(),
  isMetadataOnly:z.literal(true),
}).strict();
export type AdminCatalogRightsLedger=z.infer<typeof adminCatalogRightsLedgerSchema>;

/** A verified, bounded list of immutable edition revision IDENTITIES only.
 * This cannot expose source text, byte hashes, file paths, editor identity,
 * provenance or any rights decision. No anonymous/public route. */
export const adminCatalogRevisionListQuerySchema=z.object({
  cursor:z.uuid().optional(),
  limit:z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export const adminCatalogRevisionListSchema=z.object({
  editionId:z.uuid(),
  items:z.array(z.object({
    id:z.uuid(),
    parentRevisionId:z.uuid().nullable(),
    language:z.enum(['tr','en']),
    status:z.string().min(1).max(24),
  }).strict()).max(50),
  nextCursor:z.uuid().nullable(),
  isMetadataOnly:z.literal(true),
}).strict();
export type AdminCatalogRevisionList=z.infer<typeof adminCatalogRevisionListSchema>;

/** ADMIN-ONLY read-only editorial diff: stable ID metadata, never source
 * text, artifact path, raw provenance, user library or publication approval. */
export const adminCatalogRevisionDiffQuerySchema=z.object({
  fromRevisionId:z.uuid(),
  cursor:z.uuid().optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const revisionDiffPosition=z.object({
  chapterId:z.uuid(),
  ordinal:z.number().int().min(0),
  kind:contentBlockKindSchema,
  textSha256:z.string().regex(/^[0-9a-f]{64}$/),
  includeNormal:z.boolean(),
  includeRsvp:z.boolean(),
  includeAudio:z.boolean(),
}).strict();
export const adminCatalogRevisionDiffSchema=z.object({
  editionId:z.uuid(),
  fromRevisionId:z.uuid(),
  toRevisionId:z.uuid(),
  summary:z.object({
    added:z.number().int().min(0),
    removed:z.number().int().min(0),
    text_changed:z.number().int().min(0),
    metadata_changed:z.number().int().min(0),
    moved:z.number().int().min(0),
    unchanged:z.number().int().min(0),
  }).strict(),
  chapterChanges:z.array(z.object({
    chapterId:z.uuid(),
    kind:z.enum(['added','removed','renamed','moved']),
  }).strict()).max(10000),
  items:z.array(z.object({
    blockId:z.uuid(),
    kind:z.enum(['added','removed','text_changed','metadata_changed','moved']),
    before:revisionDiffPosition.nullable(),
    after:revisionDiffPosition.nullable(),
  }).strict()).max(100),
  nextCursor:z.uuid().nullable(),
  isMetadataOnly:z.literal(true),
}).strict();
export type AdminCatalogRevisionDiff=z.infer<typeof adminCatalogRevisionDiffSchema>;

export const rightsActionSchema = z.enum(['display','translation','audio','sharing']);
export type RightsAction = z.infer<typeof rightsActionSchema>;
export const rightsRecordCreateSchema = z.object({
  workId: z.uuid(),
  editionId: z.uuid().optional(),
  revisionId: z.uuid().optional(),
  sourceUrl: z.url().optional(),
  evidence: z.string().trim().min(12).max(4000),
  licenseKind: z.string().trim().min(2).max(60),
  territories: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250),
  displayAllowed: z.boolean().default(false),
  translationAllowed: z.boolean().default(false),
  audioAllowed: z.boolean().default(false),
  sharingAllowed: z.boolean().default(false),
  expiresAt: z.iso.datetime({offset:true}).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.revisionId && !data.editionId) ctx.addIssue({code:'custom',message:'Revision rights require the edition scope'});
  if (new Set(data.territories).size!==data.territories.length) ctx.addIssue({code:'custom',message:'Territories must not repeat'});
});
export type RightsRecordCreate = z.infer<typeof rightsRecordCreateSchema>;

export const adminRightsReviewInputSchema=z.object({
  decision:z.enum(['approved','rejected','withdrawn']),
  reason:z.string().trim().min(12).max(4000),
}).strict();
export const adminRightsClaimCreatedSchema=z.object({
  id:z.uuid(),reviewStatus:z.literal('pending'),
}).strict();
export const adminRightsReviewedSchema=z.object({
  id:z.uuid(),reviewStatus:z.enum(['approved','rejected','withdrawn']),
}).strict();
export const adminRightsEvidenceSchema=z.object({
  id:z.uuid(),workId:z.uuid(),editionId:z.uuid().nullable(),revisionId:z.uuid().nullable(),
  evidence:z.string().min(12),sourceUrl:z.url().nullable(),
  licenseKind:z.string().min(2),territories:z.array(z.string().regex(/^[A-Z]{2}$/)),
  claims:z.object({display:z.boolean(),translation:z.boolean(),audio:z.boolean(),sharing:z.boolean()}).strict(),
  reviewStatus:z.enum(['pending','approved','rejected','withdrawn']),
  expiresAt:z.iso.datetime({offset:true}).nullable(),
}).strict();
export const adminRightsDecisionResultSchema=z.object({
  allowed:z.boolean(),
  reason:z.enum(['approved','missing','unreviewed','territory',
    'expired','prohibited','wrong_scope']),
}).strict();

export const rightsDecisionQuerySchema = z.object({
  workId: z.uuid(), editionId: z.uuid(), revisionId: z.uuid(),
  territory: z.string().regex(/^[A-Z]{2}$/),action: rightsActionSchema,
}).strict();
export type RightsDecisionQuery = z.infer<typeof rightsDecisionQuerySchema>;
export type RightsDecision = {allowed: boolean; reason: 'approved'|'missing'|'unreviewed'|'territory'|'expired'|'prohibited'|'wrong_scope'};

export const translationLinkCreateSchema=z.object({
  sourceRevisionId:z.uuid(),targetRevisionId:z.uuid(),
  translatorId:z.uuid().optional(),
  provenance:z.object({kind:z.literal('manual_import'),packageId:z.string().min(1).max(240),note:z.string().max(2000).optional()}).strict(),
  alignments:z.array(z.object({
    sourceBlockId:z.uuid(),targetBlockId:z.uuid(),alignmentKind:z.enum(['manual','approximate']).default('manual'),
  }).strict()).max(50000).default([]),
}).strict().superRefine((data,ctx)=>{
  if(data.sourceRevisionId===data.targetRevisionId)ctx.addIssue({code:'custom',message:'Source and translated revisions must differ'});
  const keys=data.alignments.map(a=>`${a.sourceBlockId}:${a.targetBlockId}`);
  if(new Set(keys).size!==keys.length)ctx.addIssue({code:'custom',message:'Repeated source-target alignment pair'});
});
export type TranslationLinkCreate=z.infer<typeof translationLinkCreateSchema>;
export const translationSwitchRequestSchema=z.object({
  linkId:z.uuid(),sourceBlockId:z.uuid(),
}).strict();

/** Metadata for a *prepared* audio file, not proof that storage checksum has been verified. */
export const preparedAudioAssetSchema=z.object({
  storageKey:z.string().min(1).max(512),
  sha256:z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes:z.number().int().positive().max(1_000_000_000),
  mime:z.enum(['audio/mp4','audio/ogg']),
  durationMs:z.number().int().positive().max(86_400_000),
}).strict();
export type PreparedAudioAsset=z.infer<typeof preparedAudioAssetSchema>;
export const audioSegmentInputSchema=z.object({
  chapterId:z.uuid(),ordinal:z.number().int().min(0),assetId:z.uuid(),textBlockId:z.uuid(),
  textSha256:z.string().regex(/^[a-f0-9]{64}$/),startMs:z.number().int().min(0),endMs:z.number().int().positive(),
}).strict().refine(data=>data.endMs>data.startMs,{message:'Segment end must exceed start'});
export const audioVariantInputSchema=z.object({
  contentRevisionId:z.uuid(),language:z.enum(['tr','en']),voiceId:z.string().min(1).max(120),
  sourceLabel:z.string().min(1).max(240),codec:z.enum(['m4a','opus']),
  segments:z.array(audioSegmentInputSchema).min(1).max(5000),
}).strict().superRefine((data,ctx)=>{
  const orders=new Set<string>();
  for(const segment of data.segments){
    const key=`${segment.chapterId}:${segment.ordinal}`;
    if(orders.has(key))ctx.addIssue({code:'custom',message:'Duplicate chapter segment ordinal'});
    orders.add(key);
  }
});
export type AudioVariantInput=z.infer<typeof audioVariantInputSchema>;

// Canonical admin authorization map; no client-supplied role or user search.
export {adminRoles,adminPermissions,hasAdminPermission} from './admin-rbac.js';
export type {AdminRole,AdminPermission} from './admin-rbac.js';

/** Strict, platform-neutral request validation for internal auth admission; never trust client IP. */
export const authAttemptRequestSchema=z.object({
  action:z.enum(['login','register','password_reset']),
  email:z.string().trim().max(254).pipe(z.email()),
}).strict();

/** Verified self-only onboarding. The bearer principal is NEVER a request field. */
const onboardingStageSchema=z.enum(['welcome','language','interests','complete']);
const onboardingInterestIds=z.array(z.string().regex(/^[a-z][a-z0-9-]{1,39}$/))
  .max(20).refine(values=>new Set(values).size===values.length,{message:'Duplicate interest IDs'});
export const onboardingUpdateRequestSchema=z.object({
  expectedVersion:z.number().int().nonnegative().max(2147483646),
  stage:onboardingStageSchema,locale:z.enum(['tr','en']),
  interests:onboardingInterestIds,
}).strict();
export const onboardingSnapshotSchema=z.object({
  userId:z.uuid(),stage:onboardingStageSchema,locale:z.enum(['tr','en']),
  interests:onboardingInterestIds,version:z.number().int().nonnegative(),
}).strict();
export type OnboardingSnapshot=z.infer<typeof onboardingSnapshotSchema>;

export {fetchOwnOnboarding,updateOwnOnboarding,OnboardingHttpError,OnboardingVersionConflictError} from './onboarding-client.js';
export type {OwnOnboardingRequest} from './onboarding-client.js';


/** Public DTO contains no bearer, digest, account email or admin claims. */
export const deviceSessionIdSchema=z.uuid();
export const deviceSessionInventorySchema=z.object({
  items:z.array(z.object({
    id:deviceSessionIdSchema,deviceLabel:z.string().min(1).max(80),
    createdAt:z.iso.datetime({offset:true}),
    expiresAt:z.iso.datetime({offset:true}),
    isCurrent:z.boolean(),
  }).strict()).max(100),
}).strict();
export type DeviceSessionInventory=z.infer<typeof deviceSessionInventorySchema>;

// Stateless Web/Expo device session API; no token persistence.
export {fetchOwnDeviceSessions,revokeOwnDeviceSession,DeviceSessionHttpError} from './device-sessions-client.js';
export type {OwnDeviceSessionsRequest} from './device-sessions-client.js';

/** The client requests a single editorial transition, never a rights grant. */
export const adminPublicationCommandSchema=z.object({
  action:z.enum(['publish','withdraw']),
  territory:z.string().regex(/^[A-Z]{2}$/),
  reason:z.string().trim().min(8).max(500),
}).strict();
export const adminPublicationResultSchema=z.object({
  workId:z.uuid(),editionId:z.uuid(),revisionId:z.uuid(),
  status:z.enum(['published','withdrawn']),
}).strict();
export type AdminPublicationCommand=z.infer<typeof adminPublicationCommandSchema>;
export type AdminPublicationResult=z.infer<typeof adminPublicationResultSchema>;

/** Strict request for gated HTTPS web sign-in; session token never in response. */
export const webLoginRequestSchema=z.object({
  email:z.string().trim().max(254).pipe(z.email()),
  password:z.string().min(12).max(128).refine(value=>!value.includes('\0')),
}).strict();

// Browser-only same-origin HttpOnly cookie client, distinct from native bearer.
export {loginWebSession,fetchWebSessionCsrf,logoutWebSession,fetchWebDeviceSessions,revokeWebDeviceSession,fetchWebOnboarding,updateWebOnboarding,WebSessionHttpError} from './web-session-client.js';
export type {WebSessionClientRequest} from './web-session-client.js';

/** Public catalog metadata: no source text, raw storage references or rights evidence. */
export const publishedBookDetailSchema=z.object({
  id:z.uuid(),title:z.string().min(1),originalLanguage:z.enum(['tr','en']),
  authors:z.array(z.object({id:z.uuid(),name:z.string().min(1)}).strict()).max(50),
  editions:z.array(z.object({
    id:z.uuid(),language:z.enum(['tr','en']),label:z.string().min(1),
    revisionId:z.uuid(),audioAvailable:z.boolean(),
  }).strict()).min(1).max(50),
}).strict();
export type PublishedBookDetail=z.infer<typeof publishedBookDetailSchema>;
export {fetchPublishedBookDetail,PublishedBookHttpError} from './published-book-client.js';

/** MVP: public search only covers books and authors, never people. */
export const publishedCatalogSearchQuerySchema=z.object({
  q:z.string().trim().min(1).max(120),
  limit:z.preprocess(v=>typeof v==='string'&&/^\\d+$/.test(v)?Number(v):v,
    z.number().int().min(1).max(20).default(20)),
}).strict();
export const publishedCatalogItemSchema=z.object({
  id:z.uuid(),title:z.string().min(1),authors:z.array(z.string().min(1)).max(50),
  editionId:z.uuid(),revisionId:z.uuid(),audioAvailable:z.boolean(),
}).strict();
export const publishedCatalogSearchPageSchema=z.object({
  items:z.array(publishedCatalogItemSchema).max(20),
}).strict();
export type PublishedCatalogSearchPage=z.infer<typeof publishedCatalogSearchPageSchema>;

/** This data never contains a reading position; that arrives separately in #36. */
export const shelfUpdateSchema=z.object({
  status:z.enum(['to-read','reading']),
}).strict();
export const shelfItemSchema=publishedCatalogItemSchema.extend({
  status:z.enum(['to-read','reading']),
}).strict();
export const shelfListSchema=z.object({
  items:z.array(shelfItemSchema).max(50),
}).strict();
export type ShelfList=z.infer<typeof shelfListSchema>;
export {searchPublicCatalog,fetchOwnWebShelf,saveOwnWebShelf,removeOwnWebShelf} from './public-shelf-client.js';
