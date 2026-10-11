import {createHash} from 'node:crypto';
import {and, asc, eq} from 'drizzle-orm';
import {z} from 'zod';
import {contentRevisionCreateSchema} from '@folio/contracts';
import type {ContentRevisionCreate} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {withVerifiedAdminPermission} from './admin-authorization.js';

type ContentDb = ReturnType<typeof createFolioDb>['db'];
export const sha256Text = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Never alters existing source text or revises the same revision in place. */
export async function createContentRevision(db: ContentDb, actorId: string, raw: unknown) {
  const actor = z.uuid().parse(actorId);
  const input: ContentRevisionCreate = contentRevisionCreateSchema.parse(raw);
  for (const chapter of input.chapters) {
    for (const block of chapter.blocks) {
      if (sha256Text(block.sourceText) !== block.textSha256) throw new Error('Block SHA-256 mismatch: source text rejected');
    }
  }
  const normalizedSha256 = sha256Text(JSON.stringify(input.chapters.map(ch=>({
    chapterId:ch.chapterId,ordinal:ch.ordinal,heading:ch.heading,
    blocks:ch.blocks.map(b=>({id:b.blockId,ordinal:b.ordinal,kind:b.kind,textSha256:b.textSha256})),
  }))));

  return db.transaction(async tx => {
    const [edition] = await tx.select().from(schema.editions).where(eq(schema.editions.id, input.editionId)).limit(1);
    if (!edition || edition.language !== input.language) throw new Error('Content revision edition/language mismatch');
    if (input.parentRevisionId) {
      const [parent] = await tx.select().from(schema.contentRevisions)
        .where(and(eq(schema.contentRevisions.id, input.parentRevisionId), eq(schema.contentRevisions.editionId, input.editionId))).limit(1);
      if (!parent) throw new Error('Parent revision belongs to another edition or does not exist');
    }
    const [provenance] = await tx.insert(schema.sourceProvenance).values({
      sourceName: input.provenance.sourceName,
      sourceUrl: input.provenance.sourceUrl ?? null,
      sourceExternalId: input.provenance.sourceExternalId ?? null,
      licenseClaim: input.provenance.licenseClaim ?? null,
      sourceSnapshot: input.provenance,
    }).returning();
    if (!provenance) throw new Error('Provenance insertion failed');
    const [revision] = await tx.insert(schema.contentRevisions).values({
      editionId: edition.id, language: input.language, parentRevisionId: input.parentRevisionId ?? null,
      rawArtifactKey: input.rawArtifactKey, rawSha256: input.rawSha256, normalizedSha256,
      parserVersion: input.parserVersion, provenanceId: provenance.id,
      status: 'draft', createdBy: actor,
    }).returning();
    if (!revision) throw new Error('Revision insertion failed');
    await tx.insert(schema.contentChapters).values(input.chapters.map(ch=>({
      revisionId:revision.id,chapterId:ch.chapterId,ordinal:ch.ordinal,heading:ch.heading,
    })));
    const blocks = input.chapters.flatMap(ch=>ch.blocks.map(block=>({
      revisionId:revision.id,blockId:block.blockId,chapterId:ch.chapterId,
      ordinal:block.ordinal,parentBlockId:block.parentBlockId ?? null,kind:block.kind,
      sourceLocator:block.locator,sourceText:block.sourceText,textSha256:block.textSha256,
      includeNormal:block.includeNormal,includeRsvp:block.includeRsvp,includeAudio:block.includeAudio,
    })));
    await tx.insert(schema.contentBlocks).values(blocks);
    await tx.insert(schema.auditEvents).values({
      actorId:actor, action:'content.revision.create', entityType:'content_revision',entityId:revision.id,
      afterJson:{editionId:edition.id,rawSha256:revision.rawSha256,blockCount:blocks.length,status:'draft'},
    });
    return {revision,chapterCount:input.chapters.length,blockCount:blocks.length};
  });
}

/** Source stays verbatim; auxiliary elements do not leak into RSVP/audio flow. */
export async function getRevisionBlocks(db:ContentDb, revisionId:string, mode:'normal'|'rsvp'|'audio') {
  const id=z.uuid().parse(revisionId);
  const joined = await db.select({block: schema.contentBlocks, chapterOrdinal: schema.contentChapters.ordinal})
    .from(schema.contentBlocks)
    .innerJoin(schema.contentChapters, and(
      eq(schema.contentBlocks.revisionId, schema.contentChapters.revisionId),
      eq(schema.contentBlocks.chapterId, schema.contentChapters.chapterId),
    ))
    .where(eq(schema.contentBlocks.revisionId,id));
  return joined.filter(({block:b})=>mode==='normal'?b.includeNormal:mode==='rsvp'?b.includeRsvp:b.includeAudio)
    .sort((a,b)=>a.chapterOrdinal-b.chapterOrdinal||a.block.ordinal-b.block.ordinal)
    .map(item=>item.block);
}

/** Admin editorial chapter preview. Never expose this under public routes.
 * Live session, role and same-device MFA are locked with the read snapshot. */
export async function getVerifiedAdminContentChapter(
  db:ContentDb,bearer:string,rawInput:unknown,
){
  const input=z.object({
    workId:z.uuid(),editionId:z.uuid(),revisionId:z.uuid(),chapterId:z.uuid(),
  }).strict().parse(rawInput);
  return withVerifiedAdminPermission(db,bearer,'catalog:read',async tx=>{
    const [revision]=await tx.select({
      id:schema.contentRevisions.id,
      parentRevisionId:schema.contentRevisions.parentRevisionId,
      language:schema.contentRevisions.language,
      status:schema.contentRevisions.status,
      sourceSha256:schema.contentRevisions.rawSha256,
      provenanceId:schema.contentRevisions.provenanceId,
    }).from(schema.contentRevisions)
      .innerJoin(schema.editions,and(
        eq(schema.editions.id,schema.contentRevisions.editionId),
        eq(schema.editions.workId,input.workId),
      ))
      .where(and(
        eq(schema.contentRevisions.id,input.revisionId),
        eq(schema.contentRevisions.editionId,input.editionId),
      )).limit(1);
    if(!revision)return null;
    const [chapter]=await tx.select({
      id:schema.contentChapters.chapterId,
      ordinal:schema.contentChapters.ordinal,
      heading:schema.contentChapters.heading,
    }).from(schema.contentChapters).where(and(
      eq(schema.contentChapters.revisionId,revision.id),
      eq(schema.contentChapters.chapterId,input.chapterId),
    )).limit(1);
    if(!chapter)return null;
    const blocks=await tx.select({
      id:schema.contentBlocks.blockId,
      ordinal:schema.contentBlocks.ordinal,
      kind:schema.contentBlocks.kind,
      sourceText:schema.contentBlocks.sourceText,
      textSha256:schema.contentBlocks.textSha256,
      includeNormal:schema.contentBlocks.includeNormal,
      includeRsvp:schema.contentBlocks.includeRsvp,
      includeAudio:schema.contentBlocks.includeAudio,
    }).from(schema.contentBlocks).where(and(
      eq(schema.contentBlocks.revisionId,revision.id),
      eq(schema.contentBlocks.chapterId,input.chapterId),
    )).orderBy(asc(schema.contentBlocks.ordinal));
    return {workId:input.workId,editionId:input.editionId,
      revision,chapter,blocks};
  },{isolationLevel:'repeatable read'});
}
