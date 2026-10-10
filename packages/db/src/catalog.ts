import {and,asc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {
  authorCreateSchema,workCreateSchema,canonicalAuthorMetadataPatchSchema,
  canonicalWorkMetadataPatchSchema,adminCatalogEditionAppendSchema,
  adminCatalogTitleAppendSchema,adminCatalogWorkAuthorAppendSchema,
  adminCatalogEditionMetadataPatchSchema,adminCatalogRelationRemoveSchema,
} from '@folio/contracts';
import type {
  AuthorCreate,WorkCreate,CanonicalAuthorMetadataPatch,CanonicalWorkMetadataPatch,
  AdminCatalogEditionAppend,AdminCatalogTitleAppend,AdminCatalogWorkAuthorAppend,
  AdminCatalogEditionMetadataPatch,
} from '@folio/contracts';
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


/**
 * Versioned editorial metadata ONLY. A row FOR UPDATE serializes concurrent
 * editors and the MFA/role share locks are held in this SAME transaction.
 * The trace and actor are created/verified server-side, never caller input.
 * Editor cannot change source text, country licensing or publication status.
 */
export async function patchVerifiedAdminAuthorMetadata(
  db:CatalogDb,bearer:string,authorId:string,raw:unknown,requestId:string,
){
  const id=z.uuid().parse(authorId);
  const traceId=z.uuid().parse(requestId);
  const input:CanonicalAuthorMetadataPatch=canonicalAuthorMetadataPatchSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,identity)=>{
    const [before]=await tx.select({
      id:schema.authors.id,canonicalName:schema.authors.canonicalName,
      sortName:schema.authors.sortName,
      metadataVersion:schema.authors.metadataVersion,
    }).from(schema.authors).where(eq(schema.authors.id,id)).limit(1).for('update');
    if(!before)return null;
    if(before.metadataVersion!==input.expectedVersion){
      throw new Error('Canonical metadata version conflict');
    }
    const oldAliases=await tx.select({
      name:schema.authorAliases.name,locale:schema.authorAliases.locale,
    }).from(schema.authorAliases).where(eq(schema.authorAliases.authorId,id))
      .orderBy(asc(schema.authorAliases.name),asc(schema.authorAliases.id));
    const oldExternalIds=await tx.select({
      source:schema.authorExternalIds.source,
      externalId:schema.authorExternalIds.externalId,
    }).from(schema.authorExternalIds).where(eq(schema.authorExternalIds.authorId,id))
      .orderBy(asc(schema.authorExternalIds.source),asc(schema.authorExternalIds.externalId));
    const version=before.metadataVersion+1;
    const [updated]=await tx.update(schema.authors).set({
      metadataVersion:version,
      canonicalName:input.canonicalName??before.canonicalName,
      sortName:input.sortName??before.sortName,
    }).where(eq(schema.authors.id,id)).returning();
    if(!updated)throw new Error('Canonical author disappeared during edit');
    if(input.aliases!==undefined){
      await tx.delete(schema.authorAliases).where(eq(schema.authorAliases.authorId,id));
      if(input.aliases.length)await tx.insert(schema.authorAliases).values(
        input.aliases.map(alias=>({authorId:id,name:alias.name,
          locale:alias.locale??null})),
      );
    }
    if(input.externalIds!==undefined){
      await tx.delete(schema.authorExternalIds).where(eq(schema.authorExternalIds.authorId,id));
      if(input.externalIds.length)await tx.insert(schema.authorExternalIds).values(
        input.externalIds.map(ext=>({authorId:id,source:ext.source,
          externalId:ext.externalId})),
      );
    }
    const aliases=input.aliases===undefined?oldAliases:input.aliases.map(alias=>({
      name:alias.name,locale:alias.locale??null,
    }));
    const externalIds=input.externalIds??oldExternalIds;
    await tx.insert(schema.auditEvents).values({
      actorId:identity.userId,action:'author.metadata.update',
      entityType:'author',entityId:id,requestId:traceId,
      beforeJson:{metadataVersion:before.metadataVersion,
        canonicalName:before.canonicalName,sortName:before.sortName,
        aliases:oldAliases,externalIds:oldExternalIds},
      afterJson:{metadataVersion:version,
        canonicalName:updated.canonicalName,sortName:updated.sortName,
        aliases,externalIds},
    });
    return {id,metadataVersion:version};
  });
}

