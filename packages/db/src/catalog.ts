import {asc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {authorCreateSchema,workCreateSchema} from '@folio/contracts';
import type {AuthorCreate,WorkCreate} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';
import * as schema from './schema.js';

type CatalogDb=ReturnType<typeof createFolioDb>['db'];
type CatalogTx=Parameters<Parameters<CatalogDb['transaction']>[0]>[0];

/**
 * INTERNAL draft mutation core. Never nest a new transaction under a
 * previously verified admin transaction: both the catalog rows and their
 * audit must commit/roll back with live MFA, session and role locks.
 * These functions cannot authorize a raw bearer by themselves.
 */
async function insertAuthorDraft(
  tx:CatalogTx,actor:string,input:AuthorCreate,traceId?:string,
){
  const [author]=await tx.insert(schema.authors).values({
    canonicalName:input.canonicalName,
    sortName:input.sortName??input.canonicalName,
  }).returning();
  if(!author)throw new Error('Author creation failed');
  if(input.aliases.length)await tx.insert(schema.authorAliases).values(input.aliases.map(alias=>({
    authorId:author.id,name:alias.name,locale:alias.locale??null,
  })));
  if(input.externalIds.length)await tx.insert(schema.authorExternalIds).values(input.externalIds.map(ext=>({
    authorId:author.id,source:ext.source,externalId:ext.externalId,
  })));
  await tx.insert(schema.auditEvents).values({
    actorId:actor,action:'author.create',entityType:'author',entityId:author.id,
    ...(traceId?{requestId:traceId}:{}),
    afterJson:{
      name:author.canonicalName,
      aliasCount:input.aliases.length,externalIdCount:input.externalIds.length,
    },
  });
  return author;
}

async function insertWorkDraft(
  tx:CatalogTx,actor:string,input:WorkCreate,traceId?:string,
){
  const [work]=await tx.insert(schema.works).values({
    originalTitle:input.originalTitle,
    originalLanguage:input.originalLanguage,
    firstPublicationYear:input.firstPublicationYear??null,
    publicationStatus:'draft',
  }).returning();
  if(!work)throw new Error('Work creation failed');
  await tx.insert(schema.workAuthors).values(input.authors.map(author=>({
    workId:work.id,authorId:author.authorId,
    contribution:author.contribution,sortOrder:author.sortOrder,
  })));
  await tx.insert(schema.workTitles).values([
    {workId:work.id,language:input.originalLanguage,
      title:input.originalTitle,kind:'original'},
    ...input.titles.map(title=>({workId:work.id,...title})),
  ]);
  for(const edition of input.editions){
    const [created]=await tx.insert(schema.editions).values({
      workId:work.id,language:edition.language,label:edition.label,
      publisher:edition.publisher??null,status:'draft',
    }).returning();
    if(!created)throw new Error('Edition creation failed');
    if(edition.identifiers.length)await tx.insert(schema.editionIdentifiers)
      .values(edition.identifiers.map(id=>({
        editionId:created.id,kind:id.kind,value:id.value,
      })));
    if(edition.contributors.length)await tx.insert(schema.editionContributors)
      .values(edition.contributors.map(person=>({
        editionId:created.id,authorId:person.authorId,role:person.role,
        sortOrder:person.sortOrder,
      })));
  }
  await tx.insert(schema.auditEvents).values({
    actorId:actor,action:'work.create',entityType:'work',entityId:work.id,
    ...(traceId?{requestId:traceId}:{}),
    afterJson:{
      status:'draft',authorCount:input.authors.length,
      editionCount:input.editions.length,
    },
  });
  return work;
}

/** Existing internal draft importer/CLI foundation; actor is trusted by its caller.
 * No HTTP controller calls these functions with a user-supplied actor ID. */
export async function createCanonicalAuthor(
  db:CatalogDb,actorId:string,raw:unknown,requestId?:string,
){
  const actor=z.uuid().parse(actorId);
  const traceId=requestId===undefined?undefined:z.uuid().parse(requestId);
  const input=authorCreateSchema.parse(raw);
  return db.transaction(tx=>insertAuthorDraft(tx,actor,input,traceId));
}
export async function createCanonicalWork(
  db:CatalogDb,actorId:string,raw:unknown,requestId?:string,
){
  const actor=z.uuid().parse(actorId);
  const traceId=requestId===undefined?undefined:z.uuid().parse(requestId);
  const input=workCreateSchema.parse(raw);
  return db.transaction(tx=>insertWorkDraft(tx,actor,input,traceId));
}

/**
 * SECURITY BOUNDARY for live administrative draft creation.
 * The only actor ID is returned by the fresh persisted MFA/session/role gate.
 * This performs SELECT verification, INSERT(s) and audit in ONE PostgreSQL
 * transaction. A broken edition contributor / author FK rolls back ALL rows.
 * Cannot publish or overwrite any canonical original text.
 */
export async function createVerifiedAdminDraftAuthor(
  db:CatalogDb,rawBearer:string,raw:unknown,requestId:string,
){
  const input=authorCreateSchema.parse(raw);
  const traceId=z.uuid().parse(requestId);
  return withVerifiedAdminPermission(db,rawBearer,'catalog:edit',
    (tx,who)=>insertAuthorDraft(tx,who.userId,input,traceId));
}
export async function createVerifiedAdminDraftWork(
  db:CatalogDb,rawBearer:string,raw:unknown,requestId:string,
){
  const input=workCreateSchema.parse(raw);
  const traceId=z.uuid().parse(requestId);
  return withVerifiedAdminPermission(db,rawBearer,'catalog:edit',
    (tx,who)=>insertWorkDraft(tx,who.userId,input,traceId));
}

/** Internal detail fetch only. Public catalog listing awaits verified publishing rights.
 *
 * All child rows must come from one repeatable-read PostgreSQL snapshot: a
 * concurrent editor must not yield a work from revision A with editions from B.
 * Explicit sort keys + UUID tie-breakers make multi-author/edition selections
 * stable between devices and independent of query planner/insert order.
 */
async function readCanonicalWorkSnapshot(tx:CatalogTx,id:string){
    const [work] = await tx.select().from(schema.works)
      .where(eq(schema.works.id, id)).limit(1);
    if (!work) return null;
    const authors = await tx.select({
      id: schema.authors.id,
      name: schema.authors.canonicalName,
      role: schema.workAuthors.contribution,
      sortOrder: schema.workAuthors.sortOrder,
    }).from(schema.workAuthors)
      .innerJoin(schema.authors, eq(schema.workAuthors.authorId, schema.authors.id))
      .where(eq(schema.workAuthors.workId, id))
      .orderBy(asc(schema.workAuthors.sortOrder), asc(schema.authors.id));
    const titles = await tx.select().from(schema.workTitles)
      .where(eq(schema.workTitles.workId, id))
      .orderBy(asc(schema.workTitles.language),asc(schema.workTitles.kind),
        asc(schema.workTitles.title),asc(schema.workTitles.id));
    const editionRows = await tx.select().from(schema.editions)
      .where(eq(schema.editions.workId, id))
      .orderBy(asc(schema.editions.language),asc(schema.editions.label),
        asc(schema.editions.id));
    const editionDetails = [];
    for (const edition of editionRows) {
      const identifiers = await tx.select().from(schema.editionIdentifiers)
        .where(eq(schema.editionIdentifiers.editionId, edition.id))
        .orderBy(asc(schema.editionIdentifiers.kind),
          asc(schema.editionIdentifiers.value));
      const contributors = await tx.select().from(schema.editionContributors)
        .where(eq(schema.editionContributors.editionId, edition.id))
        .orderBy(asc(schema.editionContributors.sortOrder),
          asc(schema.editionContributors.role),
          asc(schema.editionContributors.authorId));
      editionDetails.push({...edition, identifiers, contributors});
    }
    return {work, authors, titles, editions: editionDetails};
}

/** INTERNAL caller retains a database-enforced READ ONLY transaction.
 * This is NOT an authenticated HTTP/public catalog entrypoint. */
export async function getCanonicalWorkDetails(db:CatalogDb,workId:string){
  const id=z.uuid().parse(workId);
  return db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return readCanonicalWorkSnapshot(tx,id);
  },{isolationLevel:'repeatable read'});
}

