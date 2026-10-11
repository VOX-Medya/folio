import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {readingPositionSchema,readingPositionUpdateSchema} from '@folio/contracts';
import type {PublishedReaderText,ReadingPosition,ReadingPositionUpdate} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {getPublishedReaderText} from './published-book.js';
import {withOwner} from './owned-shelf.js';

type Database=ReturnType<typeof createFolioDb>['db'];
const uuid=z.uuid();

export class ReadingPositionConflict extends Error {
  constructor(){super('Reading position changed on another request');this.name='ReadingPositionConflict';}
}
export class ReadingPositionNotFound extends Error {
  constructor(){super('Published reader not found');this.name='ReadingPositionNotFound';}
}
export class InvalidReadingAnchor extends Error {
  constructor(){super('Invalid published reading anchor');this.name='InvalidReadingAnchor';}
}

/** Anchors can only name actual visible blocks in the same rights-checked revision. */
export function assertPublishedReadingAnchor(book:PublishedReaderText,input:ReadingPositionUpdate):void{
  const chapter=book.chapters.find(ch=>ch.id===input.chapterId);
  const block=chapter?.blocks.find(b=>b.id===input.blockId);
  if(!block)throw new InvalidReadingAnchor();
  if(input.mode==='rsvp'){
    const count=block.includeRsvp?(block.text.match(/\S+/gu)?.length??0):0;
    if(!count||input.tokenOffset>=count||input.audioPositionMs!==null)throw new InvalidReadingAnchor();
  }else if(input.tokenOffset!==0||
    (input.mode==='normal'&&input.audioPositionMs!==null)||
    (input.mode==='audio'&&input.audioPositionMs===null)){
    throw new InvalidReadingAnchor();
  }
}
function publicPosition(row:typeof schema.userReadingPositions.$inferSelect):ReadingPosition{
  return readingPositionSchema.parse({
    revisionId:row.revisionId,chapterId:row.chapterId,blockId:row.blockId,
    tokenOffset:row.tokenOffset,audioPositionMs:row.audioPositionMs,
    mode:row.mode,version:row.version,
  });
}
async function published(db:Database,revisionId:string,territory:string){
  const book=await getPublishedReaderText(db,revisionId,territory);
  if(!book)throw new ReadingPositionNotFound();
  return book;
}

/** Current rights are checked before any personal position leaves the database. */
export async function getOwnedReadingPosition(
  db:Database,rawUser:string,rawSession:string,rawRevision:unknown,territory:string,
):Promise<ReadingPosition|null>{
  const revisionId=uuid.parse(rawRevision);
  await published(db,revisionId,territory);
  return withOwner(db,rawUser,rawSession,async tx=>{
    const [row]=await tx.select().from(schema.userReadingPositions).where(and(
      eq(schema.userReadingPositions.userId,rawUser),
      eq(schema.userReadingPositions.revisionId,revisionId),
    )).limit(1);
    return row?publicPosition(row):null;
  });
}

/** Compare-and-swap keeps back-navigation valid without silently losing another device's write. */
export async function putOwnedReadingPosition(
  db:Database,rawUser:string,rawSession:string,rawRevision:unknown,rawInput:unknown,
  territory:string,
):Promise<ReadingPosition>{
  const revisionId=uuid.parse(rawRevision);
  const input=readingPositionUpdateSchema.parse(rawInput);
  const book=await published(db,revisionId,territory);
  assertPublishedReadingAnchor(book,input);
  return withOwner(db,rawUser,rawSession,async tx=>{
    let rows:(typeof schema.userReadingPositions.$inferSelect)[];
    if(input.expectedVersion===0){
      rows=await tx.insert(schema.userReadingPositions).values({
        userId:rawUser,workId:book.workId,revisionId,
        chapterId:input.chapterId,blockId:input.blockId,tokenOffset:input.tokenOffset,
        mode:input.mode,audioPositionMs:input.audioPositionMs,
      }).onConflictDoNothing({target:[
        schema.userReadingPositions.userId,schema.userReadingPositions.revisionId,
      ]}).returning();
    }else{
      rows=await tx.update(schema.userReadingPositions).set({
        chapterId:input.chapterId,blockId:input.blockId,tokenOffset:input.tokenOffset,
        audioPositionMs:input.audioPositionMs,mode:input.mode,
        version:sql`${schema.userReadingPositions.version}+1`,updatedAt:new Date(),
      }).where(and(
        eq(schema.userReadingPositions.userId,rawUser),
        eq(schema.userReadingPositions.revisionId,revisionId),
        eq(schema.userReadingPositions.version,input.expectedVersion),
      )).returning();
    }
    const row=rows[0];
    if(!row)throw new ReadingPositionConflict();
    return publicPosition(row);
  });
}