export async function patchVerifiedAdminWorkMetadata(
  db:CatalogDb,bearer:string,workId:string,raw:unknown,requestId:string,
){
  const id=z.uuid().parse(workId);
  const traceId=z.uuid().parse(requestId);
  const input:CanonicalWorkMetadataPatch=canonicalWorkMetadataPatchSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,identity)=>{
    const [before]=await tx.select({
      id:schema.works.id,originalTitle:schema.works.originalTitle,
      originalLanguage:schema.works.originalLanguage,
      firstPublicationYear:schema.works.firstPublicationYear,
      publicationStatus:schema.works.publicationStatus,
      metadataVersion:schema.works.metadataVersion,
    }).from(schema.works).where(eq(schema.works.id,id)).limit(1).for('update');
    if(!before)return null;
    if(before.publicationStatus!=='draft'){
      throw new Error('Published canonical work is immutable via draft editor');
    }
    if(before.metadataVersion!==input.expectedVersion){
      throw new Error('Canonical metadata version conflict');
    }
    const version=before.metadataVersion+1;
    const title=input.originalTitle??before.originalTitle;
    const year=input.firstPublicationYear===undefined
      ?before.firstPublicationYear:input.firstPublicationYear;
    await tx.update(schema.works).set({
      originalTitle:title,firstPublicationYear:year,metadataVersion:version,
    }).where(eq(schema.works.id,id));
    if(input.originalTitle!==undefined){
      // Preserve original title/link consistency for both created drafts and
      // legacy imported works that have no work_titles original row yet.
      const changed=await tx.update(schema.workTitles).set({title})
        .where(and(eq(schema.workTitles.workId,id),
          eq(schema.workTitles.language,before.originalLanguage),
          eq(schema.workTitles.kind,'original')))
        .returning({id:schema.workTitles.id});
      if(!changed.length)await tx.insert(schema.workTitles).values({
        workId:id,language:before.originalLanguage,title,kind:'original',
      });
    }
    await tx.insert(schema.auditEvents).values({
      actorId:identity.userId,action:'work.metadata.update',
      entityType:'work',entityId:id,requestId:traceId,
      beforeJson:{metadataVersion:before.metadataVersion,
        originalTitle:before.originalTitle,
        originalLanguage:before.originalLanguage,
        firstPublicationYear:before.firstPublicationYear,
        publicationStatus:before.publicationStatus},
      afterJson:{metadataVersion:version,originalTitle:title,
        originalLanguage:before.originalLanguage,
        firstPublicationYear:year,
        publicationStatus:'draft'},
    });
    return {id,metadataVersion:version,publicationStatus:'draft' as const};
  });
}


/** Metadata relationship edits share the SAME actor/MFA/role-locked transaction
 * and target FOR UPDATE serialization as scalar DRAFT metadata PATCH.
 * Publishing, rights decisions, content and existing edition files are not inputs. */
