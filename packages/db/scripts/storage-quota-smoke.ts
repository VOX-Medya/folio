import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {eq,sql} from 'drizzle-orm';
import {createFolioDb,LocalStorageAdapter,
  reservePrivateUploadQuota,commitPrivateQuarantinedUpload,
  releasePrivateUploadQuota,inspectPrivateUploadQuota,sweepPrivateQuarantineOrphans,schema} from '../src/index.js';

function expect(ok:unknown,message:string):asserts ok {if(!ok)throw new Error(message);}
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit Folio test DB URL required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||!['localhost','127.0.0.1'].includes(target.hostname)||
    target.port!==(process.env.FOLIO_DB_PORT??'55432')){
    throw new Error('Quota smoke runs ONLY on Folio loopback folio_test');
  }
  const one=createFolioDb(url),two=createFolioDb(url);
  const root=await mkdtemp(join(tmpdir(),'folio-quota-private-'));
  const storage=await LocalStorageAdapter.create(root);
  const owner=randomUUID(),otherOwner=randomUUID(),cap=100;
  try{
    // Two writers race the SAME user quota across independent PostgreSQL pools.
    const results=await Promise.allSettled([
      reservePrivateUploadQuota(one.db,owner,70,cap),
      reservePrivateUploadQuota(two.db,owner,70,cap),
    ]);
    const accepted=results.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof reservePrivateUploadQuota>>>=>r.status==='fulfilled');
    const denied=results.filter(r=>r.status==='rejected');
    expect(accepted.length===1&&denied.length===1,'Concurrent 70+70 uploads exceeded 100-byte quota');
    expect(String((denied[0] as PromiseRejectedResult).reason).includes('quota exceeded'),'Race lost for an unexpected reason');
    const reservation=accepted[0]!.value;
    const first=await inspectPrivateUploadQuota(one.db,owner,cap);
    expect(first.committedBytes===0&&first.reservedBytes===70,'Pending quota reservation was lost');
    const payload=Buffer.from('Folio synthetic text only.','utf8');
    expect(payload.byteLength<70,'Fixture larger than test reservation');
    const staged=await storage.stage({owner:{scope:'private-user',ownerUserId:owner},
      source:Readable.from([payload]),declaredSha256:hash(payload),
      declaredMime:'text/plain',maxBytes:70});
    let deniedOwner=false;
    try{await commitPrivateQuarantinedUpload(two.db,storage,otherOwner,reservation.reservationId,staged);}
    catch{deniedOwner=true;}
    expect(deniedOwner,'Other owner adopted the staged file');
    const actual=await commitPrivateQuarantinedUpload(two.db,storage,owner,reservation.reservationId,staged);
    expect(!actual.alreadyCommitted&&actual.status==='pending_verify','Quarantine became public/verified');
    const retry=await commitPrivateQuarantinedUpload(one.db,storage,owner,reservation.reservationId,staged);
    expect(retry.alreadyCommitted&&retry.assetId===actual.assetId,'Idempotent commit created another asset');
    const [asset]=await one.db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id,actual.assetId));
    expect(asset?.ownerScope==='private-user'&&asset.ownerUserId===owner&&asset.status==='pending_verify'&&
      asset.sizeBytes===payload.byteLength&&asset.sha256===hash(payload),'Invalid stored quarantine metadata');
    const quota=await inspectPrivateUploadQuota(one.db,owner,cap);
    expect(quota.committedBytes===payload.byteLength&&quota.reservedBytes===0,'Committed reservation was double counted');
    const remaining=cap-payload.byteLength;
    const next=await reservePrivateUploadQuota(two.db,owner,remaining,cap);
    expect((await inspectPrivateUploadQuota(one.db,owner,cap)).reservedBytes===remaining,
      'Committed bytes do not reduce available quota');
    let over=false;
    try{await reservePrivateUploadQuota(two.db,owner,1,cap);}catch{over=true;}
    expect(over,'Quota permits overcommitting');
    const release=await releasePrivateUploadQuota(one.db,owner,next.reservationId);
    const secondRelease=await releasePrivateUploadQuota(two.db,owner,next.reservationId);
    expect(release.released&&!secondRelease.released,'Release was not idempotent');
    let committedReleased=false;
    try{await releasePrivateUploadQuota(one.db,owner,reservation.reservationId);}catch{committedReleased=true;}
    expect(committedReleased,'Committed media was released as unconsumed reservation');

    // Staged bytes larger than the reserved maximum must NEVER reach metadata.
    const tiny=await reservePrivateUploadQuota(one.db,owner,10,cap);
    let tooLarge=false;
    try{await commitPrivateQuarantinedUpload(one.db,storage,owner,tiny.reservationId,staged);}
    catch{tooLarge=true;}
    expect(tooLarge,'A too-small reservation accepted larger real bytes');
    await releasePrivateUploadQuota(one.db,owner,tiny.reservationId);

    // Expired reservations no longer consume the quota; actual files do.
    const [expired]=await one.db.insert(schema.storageUploadReservations).values({
      ownerUserId:owner,reservedBytes:cap,status:'reserved',expiresAt:new Date('2000-01-01'),
    }).returning();
    expect((await inspectPrivateUploadQuota(one.db,owner,cap)).reservedBytes===0,
      'Expired reservation permanently consumed quota');
    let expiredDenied=false;
    try{await commitPrivateQuarantinedUpload(one.db,storage,owner,expired!.id,staged);}
    catch{expiredDenied=true;}
    expect(expiredDenied,'Expired reservation allowed a file commit');
    const current=await one.db.select().from(schema.storageUploadReservations).where(eq(schema.storageUploadReservations.id,reservation.reservationId));
    expect(current[0]?.status==='committed'&&current[0].committedAssetId===actual.assetId,
      'Committed asset no longer has a durable reservation checkpoint');
    // Crash recovery / retention uses the same advisory owner lock as quota
    // reserve and commit. A completed .blob without metadata is old orphan
    // only after 72h; live reservations and ALL DB-referenced rows survive.
    const orphan=await storage.stage({owner:{scope:'private-user',ownerUserId:owner},
      source:Readable.from([payload]),declaredSha256:hash(payload),
      declaredMime:'text/plain',maxBytes:70});
    const otherBlob=await storage.stage({
      owner:{scope:'private-user',ownerUserId:otherOwner},source:Readable.from([payload]),
      declaredSha256:hash(payload),declaredMime:'text/plain',maxBytes:70,
    });
    const catalogBlob=await storage.stage({
      owner:{scope:'catalog',ownerUserId:null},source:Readable.from([payload]),
      declaredSha256:hash(payload),declaredMime:'text/plain',maxBytes:70,
    });
    const freshReport=await sweepPrivateQuarantineOrphans(one.db,storage,owner);
    expect(freshReport.removed===0&&freshReport.eligible===0&&freshReport.dryRun,
      'Fresh in-flight quarantine incorrectly became a reclaimable orphan');

    let waiting:ReturnType<typeof sweepPrivateQuarantineOrphans>|undefined;
    await one.db.transaction(async tx=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${owner}))`);
      // Start the collector in a second pool while the owner lock is held.
      waiting=sweepPrivateQuarantineOrphans(two.db,storage,owner,{apply:true});
      // A trusted reservation wins the lock and MUST block the collector.
      await tx.insert(schema.storageUploadReservations).values({
        ownerUserId:owner,reservedBytes:1,status:'reserved',
        expiresAt:new Date(Date.now()+60000),
      });
    });
    expect(waiting,'Concurrent collector was not started');
    const locked=await waiting;
    expect(locked.blockedByActiveReservation&&locked.removed===0,
      'Collector bypassed a concurrent live quota reservation');
    const [active]=await one.db.select().from(schema.storageUploadReservations)
      .where(eq(schema.storageUploadReservations.ownerUserId,owner))
      .orderBy(sql`created_at DESC`).limit(1);
    expect(active?.status==='reserved','Missing test reservation after owner lock');
    await releasePrivateUploadQuota(one.db,owner,active.id);

    // Explicit synthetic time advance does NOT change the real file clock or
    // production retention settings; no real user files exist in this test.
    const agedNow=Date.now()+5*24*60*60*1000;
    const preview=await sweepPrivateQuarantineOrphans(one.db,storage,owner,
      {testNowMs:agedNow});
    expect(preview.eligible===1&&preview.removed===0&&preview.dryRun,
      'Orphan dry-run did not preserve bytes');
    const applied=await sweepPrivateQuarantineOrphans(two.db,storage,owner,
      {apply:true,testNowMs:agedNow});
    expect(!applied.blockedByActiveReservation&&applied.eligible===1&&applied.removed===1,
      'Exactly one unreferenced staged private blob was not reclaimed');
    const repeatSweep=await sweepPrivateQuarantineOrphans(one.db,storage,owner,
      {apply:true,testNowMs:agedNow});
    expect(repeatSweep.removed===0,'Orphan sweep was not idempotent');
    expect((await storage.inspectQuarantined(staged)).sizeBytes===payload.length,
      'A DB-registered private pending asset was reclaimed');
    expect((await storage.inspectQuarantined(otherBlob)).sizeBytes===payload.length,
      'The collector deleted another private owner asset');
    expect((await storage.inspectQuarantined(catalogBlob)).sizeBytes===payload.length,
      'The collector deleted a catalog asset');
    let orphanGone=false;
    try{await storage.inspectQuarantined(orphan);}catch{orphanGone=true;}
    expect(orphanGone,'Unreferenced synthetic old blob was not deleted');
    console.log('Private orphan retention PASS: .part/.blob atomic staging, active reservation owner-lock race, 72h age, dry-run/apply, idempotent, registered/other-user/catalog bytes retained.');

    console.log('Private quota PASS: two DB pools 70+70 race, exact bytes, release/replay, expired quota, forged owner denied; asset remains pending_verify. Folio test DB only.');
  }finally{
    await one.pool.end();await two.pool.end();
    await rm(root,{recursive:true,force:true});
  }
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
