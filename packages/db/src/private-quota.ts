import {and,eq,gt,notInArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {createFolioDb} from './index.js';
import * as schema from './schema.js';
import {LocalStorageAdapter,LOCAL_STORAGE_MAX_BYTES} from './local-storage.js';
import type {QuarantinedBlob} from './local-storage.js';
import type {CandidateMime} from './local-storage.js';
import type {QuarantineByteScanner} from './quarantine-scanner.js';

type QuotaDb=ReturnType<typeof createFolioDb>['db'];
const uuid=z.uuid();
const positiveBytes=z.number().int().positive().max(LOCAL_STORAGE_MAX_BYTES);
const expirySeconds=z.number().int().min(30).max(3600);

/**
 * INTERNAL gate, not an authorization endpoint. The caller must have a trusted
 * verified user principal. None of these methods returns a public file URL.
 * Pending/quarantined bytes count against the owner's committed quota.
 */
async function usage(tx:Parameters<Parameters<QuotaDb['transaction']>[0]>[0],owner:string,now:Date){
  const [assets]=await tx.select({total:sql<string>`coalesce(sum(${schema.mediaAssets.sizeBytes}),0)::text`})
    .from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.ownerScope,'private-user'),
      eq(schema.mediaAssets.ownerUserId,owner),
      notInArray(schema.mediaAssets.status,['deleted','rejected']),
    ));
  const [pending]=await tx.select({total:sql<string>`coalesce(sum(${schema.storageUploadReservations.reservedBytes}),0)::text`})
    .from(schema.storageUploadReservations).where(and(
      eq(schema.storageUploadReservations.ownerUserId,owner),
      eq(schema.storageUploadReservations.status,'reserved'),
      gt(schema.storageUploadReservations.expiresAt,now),
    ));
  return {committed:BigInt(assets?.total??'0'),reserved:BigInt(pending?.total??'0')};
}
function lockOwner(owner:string){return sql`SELECT pg_advisory_xact_lock(hashtext(${owner}))`;}
function assertOwner(blob:QuarantinedBlob,userId:string){
  if(blob.scope!=='private-user'||blob.ownerUserId!==userId||blob.status!=='pending_verify'){
    throw new Error('Private blob owner mismatch or untrusted verification state');
  }
}

/** One write-admission at a time per owner, safe across multiple DB pools. */
export async function reservePrivateUploadQuota(
  db:QuotaDb, trustedOwnerId:string, declaredBytes:number, maxUserBytes:number, ttlSeconds=900
){
  const owner=uuid.parse(trustedOwnerId);
  const bytes=positiveBytes.parse(declaredBytes),limit=positiveBytes.parse(maxUserBytes);
  const ttl=expirySeconds.parse(ttlSeconds);
  if(bytes>limit)throw new Error('Private storage quota exceeded');
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const now=new Date();
    const {committed,reserved}=await usage(tx,owner,now);
    if(committed+reserved+BigInt(bytes)>BigInt(limit))throw new Error('Private storage quota exceeded');
    const [reservation]=await tx.insert(schema.storageUploadReservations).values({
      ownerUserId:owner,reservedBytes:bytes,status:'reserved',
      expiresAt:new Date(now.getTime()+ttl*1000),
    }).returning();
    if(!reservation)throw new Error('Private quota reservation failed');
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quota.reserve',
      entityType:'storage_reservation',entityId:reservation.id,
      afterJson:{ownerScope:'private-user',reservedBytes:bytes,maxUserBytes:limit},
    });
    return {reservationId:reservation.id,expiresAt:reservation.expiresAt,reservedBytes:bytes};
  });
}

/**
 * Immutable, owner-matched, already-hashed quarantined bytes become metadata.
 * This never marks the asset verified or playable; malware/codec/rights gates
 * must still run before promoting or delivering its contents.
 */