async function verifiedDraftWorkForAppend(
  tx:CatalogTx,id:string,expectedVersion:number,
){
  const [before]=await tx.select({
    id:schema.works.id,publicationStatus:schema.works.publicationStatus,
    metadataVersion:schema.works.metadataVersion,
  }).from(schema.works).where(eq(schema.works.id,id)).limit(1).for('update');
  if(!before)return null;
  if(before.publicationStatus!=='draft'){
    throw new Error('Published canonical work is immutable via draft editor');
  }
  if(before.metadataVersion!==expectedVersion){
    throw new Error('Canonical metadata version conflict');
  }
  return {oldVersion:before.metadataVersion,newVersion:before.metadataVersion+1};
}
async function advanceDraftWorkVersion(tx:CatalogTx,id:string,newVersion:number){
  await tx.update(schema.works).set({metadataVersion:newVersion})
    .where(eq(schema.works.id,id));
}
export async function appendVerifiedAdminWorkEdition(
  db:CatalogDb,bearer:string,workId:string,raw:unknown,requestId:string,
){
  const id=z.uuid().parse(workId),traceId=z.uuid().parse(requestId);
  const input:AdminCatalogEditionAppend=adminCatalogEditionAppendSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,who)=>{
    const rev=await verifiedDraftWorkForAppend(tx,id,input.expectedVersion);
    if(!rev)return null;
    const [edition]=await tx.insert(schema.editions).values({
      workId:id,language:input.language,label:input.label,
      publisher:input.publisher??null,status:'draft',
    }).returning({id:schema.editions.id});
    if(!edition)throw new Error('Canonical edition creation failed');
    if(input.identifiers.length)await tx.insert(schema.editionIdentifiers).values(
      input.identifiers.map(identifier=>({editionId:edition.id,...identifier})),
    );
    if(input.contributors.length)await tx.insert(schema.editionContributors).values(
      input.contributors.map(contributor=>({
        editionId:edition.id,authorId:contributor.authorId,
        role:contributor.role,sortOrder:contributor.sortOrder,
      })),
    );
    await advanceDraftWorkVersion(tx,id,rev.newVersion);
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,requestId:traceId,
      action:'edition.create',entityType:'edition',entityId:edition.id,
      beforeJson:{workId:id,workMetadataVersion:rev.oldVersion},
      afterJson:{workId:id,workMetadataVersion:rev.newVersion,
        language:input.language,label:input.label,publisher:input.publisher??null,
        identifiers:input.identifiers,contributors:input.contributors,status:'draft'},
    });
    return {id:edition.id,workId:id,metadataVersion:rev.newVersion,status:'draft' as const};
  });
}

/** DRAFT-only edition metadata replacement: UUID/language/publication, rights
 * and immutable content revisions remain untouched. Both work+edition locks,
 * child metadata changes, parent optimistic version and audit commit together. */
export async function patchVerifiedAdminEditionMetadata(
  db:CatalogDb,bearer:string,workId:string,editionId:string,raw:unknown,
  requestId:string,
){
  const id=z.uuid().parse(workId),eid=z.uuid().parse(editionId);
  const traceId=z.uuid().parse(requestId);
  const input:AdminCatalogEditionMetadataPatch=
    adminCatalogEditionMetadataPatchSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,who)=>{
    const revision=await verifiedDraftWorkForAppend(tx,id,input.expectedVersion);
    if(!revision)return null;
    const [edition]=await tx.select({
      id:schema.editions.id,workId:schema.editions.workId,
      language:schema.editions.language,label:schema.editions.label,
      publisher:schema.editions.publisher,status:schema.editions.status,
    }).from(schema.editions).where(and(
      eq(schema.editions.id,eid),eq(schema.editions.workId,id),
    )).limit(1).for('update');
    if(!edition)return null;
    if(edition.status!=='draft'){
      throw new Error('Published canonical edition is immutable via draft editor');
    }
    const oldIdentifiers=await tx.select({
      kind:schema.editionIdentifiers.kind,value:schema.editionIdentifiers.value,
    }).from(schema.editionIdentifiers)
      .where(eq(schema.editionIdentifiers.editionId,eid))
      .orderBy(asc(schema.editionIdentifiers.kind),asc(schema.editionIdentifiers.value));
    const oldContributors=await tx.select({
      authorId:schema.editionContributors.authorId,
      role:schema.editionContributors.role,
      sortOrder:schema.editionContributors.sortOrder,
    }).from(schema.editionContributors)
      .where(eq(schema.editionContributors.editionId,eid))
      .orderBy(asc(schema.editionContributors.sortOrder),
        asc(schema.editionContributors.role),asc(schema.editionContributors.authorId));
    const nextLabel=input.label??edition.label;
    const nextPublisher=input.publisher===undefined?edition.publisher:input.publisher;
    if(input.label!==undefined||input.publisher!==undefined){
      await tx.update(schema.editions)
        .set({label:nextLabel,publisher:nextPublisher})
        .where(and(eq(schema.editions.id,eid),eq(schema.editions.workId,id)));
    }
    if(input.identifiers!==undefined){
      await tx.delete(schema.editionIdentifiers)
        .where(eq(schema.editionIdentifiers.editionId,eid));
      if(input.identifiers.length){
        await tx.insert(schema.editionIdentifiers).values(input.identifiers.map(item=>({
          editionId:eid,kind:item.kind,value:item.value,
        })));
      }
    }
    if(input.contributors!==undefined){
      await tx.delete(schema.editionContributors)
        .where(eq(schema.editionContributors.editionId,eid));
      if(input.contributors.length){
        await tx.insert(schema.editionContributors).values(input.contributors.map(person=>({
          editionId:eid,authorId:person.authorId,role:person.role,
          sortOrder:person.sortOrder,
        })));
      }
    }
    await advanceDraftWorkVersion(tx,id,revision.newVersion);
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,requestId:traceId,
      action:'edition.metadata.update',entityType:'edition',entityId:eid,
      beforeJson:{
        workId:id,workMetadataVersion:revision.oldVersion,
        language:edition.language,label:edition.label,publisher:edition.publisher,
        status:edition.status,identifiers:oldIdentifiers,contributors:oldContributors,
      },
      afterJson:{
        workId:id,workMetadataVersion:revision.newVersion,
        language:edition.language,label:nextLabel,publisher:nextPublisher,
        status:'draft',
        identifiers:input.identifiers??oldIdentifiers,
        contributors:input.contributors??oldContributors,
      },
    });
    return {id:eid,workId:id,metadataVersion:revision.newVersion,status:'draft' as const};
  });
}

