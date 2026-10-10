import {eq} from 'drizzle-orm';
import {z} from 'zod';
import {authorCreateSchema, workCreateSchema} from '@folio/contracts';
import type {AuthorCreate, WorkCreate} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type CatalogDb = ReturnType<typeof createFolioDb>['db'];

/** Internal, transactional draft commands. Not accessible as unguarded HTTP endpoints. */
export async function createCanonicalAuthor(
  db: CatalogDb, actorId: string, raw: unknown, requestId?: string,
) {
  const actor = z.uuid().parse(actorId);
  // HTTP callers must supply only RequestIdMiddleware's request.requestId.
  // This syntax check is NOT actor authentication or admin role evidence.
  const traceId = requestId === undefined ? undefined : z.uuid().parse(requestId);
  const input: AuthorCreate = authorCreateSchema.parse(raw);
  return db.transaction(async tx => {
    const [author] = await tx.insert(schema.authors).values({
      canonicalName: input.canonicalName,
      sortName: input.sortName ?? input.canonicalName,
    }).returning();
    if (!author) throw new Error('Author creation failed');
    if (input.aliases.length) await tx.insert(schema.authorAliases).values(input.aliases.map(alias => ({
      authorId: author.id, name: alias.name, locale: alias.locale ?? null,
    })));
    if (input.externalIds.length) await tx.insert(schema.authorExternalIds).values(input.externalIds.map(external => ({
      authorId: author.id, source: external.source, externalId: external.externalId,
    })));
    await tx.insert(schema.auditEvents).values({
      actorId: actor, action: 'author.create', entityType: 'author', entityId: author.id,
      ...(traceId ? {requestId: traceId} : {}),
      afterJson: {name: author.canonicalName, aliasCount: input.aliases.length, externalIdCount: input.externalIds.length},
    });
    return author;
  });
}

export async function createCanonicalWork(
  db: CatalogDb, actorId: string, raw: unknown, requestId?: string,
) {
  const actor = z.uuid().parse(actorId);
  const traceId = requestId === undefined ? undefined : z.uuid().parse(requestId);
  const input: WorkCreate = workCreateSchema.parse(raw);
  return db.transaction(async tx => {
    const [work] = await tx.insert(schema.works).values({
      originalTitle: input.originalTitle,
      originalLanguage: input.originalLanguage,
      firstPublicationYear: input.firstPublicationYear ?? null,
      publicationStatus: 'draft',
    }).returning();
    if (!work) throw new Error('Work creation failed');
    await tx.insert(schema.workAuthors).values(input.authors.map(author => ({
      workId: work.id, authorId: author.authorId,
      contribution: author.contribution, sortOrder: author.sortOrder,
    })));
    await tx.insert(schema.workTitles).values([
      {workId: work.id, language: input.originalLanguage, title: input.originalTitle, kind: 'original'},
      ...input.titles.map(title => ({workId: work.id, ...title})),
    ]);
    for (const edition of input.editions) {
      const [created] = await tx.insert(schema.editions).values({
        workId: work.id, language: edition.language, label: edition.label,
        publisher: edition.publisher ?? null, status: 'draft',
      }).returning();
      if (!created) throw new Error('Edition creation failed');
      if (edition.identifiers.length) await tx.insert(schema.editionIdentifiers).values(edition.identifiers.map(id => ({
        editionId: created.id, kind: id.kind, value: id.value,
      })));
      if (edition.contributors.length) await tx.insert(schema.editionContributors).values(edition.contributors.map(person => ({
        editionId: created.id, authorId: person.authorId, role: person.role, sortOrder: person.sortOrder,
      })));
    }
    await tx.insert(schema.auditEvents).values({
      actorId: actor, action: 'work.create', entityType: 'work', entityId: work.id,
      ...(traceId ? {requestId: traceId} : {}),
      afterJson: {status: 'draft', authorCount: input.authors.length, editionCount: input.editions.length},
    });
    return work;
  });
}

/** Internal detail fetch only. Public catalog listing awaits verified publishing rights. */
export async function getCanonicalWorkDetails(db: CatalogDb, workId: string) {
  const id = z.uuid().parse(workId);
  const [work] = await db.select().from(schema.works).where(eq(schema.works.id, id)).limit(1);
  if (!work) return null;
  const authors = await db.select({
    id: schema.authors.id,
    name: schema.authors.canonicalName,
    role: schema.workAuthors.contribution,
    sortOrder: schema.workAuthors.sortOrder,
  }).from(schema.workAuthors)
    .innerJoin(schema.authors, eq(schema.workAuthors.authorId, schema.authors.id))
    .where(eq(schema.workAuthors.workId, id));
  const titles = await db.select().from(schema.workTitles).where(eq(schema.workTitles.workId, id));
  const editionRows = await db.select().from(schema.editions).where(eq(schema.editions.workId, id));
  const editionDetails = await Promise.all(editionRows.map(async edition => ({
    ...edition,
    identifiers: await db.select().from(schema.editionIdentifiers).where(eq(schema.editionIdentifiers.editionId, edition.id)),
    contributors: await db.select().from(schema.editionContributors).where(eq(schema.editionContributors.editionId, edition.id)),
  })));
  return {work, authors, titles, editions: editionDetails};
}