export async function commitPrivateQuarantinedUpload(
  db:QuotaDb,storage:LocalStorageAdapter,trustedOwnerId:string,reservationId:string,blob:QuarantinedBlob
){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(reservationId);
  assertOwner(blob,owner);
  // Refuse forged storage keys, mutated bytes, symlinks and cross-owner files.
  await storage.inspectQuarantined(blob);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [reservation]=await tx.select().from(schema.storageUploadReservations)
      .where(and(eq(schema.storageUploadReservations.id,id),
        eq(schema.storageUploadReservations.ownerUserId,owner))).limit(1);
    if(!reservation)throw new Error('Unknown owner quota reservation');
    if(reservation.status==='committed'){
      if(!reservation.committedAssetId)throw new Error('Incomplete committed reservation');
      const [existing]=await tx.select().from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id,reservation.committedAssetId)).limit(1);
      if(!existing||existing.ownerScope!=='private-user'||existing.ownerUserId!==owner||
        existing.sha256!==blob.sha256||existing.storageKey!==blob.key||
        existing.sizeBytes!==blob.sizeBytes||existing.mime!==blob.mime){
        throw new Error('A committed reservation cannot be changed');
      }
      return {assetId:existing.id,status:'pending_verify' as const,alreadyCommitted:true};
    }
    if(reservation.status!=='reserved'||reservation.expiresAt.getTime()<=Date.now()){
      throw new Error('Expired or released upload quota reservation');
    }
    if(blob.sizeBytes>reservation.reservedBytes)throw new Error('Staged bytes exceed reservation');
    const [asset]=await tx.insert(schema.mediaAssets).values({
      ownerScope:'private-user',ownerUserId:owner,storageKey:blob.key,
      sha256:blob.sha256,sizeBytes:blob.sizeBytes,mime:blob.mime,
      durationMs:null,status:'pending_verify',
    }).returning();
    if(!asset)throw new Error('Private asset quarantine registration failed');
    await tx.update(schema.storageUploadReservations).set({
      status:'committed',committedAssetId:asset.id,
    }).where(eq(schema.storageUploadReservations.id,id));
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.asset.quarantined',entityType:'media_asset',entityId:asset.id,
      afterJson:{ownerScope:'private-user',sizeBytes:asset.sizeBytes,
        sha256:asset.sha256,status:asset.status,reservationId:id},
    });
    return {assetId:asset.id,status:'pending_verify' as const,alreadyCommitted:false};
  });
}

export async function releasePrivateUploadQuota(db:QuotaDb,trustedOwnerId:string,reservationId:string){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(reservationId);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [reservation]=await tx.select().from(schema.storageUploadReservations)
      .where(and(eq(schema.storageUploadReservations.id,id),
        eq(schema.storageUploadReservations.ownerUserId,owner))).limit(1);
    if(!reservation)throw new Error('Unknown owner quota reservation');
    if(reservation.status==='committed')throw new Error('Committed assets cannot be released as reservations');
    if(reservation.status==='released')return {released:false};
    await tx.update(schema.storageUploadReservations).set({status:'released'})
      .where(eq(schema.storageUploadReservations.id,id));
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quota.release',entityType:'storage_reservation',
      entityId:id,afterJson:{reservedBytes:reservation.reservedBytes,status:'released'},
    });
    return {released:true};
  });
}

/** Informational only. Admission must always call reservePrivateUploadQuota. */
export async function inspectPrivateUploadQuota(db:QuotaDb,trustedOwnerId:string,maxUserBytes:number){
  const owner=uuid.parse(trustedOwnerId),max=positiveBytes.parse(maxUserBytes);
  return db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const state=await usage(tx,owner,new Date());
    return {ownerUserId:owner,committedBytes:Number(state.committed),
      reservedBytes:Number(state.reserved),maxUserBytes:max};
  });
}


/**
 * INTERNAL orphan retention. One private owner at a time; dry-run by default.
 * Uses exactly the advisory transaction lock held by quota reservation and
 * quarantine commit, so no new eligible DB reference/reservation can race the
 * FS unlink. Any active reservation blocks the entire owner's cleanup.
 * Every media_assets status is protected, even rejected/deleted.
 *
 * This does NOT scan/publish files, purge referenced user books, or expose an
 * HTTP/cron endpoint. testNowMs is only for synthetic time-advance tests.
 */