/**
 * Only a session with live DB-backed catalog:read, same-device MFA and an
 * active role can fetch unpublished canonical relational metadata.
 * Authorizations and EVERY nested relation SELECT use one PostgreSQL
 * REPEATABLE READ transaction: no unguarded second read or mixed revision.
 * The security transaction requires FOR SHARE locks and consequently cannot
 * use SQL SET TRANSACTION READ ONLY; this function itself only SELECTs.
 * Never serve this outside the default-off admin direct-TLS controller.
 */
export async function getVerifiedAdminWorkDetails(
  db:CatalogDb,bearer:string,workId:string,
){
  const id=z.uuid().parse(workId);
  return withVerifiedAdminPermission(db,bearer,'catalog:read',async tx=>{
    const details=await readCanonicalWorkSnapshot(tx,id);
    if(!details)return null;
    const {work,authors,titles,editions}=details;
    return {
      work:{
        id:work.id,originalTitle:work.originalTitle,
        originalLanguage:work.originalLanguage,
        firstPublicationYear:work.firstPublicationYear,
        publicationStatus:work.publicationStatus,
      },
      authors:authors.map(author=>({
        id:author.id,name:author.name,role:author.role,
        sortOrder:author.sortOrder,
      })),
      titles:titles.map(title=>({
        id:title.id,language:title.language,title:title.title,kind:title.kind,
      })),
      editions:editions.map(edition=>({
        id:edition.id,language:edition.language,label:edition.label,
        publisher:edition.publisher,status:edition.status,
        identifiers:edition.identifiers.map(identifier=>({
          kind:identifier.kind,value:identifier.value,
        })),
        contributors:edition.contributors.map(contributor=>({
          authorId:contributor.authorId,role:contributor.role,
          sortOrder:contributor.sortOrder,
        })),
      })),
    };
  },{isolationLevel:'repeatable read'});
}

