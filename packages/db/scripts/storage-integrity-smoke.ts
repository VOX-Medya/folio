import {randomUUID} from 'node:crypto';
import {createFolioDb,schema} from '../src/index.js';

function check(ok:unknown,message:string):asserts ok{
  if(!ok)throw new Error(message);
}
function sqlState(error:unknown):string|null{
  let current:unknown=error;
  for(let depth=0;depth<5;depth++){
    if(!current||typeof current!=='object')return null;
    const item=current as {code?:unknown;cause?:unknown};
    if(typeof item.code==='string')return item.code;
    current=item.cause;
  }
  return null;
}
async function mustReject(
  label:string,attempt:()=>Promise<unknown>,expected:'23503'|'23514',
):Promise<void>{
  try{await attempt();}
  catch(error){
    if(sqlState(error)===expected)return;
    throw new Error('Unexpected SQL error for '+label+': '+String(error));
  }
  throw new Error('PostgreSQL accepted unsafe '+label);
}

async function main():Promise<void>{
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio test database URL required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||
    !['127.0.0.1','localhost'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Private asset integrity test runs ONLY on isolated Folio loopback folio_test');
  }
  const {db,pool}=createFolioDb(url);
  const ownerA=randomUUID(),ownerB=randomUUID();
  const good={
    ownerScope:'private-user',ownerUserId:ownerA,
    storageKey:randomUUID(),sha256:'a'.repeat(64),sizeBytes:11,
    mime:'text/plain',durationMs:null,status:'pending_verify',
    verifiedAt:null,
  };
  try{
    const negative=[
      ['private asset without owner',{ownerUserId:null}],
      ['catalog asset with user owner',{ownerScope:'catalog'}],
      ['unknown visibility scope',{ownerScope:'public'}],
      ['traversal as private key',{storageKey:'../../catalog/sensitive'}],
      ['uppercase key',{storageKey:randomUUID().toUpperCase()}],
      ['non-SHA declaration',{sha256:'BAD'}],
      ['uppercase SHA declaration',{sha256:'A'.repeat(64)}],
      ['zero-byte asset',{sizeBytes:0}],
      ['negative-byte asset',{sizeBytes:-10}],
      ['asset above 1 GiB',{sizeBytes:1073741825}],
      ['unapproved MIME',{mime:'text/html'}],
      ['invalid audio duration',{durationMs:0}],
      ['nonexistent state',{status:'published'}],
      ['verified without byte scan timestamp',{status:'verified'}],
      ['quarantine carrying verification timestamp',{verifiedAt:new Date()}],
    ] as const;
    for(const [label,patch] of negative){
      await mustReject(label,async()=>{
        await db.insert(schema.mediaAssets).values({...good,...patch});
      },'23514');
    }
    // The old catalog manifest key is NOT converted into a private path or
    // approved upload by this migration. Both valid rows stay pending.
    const rollback='EXPECTED_SYNTHETIC_ROLLBACK';
    try{
      await db.transaction(async tx=>{
        const [catalog]=await tx.insert(schema.mediaAssets).values({
          ...good,ownerScope:'catalog',ownerUserId:null,
          storageKey:'private/catalog/manual/imported-audio.m4a',
        }).returning();
        const [privateAsset]=await tx.insert(schema.mediaAssets)
          .values(good).returning();
        check(catalog?.status==='pending_verify'&&catalog.verifiedAt===null,
          'Legacy catalog reference unexpectedly verified');
        check(privateAsset?.status==='pending_verify'&&privateAsset.verifiedAt===null,
          'New private asset unexpectedly verified');
        const [reservation]=await tx.insert(schema.storageUploadReservations).values({
          ownerUserId:ownerA,status:'committed',reservedBytes:11,
          expiresAt:new Date(Date.now()+60000),committedAssetId:privateAsset.id,
        }).returning();
        check(reservation?.committedAssetId===privateAsset.id,
          'Same-owner quota/asset binding rejected');
        throw new Error(rollback);
      });
    }catch(error){check(String(error).includes(rollback),'Positive asset fixtures rejected: '+String(error));}
    // This MUST fail even when the targeted asset UUID exists and is valid.
    // One atomic transaction intentionally rolls back all synthetic test rows.
    await mustReject('cross-owner committed asset reference',async()=>{
      await db.transaction(async tx=>{
        const [asset]=await tx.insert(schema.mediaAssets).values(good).returning();
        check(asset,'Synthetic private asset insert failed');
        await tx.insert(schema.storageUploadReservations).values({
          ownerUserId:ownerB,status:'committed',reservedBytes:11,
          expiresAt:new Date(Date.now()+60000),committedAssetId:asset.id,
        });
      });
    },'23503');
    await mustReject('committed reservation without an asset',async()=>{
      await db.insert(schema.storageUploadReservations).values({
        ownerUserId:ownerA,status:'committed',reservedBytes:11,
        expiresAt:new Date(Date.now()+60000),committedAssetId:null,
      });
    },'23514');
    await mustReject('reserved record holding a committed asset',async()=>{
      await db.transaction(async tx=>{
        const [asset]=await tx.insert(schema.mediaAssets).values(good).returning();
        check(asset,'Synthetic private asset insert failed');
        await tx.insert(schema.storageUploadReservations).values({
          ownerUserId:ownerA,status:'reserved',reservedBytes:11,
          expiresAt:new Date(Date.now()+60000),committedAssetId:asset.id,
        });
      });
    },'23514');
    await mustReject('reservation above storage bound',async()=>{
      await db.insert(schema.storageUploadReservations).values({
        ownerUserId:ownerA,status:'reserved',reservedBytes:1073741825,
        expiresAt:new Date(Date.now()+60000),committedAssetId:null,
      });
    },'23514');

    console.log('PRIVATE ASSET INTEGRITY PASS: 15 unsafe metadata rows denied by PostgreSQL, same-owner commit allowed, cross-owner FK/invalid reservation states denied; valid catalog and private records remain pending. Synthetic Folio-only transaction rollback; no byte publication.');
  }finally{await pool.end();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