export async function appendVerifiedAdminWorkTitle(
  db:CatalogDb,bearer:string,workId:string,raw:unknown,requestId:string,
){
  const id=z.uuid().parse(workId),traceId=z.uuid().parse(requestId);
  const input:AdminCatalogTitleAppend=adminCatalogTitleAppendSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,who)=>{
    const rev=await verifiedDraftWorkForAppend(tx,id,input.expectedVersion);
    if(!rev)return null;
    const [title]=await tx.insert(schema.workTitles).values({
      workId:id,language:input.language,title:input.title,kind:input.kind,
    }).returning({id:schema.workTitles.id});
    if(!title)throw new Error('Canonical alternate title creation failed');
    await advanceDraftWorkVersion(tx,id,rev.newVersion);
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,requestId:traceId,
      action:'work.title.add',entityType:'work',entityId:id,
      beforeJson:{workMetadataVersion:rev.oldVersion},
      afterJson:{workMetadataVersion:rev.newVersion,workTitleId:title.id,
        language:input.language,title:input.title,kind:input.kind},
    });
    return {id:title.id,workId:id,metadataVersion:rev.newVersion};
  });
}
export async function appendVerifiedAdminWorkAuthor(
  db:CatalogDb,bearer:string,workId:string,raw:unknown,requestId:string,
){
  const id=z.uuid().parse(workId),traceId=z.uuid().parse(requestId);
  const input:AdminCatalogWorkAuthorAppend=adminCatalogWorkAuthorAppendSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,who)=>{
    const rev=await verifiedDraftWorkForAppend(tx,id,input.expectedVersion);
    if(!rev)return null;
    await tx.insert(schema.workAuthors).values({
      workId:id,authorId:input.authorId,
      contribution:input.contribution,sortOrder:input.sortOrder,
    });
    await advanceDraftWorkVersion(tx,id,rev.newVersion);
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,requestId:traceId,
      action:'work.author.add',entityType:'work',entityId:id,
      beforeJson:{workMetadataVersion:rev.oldVersion},
      afterJson:{workMetadataVersion:rev.newVersion,
        authorId:input.authorId,contribution:input.contribution,sortOrder:input.sortOrder},
    });
    return {workId:id,authorId:input.authorId,metadataVersion:rev.newVersion};
  });
}


/**
 * Remove a mistaken OPTIONAL title relation from a DRAFT work.
 * A canonical original title is immutable through this editor. No text,
 * source revision, publication state, or rights record can be removed.
 * The work row lock serializes this operation against all other edits.
 */
