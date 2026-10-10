import {and,eq,gt,ilike,inArray,or} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type CatalogDb=ReturnType<typeof createFolioDb>['db'];
const criteria=z.object({
  query:z.string().trim().min(1).max(120),
  cursor:z.uuid().optional(),
  limit:z.number().int().min(1).max(50).default(20),
}).strict();
type SearchCriteria=z.infer<typeof criteria>;

/** Untrusted % and _ must match LITERAL title/author characters. */
function literalContains(value:string):string{
  return '%'+value.replace(/[\\%_]/g,'\\$&')+'%';
}

/**
 * INTERNAL ADMIN-ONLY canonical metadata search.
 * Caller MUST be independently authenticated and RBAC-authorized.
 * This intentionally has no HTTP controller or ability to search users.
 * Drafts and unpublished work metadata must not leak to public catalog.
 */
export async function searchCanonicalWorksForAdmin(db:CatalogDb,raw:unknown){
  const input:SearchCriteria=criteria.parse(raw);
  const pattern=literalContains(input.query);
  const aliasTitleIds=db.select({workId:schema.workTitles.workId})
    .from(schema.workTitles).where(ilike(schema.workTitles.title,pattern));
  const aliasAuthorIds=db.select({authorId:schema.authorAliases.authorId})
    .from(schema.authorAliases).where(ilike(schema.authorAliases.name,pattern));
  const authorNames=or(
    ilike(schema.authors.canonicalName,pattern),
    inArray(schema.authors.id,aliasAuthorIds),
  );
  const authorWorkIds=db.select({workId:schema.workAuthors.workId})
    .from(schema.workAuthors)
    .innerJoin(schema.authors,eq(schema.workAuthors.authorId,schema.authors.id))
    .where(authorNames);
  const editionContributorWorkIds=db.select({workId:schema.editions.workId})
    .from(schema.editionContributors)
    .innerJoin(schema.editions,eq(schema.editionContributors.editionId,schema.editions.id))
    .innerJoin(schema.authors,eq(schema.editionContributors.authorId,schema.authors.id))
    .where(authorNames);
  const matching=or(
    ilike(schema.works.originalTitle,pattern),
    inArray(schema.works.id,aliasTitleIds),
    inArray(schema.works.id,authorWorkIds),
    inArray(schema.works.id,editionContributorWorkIds),
  );
  const where=input.cursor?and(matching,gt(schema.works.id,input.cursor)):matching;
  const rows=await db.select({
    id:schema.works.id,originalTitle:schema.works.originalTitle,
    originalLanguage:schema.works.originalLanguage,
    publicationStatus:schema.works.publicationStatus,
  }).from(schema.works).where(where).orderBy(schema.works.id).limit(input.limit+1);
  const items=rows.slice(0,input.limit);
  return {items,nextCursor:rows.length>input.limit?(items.at(-1)?.id??null):null};
}

/** Alias names remain associated with canonical authors, never friend search. */
export async function searchCanonicalAuthorsForAdmin(db:CatalogDb,raw:unknown){
  const input:SearchCriteria=criteria.parse(raw);
  const pattern=literalContains(input.query);
  const aliased=db.select({authorId:schema.authorAliases.authorId})
    .from(schema.authorAliases).where(ilike(schema.authorAliases.name,pattern));
  const matching=or(
    ilike(schema.authors.canonicalName,pattern),
    inArray(schema.authors.id,aliased),
  );
  const where=input.cursor?and(matching,gt(schema.authors.id,input.cursor)):matching;
  const rows=await db.select({
    id:schema.authors.id,canonicalName:schema.authors.canonicalName,
    sortName:schema.authors.sortName,
  }).from(schema.authors).where(where).orderBy(schema.authors.id).limit(input.limit+1);
  const items=rows.slice(0,input.limit);
  return {items,nextCursor:rows.length>input.limit?(items.at(-1)?.id??null):null};
}
