import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {translationLinkCreateSchema,translationSwitchRequestSchema} from '@folio/contracts';
import type {TranslationLinkCreate} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';

type TranslationDb=ReturnType<typeof createFolioDb>['db'];

/** Import only pre-existing translated revisions; never synthesizes translations. */
export async function createPreparedTranslationLink(db:TranslationDb,actorId:string,raw:unknown){
  const actor=z.uuid().parse(actorId);
  const input:TranslationLinkCreate=translationLinkCreateSchema.parse(raw);
  return db.transaction(async tx=>{
    const [source]=await tx.select().from(schema.contentRevisions).where(eq(schema.contentRevisions.id,input.sourceRevisionId)).limit(1);
    const [target]=await tx.select().from(schema.contentRevisions).where(eq(schema.contentRevisions.id,input.targetRevisionId)).limit(1);
    if(!source || !target)throw new Error('Both prepared content revisions are required');
    if(source.language===target.language)throw new Error('Translations require distinct source/target languages');
    const [sourceEdition]=await tx.select().from(schema.editions).where(eq(schema.editions.id,source.editionId)).limit(1);
    const [targetEdition]=await tx.select().from(schema.editions).where(eq(schema.editions.id,target.editionId)).limit(1);
    if(!sourceEdition || !targetEdition || sourceEdition.workId!==targetEdition.workId){
      throw new Error('Translations must belong to editions of the same canonical work');
    }
    if(input.translatorId){
      const [translator]=await tx.select().from(schema.authors).where(eq(schema.authors.id,input.translatorId)).limit(1);
      if(!translator)throw new Error('Translator identity does not exist');
    }
    const [link]=await tx.insert(schema.translationLinks).values({
      sourceRevisionId:source.id,targetRevisionId:target.id,translatorId:input.translatorId??null,
      provenance:input.provenance,status:'pending',createdBy:actor,
    }).returning();
    if(!link)throw new Error('Translation link creation failed');
    if(input.alignments.length)await tx.insert(schema.textAlignments).values(input.alignments.map(edge=>({
      linkId:link.id,sourceRevisionId:source.id,targetRevisionId:target.id,
      sourceBlockId:edge.sourceBlockId,targetBlockId:edge.targetBlockId,
      alignmentKind:edge.alignmentKind,verified:false,
    })));
    await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'translation.link.create',entityType:'translation_link',entityId:link.id,
      afterJson:{sourceRevisionId:source.id,targetRevisionId:target.id,edges:input.alignments.length,status:'pending'},
    });
    return link;
  });
}

/** Manual verification of selected already-imported edges; caller must establish trusted reviewer permission. */
export async function verifyPreparedTranslationEdges(db:TranslationDb,reviewerId:string,linkId:string,reason:string){
  const reviewer=z.uuid().parse(reviewerId);
  const id=z.uuid().parse(linkId);
  const note=z.string().trim().min(12).max(1000).parse(reason);
  return db.transaction(async tx=>{
    const [link]=await tx.select().from(schema.translationLinks).where(eq(schema.translationLinks.id,id)).limit(1);
    if(!link || link.status!=='pending')throw new Error('Translation must be a pending manual review');
    const edges=await tx.select().from(schema.textAlignments).where(eq(schema.textAlignments.linkId,id));
    if(edges.length===0)throw new Error('Cannot verify a translation without block evidence');
    await tx.update(schema.textAlignments).set({verified:true,verifiedBy:reviewer,verifiedAt:new Date()})
      .where(eq(schema.textAlignments.linkId,id));
    const [updated]=await tx.update(schema.translationLinks).set({status:'reviewed'})
      .where(eq(schema.translationLinks.id,id)).returning();
    await tx.insert(schema.auditEvents).values({
      actorId:reviewer,action:'translation.alignments.review',entityType:'translation_link',entityId:id,
      afterJson:{status:'reviewed',verifiedEdges:edges.length},reason:note,
    });
    return updated;
  });
}

export type TranslationSwitch={
  mode:'verified-blocks'|'chapter-fallback';targetRevisionId:string;targetBlockIds:string[];
  targetChapterId:string|null;warning:string|null;
};

/** Only verified manual links permit exact block switch; never fabricate a word offset. */
export async function resolveTranslationSwitch(db:TranslationDb,raw:unknown):Promise<TranslationSwitch>{
  const request=translationSwitchRequestSchema.parse(raw);
  const [link]=await db.select().from(schema.translationLinks).where(eq(schema.translationLinks.id,request.linkId)).limit(1);
  if(!link)throw new Error('Translation link not found');
  const [source]=await db.select().from(schema.contentBlocks).where(and(
    eq(schema.contentBlocks.revisionId,link.sourceRevisionId),eq(schema.contentBlocks.blockId,request.sourceBlockId),
  )).limit(1);
  if(!source)throw new Error('Source block not found in the source revision');
  if(link.status==='reviewed'){
    const edges=await db.select().from(schema.textAlignments).where(and(
      eq(schema.textAlignments.linkId,link.id),eq(schema.textAlignments.sourceBlockId,source.blockId),
      eq(schema.textAlignments.verified,true),
    ));
    if(edges.length){
      const targetBlocks=await db.select({block:schema.contentBlocks,chapterOrdinal:schema.contentChapters.ordinal})
        .from(schema.contentBlocks).innerJoin(schema.contentChapters,and(
          eq(schema.contentChapters.revisionId,schema.contentBlocks.revisionId),
          eq(schema.contentChapters.chapterId,schema.contentBlocks.chapterId),
        )).where(eq(schema.contentBlocks.revisionId,link.targetRevisionId));
      const matched=targetBlocks.filter(b=>edges.some(edge=>edge.targetBlockId===b.block.blockId))
        .sort((a,b)=>a.chapterOrdinal-b.chapterOrdinal||a.block.ordinal-b.block.ordinal);
      if(matched.length===edges.length){
        return {mode:'verified-blocks',targetRevisionId:link.targetRevisionId,
          targetBlockIds:matched.map(m=>m.block.blockId),targetChapterId:matched[0]!.block.chapterId,warning:null};
      }
    }
  }
  const [sourceChapter]=await db.select().from(schema.contentChapters).where(and(
    eq(schema.contentChapters.revisionId,link.sourceRevisionId),eq(schema.contentChapters.chapterId,source.chapterId),
  )).limit(1);
  const targetChapters=await db.select().from(schema.contentChapters)
    .where(eq(schema.contentChapters.revisionId,link.targetRevisionId));
  targetChapters.sort((a,b)=>a.ordinal-b.ordinal);
  const fallback=targetChapters.find(c=>c.ordinal===sourceChapter?.ordinal)??targetChapters[0];
  return {mode:'chapter-fallback',targetRevisionId:link.targetRevisionId,targetBlockIds:[],
    targetChapterId:fallback?.chapterId??null,warning:'Paragraf eşleştirmesi doğrulanmadı; bölüm başına geçildi.'};
}