export async function removeVerifiedAdminWorkTitle(
  db:CatalogDb,bearer:string,workId:string,titleId:string,raw:unknown,
  requestId:string,
){
  const id=z.uuid().parse(workId),tid=z.uuid().parse(titleId);
  const traceId=z.uuid().parse(requestId);
  const input=adminCatalogRelationRemoveSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,who)=>{
    const rev=await verifiedDraftWorkForAppend(tx,id,input.expectedVersion);
    if(!rev)return null;
    const [title]=await tx.select({
      id:schema.workTitles.id,workId:schema.workTitles.workId,
      title:schema.workTitles.title,language:schema.workTitles.language,
      kind:schema.workTitles.kind,
    }).from(schema.workTitles).where(and(
      eq(schema.workTitles.id,tid),eq(schema.workTitles.workId,id),
    )).limit(1).for('update');
    if(!title)return null;
    if(title.kind==='original'){
      throw new Error('Canonical original title cannot be unlinked');
    }
    const removed=await tx.delete(schema.workTitles).where(and(
      eq(schema.workTitles.id,tid),eq(schema.workTitles.workId,id),
    )).returning({id:schema.workTitles.id});
    if(removed.length!==1)throw new Error('Title relation changed during removal');
    await advanceDraftWorkVersion(tx,id,rev.newVersion);
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,requestId:traceId,
      action:'work.title.remove',entityType:'work',entityId:id,
      beforeJson:{workMetadataVersion:rev.oldVersion,
        titleId:tid,title:title.title,language:title.language,kind:title.kind},
      afterJson:{workMetadataVersion:rev.newVersion,
        removedTitleId:tid,relationRemoved:true},
    });
    return {id:tid,workId:id,metadataVersion:rev.newVersion};
  });
}

/**
 * Remove ONLY the link between a DRAFT work and a canonical author.
 * The referenced author, edition contributors and all content remain intact.
 * An author/co-author must remain; even a work containing only editors is
 * never allowed. The parent work revision lock makes the check atomic.
 */
export async function removeVerifiedAdminWorkAuthor(
  db:CatalogDb,bearer:string,workId:string,authorId:string,raw:unknown,
  requestId:string,
){
  const id=z.uuid().parse(workId),aid=z.uuid().parse(authorId);
  const traceId=z.uuid().parse(requestId);
  const input=adminCatalogRelationRemoveSchema.parse(raw);
  return withVerifiedAdminPermission(db,bearer,'catalog:edit',async(tx,who)=>{
    const rev=await verifiedDraftWorkForAppend(tx,id,input.expectedVersion);
    if(!rev)return null;
    const links=await tx.select({
      authorId:schema.workAuthors.authorId,
      contribution:schema.workAuthors.contribution,
      sortOrder:schema.workAuthors.sortOrder,
    }).from(schema.workAuthors)
      .where(eq(schema.workAuthors.workId,id))
      .orderBy(asc(schema.workAuthors.authorId)).for('update');
    const target=links.find(link=>link.authorId===aid);
    if(!target)return null;
    const remaining=links.filter(link=>link.authorId!==aid);
    if(!remaining.some(link=>link.contribution==='author'||
      link.contribution==='co-author')){
      throw new Error('Last canonical author link cannot be removed');
    }
    const removed=await tx.delete(schema.workAuthors).where(and(
      eq(schema.workAuthors.workId,id),eq(schema.workAuthors.authorId,aid),
    )).returning({authorId:schema.workAuthors.authorId});
    if(removed.length!==1)throw new Error('Author relation changed during removal');
    await advanceDraftWorkVersion(tx,id,rev.newVersion);
    await tx.insert(schema.auditEvents).values({
      actorId:who.userId,requestId:traceId,
      action:'work.author.remove',entityType:'work',entityId:id,
      beforeJson:{workMetadataVersion:rev.oldVersion,authorId:aid,
        contribution:target.contribution,sortOrder:target.sortOrder,
        relationCount:links.length},
      afterJson:{workMetadataVersion:rev.newVersion,removedAuthorId:aid,
        relationCount:remaining.length,relationRemoved:true},
    });
    return {workId:id,authorId:aid,metadataVersion:rev.newVersion};
  });
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
        metadataVersion:work.metadataVersion,
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
      metadataVersion:schema.authors.metadataVersion,
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