export async function sweepPrivateQuarantineOrphans(
  db:QuotaDb,storage:LocalStorageAdapter,trustedOwnerId:string,
  options:{apply?:boolean;testNowMs?:number}={},
){
  const owner=uuid.parse(trustedOwnerId);
  const now=options.testNowMs??Date.now();
  if(!Number.isSafeInteger(now)||now<0)throw new Error('Invalid private orphan sweep clock');
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [active]=await tx.select({id:schema.storageUploadReservations.id})
      .from(schema.storageUploadReservations).where(and(
        eq(schema.storageUploadReservations.ownerUserId,owner),
        eq(schema.storageUploadReservations.status,'reserved'),
        gt(schema.storageUploadReservations.expiresAt,new Date(now)),
      )).limit(1);
    if(active){
      return {ownerScope:'private-user' as const,blockedByActiveReservation:true,
        scanned:0,referenced:0,eligible:0,removed:0,skipped:0,
        truncated:false,dryRun:options.apply!==true};
    }
    const references=await tx.select({storageKey:schema.mediaAssets.storageKey})
      .from(schema.mediaAssets).where(and(
        eq(schema.mediaAssets.ownerScope,'private-user'),
        eq(schema.mediaAssets.ownerUserId,owner),
      ));
    const result=await storage.sweepPrivateUserOrphans(
      owner,new Set(references.map(r=>r.storageKey)),options,
    );
    return {ownerScope:'private-user' as const,blockedByActiveReservation:false,...result};
  });
}


/**
 * INTERNAL owner-bound malware scan observation, never approval.
 * This is deliberately NOT an upload, playback or public HTTP route.
 * The trusted owner is supplied by the verified backend caller, NOT any
 * x-user-id header/query/body. Only the persisted private-user asset row
 * supplies owner, opaque key, digest, media type, byte count and state.
 *
 * Slow scanner process runs OUTSIDE a database transaction. After it exits,
 * reacquire the same per-owner advisory lock used for private quota/retention,
 * confirm metadata/status are identical, and atomically audit the generic
 * observation. A forged, withdrawn or concurrently changed asset fails closed.
 * Even a "clean" observation NEVER marks a file verified or publishes it.
 */
export async function observePrivateQuarantineMalware(
  db:QuotaDb,storage:LocalStorageAdapter,
  trustedOwnerId:string,trustedAssetId:string,scanner:QuarantineByteScanner,
){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(trustedAssetId);
  const [asset]=await db.select().from(schema.mediaAssets).where(and(
    eq(schema.mediaAssets.id,id),
    eq(schema.mediaAssets.ownerScope,'private-user'),
    eq(schema.mediaAssets.ownerUserId,owner),
    eq(schema.mediaAssets.status,'pending_verify'),
  )).limit(1);
  if(!asset)throw new Error('Quarantined private asset unavailable for trusted owner');

  const blob:QuarantinedBlob={
    scope:'private-user',ownerUserId:owner,key:asset.storageKey,
    status:'pending_verify',sha256:asset.sha256,sizeBytes:asset.sizeBytes,
    mime:asset.mime as CandidateMime,
  };
  const result=await storage.scanQuarantined(blob,scanner);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [current]=await tx.select().from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.id,id),
      eq(schema.mediaAssets.ownerScope,'private-user'),
      eq(schema.mediaAssets.ownerUserId,owner),
      eq(schema.mediaAssets.status,'pending_verify'),
    )).limit(1);
    if(!current||current.storageKey!==asset.storageKey||
      current.sha256!==asset.sha256||current.sizeBytes!==asset.sizeBytes||
      current.mime!==asset.mime||current.durationMs!==asset.durationMs||
      current.verifiedAt!==null){
      throw new Error('Private asset changed or was withdrawn during malware inspection');
    }
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quarantine.scan_observed',
      entityType:'media_asset',entityId:id,
      afterJson:{
        ownerScope:'private-user',
        verdict:result.verdict,
        status:'pending_verify',
        sha256:result.sha256,
        sizeBytes:result.sizeBytes,
      },
    });
    return {assetId:id,...result};
  });
}


