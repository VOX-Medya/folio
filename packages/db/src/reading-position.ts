import {and,eq} from 'drizzle-orm';
import {z} from 'zod';
import {readingPositionInputSchema,readingPositionResponseSchema} from '@folio/contracts';
import type {ReadingPositionInput,ReadingPositionResponse} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {getPublishedReaderText} from './published-book.js';
import {getAuthorizedPublishedAudio} from './published-audio.js';

type Database=ReturnType<typeof createFolioDb>['db'];
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
const uuid=z.uuid();

/** Re-verify the persisted verified account/device INSIDE the owner transaction. */
async function withReaderOwner<T>(
  db:Database,rawUserId:string,rawSessionId:string,
  callback:(tx:Tx,userId:string)=>Promise<T>,
):Promise<T>{
  const userId=uuid.parse(rawUserId),sessionId=uuid.parse(rawSessionId);
  return db.transaction(async tx=>{
    const [account]=await tx.select().from(schema.userAccounts)
      .where(eq(schema.userAccounts.id,userId)).limit(1).for('share');
    if(!account||account.status!=='active'||!account.emailVerifiedAt){
      throw new Error('Verified session required');
    }
    const [session]=await tx.select().from(schema.userSessions)
      .where(and(eq(schema.userSessions.id,sessionId),eq(schema.userSessions.userId,userId)))
      .limit(1).for('share');
    if(!session||session.revokedAt||session.expiresAt.getTime()<=Date.now()){
      throw new Error('Verified session required');
    }
    return callback(tx,userId);
  });
}

function response(row:typeof schema.userReadingPositions.$inferSelect|null):ReadingPositionResponse{
  return readingPositionResponseSchema.parse({position:row?{
    revisionId:row.revisionId,chapterId:row.chapterId,blockId:row.blockId,
    wordIndex:row.wordIndex,audioSecond:row.audioSecond,mode:row.mode,
    version:row.version,updatedAt:row.updatedAt.toISOString(),
  }:null});
}

/** Read only own position for a revision currently readable under server territory. */
export async function getOwnedReadingPosition(
  db:Database,userId:string,sessionId:string,rawRevisionId:unknown,territory:string,
):Promise<ReadingPositionResponse>{
  const revisionId=uuid.parse(rawRevisionId);
  const published=await getPublishedReaderText(db,revisionId,territory);
  if(!published)throw new Error('Published revision not found');
  return withReaderOwner(db,userId,sessionId,async(tx,actor)=>{
    const [row]=await tx.select().from(schema.userReadingPositions)
      .where(and(eq(schema.userReadingPositions.userId,actor),
        eq(schema.userReadingPositions.revisionId,revisionId))).limit(1);
    return response(row??null);
  });
}

export async function saveOwnedReadingPosition(
  db:Database,userId:string,sessionId:string,rawRevisionId:unknown,
  rawBody:unknown,territory:string,
):Promise<ReadingPositionResponse>{
  const revisionId=uuid.parse(rawRevisionId);
  const input:ReadingPositionInput=readingPositionInputSchema.parse(rawBody);
  const published=await getPublishedReaderText(db,revisionId,territory);
  if(!published)throw new Error('Published revision not found');
  const chapter=published.chapters.find(ch=>ch.id===input.chapterId);
  const block=chapter?.blocks.find(b=>b.id===input.blockId);
  if(!chapter||!block||
     (input.mode==='rsvp'&&!block.includeRsvp)||
     (input.mode==='audio'&&(!block.includeRsvp||input.wordIndex!==0))||
     (input.mode!=='audio'&&input.audioSecond!==0)){
    throw new Error('Invalid reading position');
  }
  const words=block.text.match(/\S+/gu)?.length??0;
  if(input.wordIndex>words)throw new Error('Invalid reading position');
  if(input.mode==='audio'){
    const audio=await getAuthorizedPublishedAudio(db,revisionId,input.chapterId,territory);
    if(!audio)throw new Error('Approved audio not found');
  }
  return withReaderOwner(db,userId,sessionId,async(tx,actor)=>{
    const [row]=await tx.select().from(schema.userReadingPositions)
      .where(and(eq(schema.userReadingPositions.userId,actor),
        eq(schema.userReadingPositions.revisionId,revisionId))).limit(1).for('update');
    if(!row){
      if(input.expectedVersion!==0)throw new Error('Reading position changed');
      const [created]=await tx.insert(schema.userReadingPositions).values({
        userId:actor,revisionId,chapterId:input.chapterId,blockId:input.blockId,
        wordIndex:input.wordIndex,audioSecond:input.audioSecond,mode:input.mode,
        version:1,
      }).onConflictDoNothing().returning();
      if(!created)throw new Error('Reading position changed');
      return response(created);
    }
    if(row.version!==input.expectedVersion||row.version>=2147483646){
      throw new Error('Reading position changed');
    }
    const [updated]=await tx.update(schema.userReadingPositions).set({
      chapterId:input.chapterId,blockId:input.blockId,
      wordIndex:input.wordIndex,audioSecond:input.audioSecond,mode:input.mode,
      version:row.version+1,updatedAt:new Date(),
    }).where(and(eq(schema.userReadingPositions.userId,actor),
      eq(schema.userReadingPositions.revisionId,revisionId))).returning();
    if(!updated)throw new Error('Reading position changed');
    return response(updated);
  });
}
