import { z } from 'zod';
import { Base64 } from 'js-base64';

/** Contracts may be used by web, native and admin without framework imports. */
export const healthResponseSchema = z.object({status: z.literal('ok')}).strict();
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

/** Browser and React Native compatible typed capabilities client. */
export async function fetchCapabilities(
  baseUrl: string, query: {limit?: number; cursor?: string} = {},
  fetcher: typeof fetch = fetch,
): Promise<CapabilityPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  const suffix = params.size ? `?${params.toString()}` : '';
  const response = await fetcher(`${baseUrl.replace(/\/$/, '')}/v1/system/capabilities${suffix}`);
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(data);
    throw new Error(parsed.success ? `${parsed.data.error.code}: ${parsed.data.error.message}` : `HTTP ${response.status}`);
  }
  return capabilityPageSchema.parse(data);
}

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