/**
 * INTERNAL, conservative EPUB ZIP shape observation. Owner, opaque file key,
 * source digest/size/MIME MUST originate from a persisted private media row.
 * Successful ZIP-CRC/bounds checks DO NOT validate XHTML, EPUB spine reading
 * order, malware, DRM licenses, territory, or publication rights.
 *
 * Like AV observations, a slow bounded filesystem inspection occurs outside
 * DB transactions, then an owner advisory lock and exact status/metadata
 * replay recheck prevent auditing a withdrawn or replaced asset as current.
 * Only counts, never filenames/paths or source bytes, enter the audit record.
 */
export async function observePrivateQuarantineEpubStructure(
  db:QuotaDb,storage:LocalStorageAdapter,
  trustedOwnerId:string,trustedAssetId:string,
){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(trustedAssetId);
  const [asset]=await db.select().from(schema.mediaAssets).where(and(
    eq(schema.mediaAssets.id,id),
    eq(schema.mediaAssets.ownerScope,'private-user'),
    eq(schema.mediaAssets.ownerUserId,owner),
    eq(schema.mediaAssets.status,'pending_verify'),
    eq(schema.mediaAssets.mime,'application/epub+zip'),
  )).limit(1);
  if(!asset)throw new Error('Quarantined private EPUB unavailable for trusted owner');
  const record:QuarantinedBlob={
    scope:'private-user',ownerUserId:owner,key:asset.storageKey,
    sha256:asset.sha256,sizeBytes:asset.sizeBytes,
    mime:'application/epub+zip',status:'pending_verify',
  };
  const structure=await storage.inspectEpubStructure(record);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [current]=await tx.select().from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.id,id),
      eq(schema.mediaAssets.ownerScope,'private-user'),
      eq(schema.mediaAssets.ownerUserId,owner),
      eq(schema.mediaAssets.status,'pending_verify'),
      eq(schema.mediaAssets.mime,'application/epub+zip'),
    )).limit(1);
    if(!current||current.storageKey!==asset.storageKey||
      current.sha256!==asset.sha256||current.sizeBytes!==asset.sizeBytes||
      current.durationMs!==asset.durationMs||current.verifiedAt!==null){
      throw new Error('Private EPUB metadata changed or was withdrawn during structural preflight');
    }
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quarantine.epub_structure_observed',
      entityType:'media_asset',entityId:id,
      afterJson:{ownerScope:'private-user',status:'pending_verify',
        structuralStatus:structure.status,entryCount:structure.entryCount,
        expandedBytes:structure.expandedBytes,sha256:asset.sha256},
    });
    return {assetId:id,assetStatus:'pending_verify' as const,...structure};
  });
}


/**
 * INTERNAL package/spine relationship observation ONLY. Input is a trusted
 * principal and a persisted private quarantine media ID, never a user-supplied
 * path, content, MIME or digest. A successful relationship check cannot prove
 * XHTML safety, clean antivirus signatures, readable text, or legal rights.
 * Files always stay pending_verify and unpublished.
 */
export async function observePrivateQuarantineEpubPackageSpine(
  db:QuotaDb,storage:LocalStorageAdapter,
  trustedOwnerId:string,trustedAssetId:string,
){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(trustedAssetId);
  const [asset]=await db.select().from(schema.mediaAssets).where(and(
    eq(schema.mediaAssets.id,id),
    eq(schema.mediaAssets.ownerScope,'private-user'),
    eq(schema.mediaAssets.ownerUserId,owner),
    eq(schema.mediaAssets.status,'pending_verify'),
    eq(schema.mediaAssets.mime,'application/epub+zip'),
  )).limit(1);
  if(!asset)throw new Error('Quarantined private EPUB unavailable for trusted owner');
  const record:QuarantinedBlob={
    scope:'private-user',ownerUserId:owner,key:asset.storageKey,
    sha256:asset.sha256,sizeBytes:asset.sizeBytes,
    mime:'application/epub+zip',status:'pending_verify',
  };
  const relations=await storage.inspectEpubPackageSpine(record);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [current]=await tx.select().from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.id,id),
      eq(schema.mediaAssets.ownerScope,'private-user'),
      eq(schema.mediaAssets.ownerUserId,owner),
      eq(schema.mediaAssets.status,'pending_verify'),
      eq(schema.mediaAssets.mime,'application/epub+zip'),
    )).limit(1);
    if(!current||current.storageKey!==asset.storageKey||
      current.sha256!==asset.sha256||current.sizeBytes!==asset.sizeBytes||
      current.durationMs!==asset.durationMs||current.verifiedAt!==null){
      throw new Error('Private EPUB metadata changed or was withdrawn during package preflight');
    }
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quarantine.epub_package_observed',
      entityType:'media_asset',entityId:id,
      afterJson:{
        ownerScope:'private-user',assetStatus:'pending_verify',
        structuralStatus:relations.status,sha256:asset.sha256,
        manifestItems:relations.manifestItems,
        spineItems:relations.spineItems,
        linearSpineItems:relations.linearSpineItems,
        navigationCount:relations.navigationCount,
      },
    });
    return {assetId:id,assetStatus:'pending_verify' as const,...relations};
  });
}