/** Author editor metadata; alias and scoped external IDs share that same
 * authenticated REPEATABLE READ snapshot, with deterministic explicit order. */
export async function getVerifiedAdminAuthorDetails(
  db:CatalogDb,bearer:string,authorId:string,
){
  const id=z.uuid().parse(authorId);
  return withVerifiedAdminPermission(db,bearer,'catalog:read',async tx=>{
    const [author]=await tx.select({
      id:schema.authors.id,canonicalName:schema.authors.canonicalName,
      sortName:schema.authors.sortName,
    }).from(schema.authors).where(eq(schema.authors.id,id)).limit(1);
    if(!author)return null;
    const aliases=await tx.select({
      id:schema.authorAliases.id,name:schema.authorAliases.name,
      locale:schema.authorAliases.locale,
    }).from(schema.authorAliases)
      .where(eq(schema.authorAliases.authorId,id))
      .orderBy(asc(schema.authorAliases.name),asc(schema.authorAliases.id));
    const externalIds=await tx.select({
      source:schema.authorExternalIds.source,
      externalId:schema.authorExternalIds.externalId,
    }).from(schema.authorExternalIds)
      .where(eq(schema.authorExternalIds.authorId,id))
      .orderBy(asc(schema.authorExternalIds.source),
        asc(schema.authorExternalIds.externalId));
    return {author,aliases,externalIds};
  },{isolationLevel:'repeatable read'});
}

