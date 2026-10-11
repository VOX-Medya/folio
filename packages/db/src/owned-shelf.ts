import {and,desc,eq} from 'drizzle-orm';
import {z} from 'zod';
import {shelfListSchema,shelfUpdateSchema} from '@folio/contracts';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {getPublishedBookDetail} from './published-book.js';

type Database=ReturnType<typeof createFolioDb>['db'];
type Tx=Parameters<Parameters<Database['transaction']>[0]>[0];
const uuid=z.uuid();

/** A live, email-verified account AND exact current device must own every shelf write. */
async function withOwner<T>(
  db:Database,rawUser:string,rawSession:string,action:(tx:Tx,userId:string)=>Promise<T>,
):Promise<T>{
  const userId=uuid.parse(rawUser),sessionId=uuid.parse(rawSession);
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
    return action(tx,userId);
  });
}

export async function listOwnedShelf(db:Database,userId:string,sessionId:string,territory:string){
  z.string().regex(/^[A-Z]{2}$/).parse(territory);
  const rows=await withOwner(db,userId,sessionId,tx=>
    tx.select().from(schema.userShelfItems)
      .where(eq(schema.userShelfItems.userId,userId))
      .orderBy(desc(schema.userShelfItems.updatedAt),desc(schema.userShelfItems.workId))
      .limit(50));
  const items=[];
  for(const row of rows){
    const work=await getPublishedBookDetail(db,row.workId,territory);
    const edition=work?.editions[0];
    if(!work||!edition)continue; // Retraction cuts visibility without deleting owner state.
    items.push({id:work.id,title:work.title,authors:work.authors.map(x=>x.name),
      editionId:edition.id,revisionId:edition.revisionId,
      audioAvailable:edition.audioAvailable,status:row.status});
  }
  return shelfListSchema.parse({items});
}

export async function saveOwnedShelf(
  db:Database,userId:string,sessionId:string,rawWorkId:unknown,rawBody:unknown,
  territory:string,requestId?:string,
){
  const workId=uuid.parse(rawWorkId),input=shelfUpdateSchema.parse(rawBody);
  const trace=requestId?uuid.parse(requestId):undefined;
  const publicWork=await getPublishedBookDetail(db,workId,territory);
  if(!publicWork)throw new Error('Published book not found');
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const [row]=await tx.insert(schema.userShelfItems)
      .values({userId:actor,workId,status:input.status})
      .onConflictDoUpdate({
        target:[schema.userShelfItems.userId,schema.userShelfItems.workId],
        set:{status:input.status,updatedAt:new Date()},
      }).returning();
    await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'shelf.save',entityType:'work',entityId:workId,
      ...(trace?{requestId:trace}:{}),afterJson:{status:input.status},
    });
    return {saved:!!row};
  });
}

export async function deleteOwnedShelf(
  db:Database,userId:string,sessionId:string,rawWorkId:unknown,requestId?:string,
){
  const workId=uuid.parse(rawWorkId),trace=requestId?uuid.parse(requestId):undefined;
  return withOwner(db,userId,sessionId,async(tx,actor)=>{
    const removed=await tx.delete(schema.userShelfItems).where(and(
      eq(schema.userShelfItems.userId,actor),eq(schema.userShelfItems.workId,workId),
    )).returning({workId:schema.userShelfItems.workId});
    if(removed.length)await tx.insert(schema.auditEvents).values({
      actorId:actor,action:'shelf.remove',entityType:'work',entityId:workId,
      ...(trace?{requestId:trace}:{}),
    });
    return {removed:removed.length>0};
  });
}