/**
 * INTERNAL, untrusted XHTML active-markup *shape* observation.
 * A trusted principal and owner-bound persisted pending EPUB media row are
 * mandatory; no supplied path/row/hash/status may bypass the DB. Parse occurs
 * outside the transaction, then the owner advisory lock rechecks every
 * security-relevant persisted field before writing counts-only audit evidence.
 * This never blesses content, CSS, source reading order or publishing rights.
 */
export async function observePrivateQuarantineEpubXhtmlMarkup(
  db:QuotaDb,storage:LocalStorageAdapter,
  trustedOwnerId:string,trustedAssetId:string,
){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(trustedAssetId);
  const [asset]=await db.select().from(schema.mediaAssets).where(and(
    eq(schema.mediaAssets.id,id),
    eq(schema.mediaAssets.ownerScope,'private-user'),
    eq(schema.mediaAssets.ownerUserId,owner),
    eq(schema.mediaAssets.status,'pending_verify'),
    eq(schema.mediaAssets.mime,'application/epub+zip'),
  )).limit(1);
  if(!asset)throw new Error('Quarantined private EPUB unavailable for trusted owner');
  const record:QuarantinedBlob={
    scope:'private-user',ownerUserId:owner,key:asset.storageKey,
    sha256:asset.sha256,sizeBytes:asset.sizeBytes,
    mime:'application/epub+zip',status:'pending_verify',
  };
  const markup=await storage.inspectEpubXhtmlMarkup(record);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [current]=await tx.select().from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.id,id),
      eq(schema.mediaAssets.ownerScope,'private-user'),
      eq(schema.mediaAssets.ownerUserId,owner),
      eq(schema.mediaAssets.status,'pending_verify'),
      eq(schema.mediaAssets.mime,'application/epub+zip'),
    )).limit(1);
    if(!current||current.storageKey!==asset.storageKey||
      current.sha256!==asset.sha256||current.sizeBytes!==asset.sizeBytes||
      current.durationMs!==asset.durationMs||current.verifiedAt!==null){
      throw new Error('Private EPUB was withdrawn or changed during XHTML inspection');
    }
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quarantine.epub_xhtml_observed',
      entityType:'media_asset',entityId:id,
      afterJson:{
        ownerScope:'private-user',assetStatus:'pending_verify',
        inspectionStatus:markup.status,sha256:asset.sha256,
        documentCount:markup.documentCount,totalElements:markup.totalElements,
        navigationDocuments:markup.navigationDocuments,
        localLinks:markup.localLinks,fragmentLinks:markup.fragmentLinks,
      },
    });
    return {assetId:id,assetStatus:'pending_verify' as const,...markup};
  });
}

/**
 * INTERNAL private EPUB CSS-only observation, without playback or promotion.
 * Trusted owner plus a persisted private pending_verify media ID are mandatory.
 */
export async function observePrivateQuarantineEpubCssResources(
  db:QuotaDb,storage:LocalStorageAdapter,
  trustedOwnerId:string,trustedAssetId:string,
){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(trustedAssetId);
  const [asset]=await db.select().from(schema.mediaAssets).where(and(
    eq(schema.mediaAssets.id,id),
    eq(schema.mediaAssets.ownerScope,'private-user'),
    eq(schema.mediaAssets.ownerUserId,owner),
    eq(schema.mediaAssets.status,'pending_verify'),
    eq(schema.mediaAssets.mime,'application/epub+zip'),
  )).limit(1);
  if(!asset)throw new Error('Quarantined private EPUB unavailable for trusted owner');
  const record:QuarantinedBlob={
    scope:'private-user',ownerUserId:owner,key:asset.storageKey,
    sha256:asset.sha256,sizeBytes:asset.sizeBytes,
    mime:'application/epub+zip',status:'pending_verify',
  };
  const css=await storage.inspectEpubCssResources(record);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [current]=await tx.select().from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.id,id),
      eq(schema.mediaAssets.ownerScope,'private-user'),
      eq(schema.mediaAssets.ownerUserId,owner),
      eq(schema.mediaAssets.status,'pending_verify'),
      eq(schema.mediaAssets.mime,'application/epub+zip'),
    )).limit(1);
    if(!current||current.storageKey!==asset.storageKey||
      current.sha256!==asset.sha256||current.sizeBytes!==asset.sizeBytes||
      current.durationMs!==asset.durationMs||current.verifiedAt!==null){
      throw new Error('Private EPUB changed or withdrawn during CSS inspection');
    }
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quarantine.epub_css_observed',
      entityType:'media_asset',entityId:id,
      afterJson:{
        ownerScope:'private-user',assetStatus:'pending_verify',
        inspectionStatus:css.status,sha256:asset.sha256,
        stylesheetCount:css.stylesheetCount,
        stylesheetBytes:css.stylesheetBytes,
        ruleCount:css.ruleCount,
        declarationCount:css.declarationCount,
      },
    });
    return {assetId:id,assetStatus:'pending_verify' as const,...css};
  });
}

/**
 * Fifth independent private EPUB quarantine-only PNG structural observation.
 * Validates ALL remaining manifest resources, so unscanned fonts, JPEG, GIF,
 * WebP and legacy NCX cannot be silently treated as approved.
 */
export async function observePrivateQuarantineEpubPngResources(
  db:QuotaDb,storage:LocalStorageAdapter,
  trustedOwnerId:string,trustedAssetId:string,
){
  const owner=uuid.parse(trustedOwnerId),id=uuid.parse(trustedAssetId);
  const [asset]=await db.select().from(schema.mediaAssets).where(and(
    eq(schema.mediaAssets.id,id),
    eq(schema.mediaAssets.ownerScope,'private-user'),
    eq(schema.mediaAssets.ownerUserId,owner),
    eq(schema.mediaAssets.status,'pending_verify'),
    eq(schema.mediaAssets.mime,'application/epub+zip'),
  )).limit(1);
  if(!asset)throw new Error('Quarantined private EPUB unavailable for trusted owner');
  const record:QuarantinedBlob={
    scope:'private-user',ownerUserId:owner,key:asset.storageKey,
    sha256:asset.sha256,sizeBytes:asset.sizeBytes,
    mime:'application/epub+zip',status:'pending_verify',
  };
  const png=await storage.inspectEpubPngResources(record);
  return db.transaction(async tx=>{
    await tx.execute(lockOwner(owner));
    const [current]=await tx.select().from(schema.mediaAssets).where(and(
      eq(schema.mediaAssets.id,id),
      eq(schema.mediaAssets.ownerScope,'private-user'),
      eq(schema.mediaAssets.ownerUserId,owner),
      eq(schema.mediaAssets.status,'pending_verify'),
      eq(schema.mediaAssets.mime,'application/epub+zip'),
    )).limit(1);
    if(!current||current.storageKey!==asset.storageKey||
      current.sha256!==asset.sha256||current.sizeBytes!==asset.sizeBytes||
      current.durationMs!==asset.durationMs||current.verifiedAt!==null){
      throw new Error('Private EPUB changed or withdrawn during PNG inspection');
    }
    await tx.insert(schema.auditEvents).values({
      actorId:owner,action:'storage.quarantine.epub_png_observed',
      entityType:'media_asset',entityId:id,
      afterJson:{
        ownerScope:'private-user',assetStatus:'pending_verify',
        inspectionStatus:png.status,sha256:asset.sha256,
        imageCount:png.imageCount,imageBytes:png.imageBytes,
        totalPixels:png.totalPixels,
      },
    });
    return {assetId:id,assetStatus:'pending_verify' as const,...png};
  });
}
