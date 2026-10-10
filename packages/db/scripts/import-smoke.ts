import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {and,eq,sql} from 'drizzle-orm';
import {createFolioDb,previewPreparedCatalogImport,stagePreparedCatalogImport,
  resumeStagedCatalogMetadata,getStagedCatalogImportStatus,schema} from '../src/index.js';
import type {PreparedImport} from '../src/index.js';

function ensure(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

function generatedPackage(n:number,label:string):PreparedImport{
  const packageId=randomUUID();
  const authors=[] as PreparedImport['records']['authors'];
  const works=[] as PreparedImport['records']['works'];
  const editions=[] as PreparedImport['records']['editions'];
  const revisions=[] as PreparedImport['records']['revisions'];
  const rightsRecords=[] as PreparedImport['records']['rightsRecords'];
  for(let i=0;i<n;i++){
    const authorId=randomUUID(),workId=randomUUID(),editionId=randomUUID(),revisionId=randomUUID();
    authors.push({id:authorId,canonical_name:`${label} Synthetic Author ${i}`});
    works.push({id:workId,original_title:`${label} Synthetic Work ${i}`,original_language:i%2?'en':'tr',authors:[authorId]});
    editions.push({id:editionId,work_id:workId,language:i%2?'en':'tr',label:'Prepared edition'});
    revisions.push({id:revisionId,edition_id:editionId,language:i%2?'en':'tr',source_sha256:sha(`source text fixture ${packageId} ${i}`)});
    rightsRecords.push({work_id:workId,edition_id:editionId,revision_id:revisionId,
      evidence:'Synthetic evidence needs manual territory and usage review; do not publish.'});
  }
  return {packageId,manifestChecksum:sha(`${packageId}:${label}:${n}`),schemaVersion:'1.0.0',
    records:{authors,works,editions,revisions,rightsRecords}};
}

async function main(){
  const url=process.env.DATABASE_URL;
  if(!url)throw new Error('Explicit isolated Folio database URL required');
  const target=new URL(url);
  if(target.pathname!=='/folio_test'||!['localhost','127.0.0.1'].includes(target.hostname)||target.port!==(process.env.FOLIO_DB_PORT||'55432')){
    throw new Error('Import smoke may only modify localhost Folio folio_test');
  }
  const {db,pool}=createFolioDb(url),actor=randomUUID();
  try{
    const packageData=generatedPackage(30,randomUUID());
    const count=async(table:typeof schema.authors|typeof schema.works|typeof schema.editions|typeof schema.importBatches|typeof schema.importItems|typeof schema.auditEvents)=>{
      const [row]=await db.select({count:sql<number>`count(*)::integer`}).from(table);
      return row?.count??0;
    };
    const before=await Promise.all([count(schema.authors),count(schema.works),count(schema.editions),
      count(schema.importBatches),count(schema.importItems),count(schema.auditEvents)]);
    const preview=await previewPreparedCatalogImport(db,packageData);
    ensure(preview.totals.create===90&&preview.totals.deferred===60&&preview.totals.conflict===0,'30-work preview counts wrong');
    const afterDryRun=await Promise.all([count(schema.authors),count(schema.works),count(schema.editions),
      count(schema.importBatches),count(schema.importItems),count(schema.auditEvents)]);
    ensure(JSON.stringify(before)===JSON.stringify(afterDryRun),'Dry-run wrote database records');
    ensure(preview.canStage,'Expected synthetic package to be stageable');
    console.log('30 original prepared works: read-only dry-run planned 90 create/60 deferred with zero DB/audit changes.');
    // Both prepared DIRECTORY and tar.zst use the same read-only DB planner via CLI.
    const {fixture}=await import('../../../tools/folioctl/src/fixtures.mjs');
    const {root:fixtureRoot}=fixture();
    const fixtureArchive=join(mkdtempSync(join(tmpdir(),'folio-preview-')),`${randomUUID()}.tar.zst`);
    const cli=fileURLToPath(new URL('../../../tools/folioctl/bin/folioctl.mjs',import.meta.url));
    try{
      const cliDir=JSON.parse(execFileSync(process.execPath,[cli,'import',fixtureRoot,'--dry-run'],
        {encoding:'utf8',env:{...process.env,DATABASE_URL:url}}));
      ensure(cliDir.readOnly===true&&cliDir.noPublicWrites===true,'CLI directory dry-run did not honor read-only semantics');
      execFileSync(process.execPath,[cli,'pack','build','--input',fixtureRoot,'--out',fixtureArchive],{encoding:'utf8'});
      const cliArchive=JSON.parse(execFileSync(process.execPath,[cli,'import',fixtureArchive,'--dry-run'],
        {encoding:'utf8',env:{...process.env,DATABASE_URL:url}}));
      ensure(JSON.stringify(cliArchive.totals)===JSON.stringify(cliDir.totals),'CLI folder/archive DB previews differed');
      const cliPost=await Promise.all([count(schema.importBatches),count(schema.importItems),count(schema.auditEvents)]);
      ensure(JSON.stringify(cliPost)===JSON.stringify(afterDryRun.slice(3)),'CLI preview wrote batch or audit records');
    }finally{rmSync(fixtureRoot,{recursive:true,force:true});rmSync(join(fixtureArchive,'..'),{recursive:true,force:true});}
    console.log('CLI directory/tar.zst dry-run parity PASS; no DB batch/item/audit mutations.');

    const stage=await stagePreparedCatalogImport(db,actor,packageData);
    ensure(!stage.alreadyStaged&&stage.itemCount===150,'Initial stage failed');
    ensure((await count(schema.works))===before[1],'Staging mutated canonical works');
    const stagedAgain=await stagePreparedCatalogImport(db,actor,packageData);
    ensure(stagedAgain.alreadyStaged&&stagedAgain.batchId===stage.batchId,'Staging replay created a duplicate');
    let unexpectedChecksumAccepted=false;
    try{await stagePreparedCatalogImport(db,actor,{...packageData,manifestChecksum:'f'.repeat(64)});}catch{unexpectedChecksumAccepted=true;}
    ensure(unexpectedChecksumAccepted,'Same package UUID accepted a different checksum');
    const first=await resumeStagedCatalogMetadata(db,actor,stage.batchId,37);
    ensure(first.status==='paused'&&first.pending===53&&first.processedThisRun===37,'Import checkpoint incorrect');
    const middle=await getStagedCatalogImportStatus(db,stage.batchId);
    ensure(middle?.counts['author:applied']===30&&middle.counts['work:applied']===7,'First resumed checkpoint did not persist');

    // Simulate worker restart: a DIFFERENT PostgreSQL pool resumes from persisted items alone.
    const replacement=createFolioDb(url);
    let finished;
    try {finished=await resumeStagedCatalogMetadata(replacement.db,actor,stage.batchId);}
    finally {await replacement.pool.end();}
    ensure(finished.status==='metadata_applied'&&finished.pending===0&&finished.processedThisRun===53,'Resume failed after restart');
    ensure(finished.deferredContent===30&&finished.deferredRights===30,'Unsafe content or rights automatic apply');
    const after=await getStagedCatalogImportStatus(db,stage.batchId);
    ensure(after?.counts['author:applied']===30&&after.counts['work:applied']===30&&after.counts['edition:applied']===30,
      'Resumed draft metadata count incorrect');
    ensure(after.counts['revision:deferred_asset']===30&&after.counts['rights:deferred_review']===30,
      'Revision/rights processing escaped staged boundary');
    ensure((await count(schema.authors))-(before[0]??0)===30,'Duplicate author insertion');
    ensure((await count(schema.works))-(before[1]??0)===30,'Duplicate work insertion');
    ensure((await count(schema.editions))-(before[2]??0)===30,'Duplicate edition insertion');
    const reResume=await resumeStagedCatalogMetadata(db,actor,stage.batchId);
    ensure(reResume.processedThisRun===0,'Repeated apply re-executed items');
    const now=await previewPreparedCatalogImport(db,packageData);
    ensure(now.totals.noop===90&&now.totals.deferred===60,'Repeated package did not preview as no-op');
    const workIds=packageData.records.works.map(work=>work.id);
    const createdWorks=await db.select().from(schema.works);
    ensure(createdWorks.filter(w=>workIds.includes(w.id)).every(w=>w.publicationStatus==='draft'),'Import published work without rights');
    const textRevisions=await db.select().from(schema.contentRevisions);
    ensure(!textRevisions.some(revision=>packageData.records.revisions.some(r=>r.id===revision.id)),'Unverified prepared revision written to DB');
    console.log('Durable stage/checkpoints PASS: 30 drafts, 37 then 53 after process restart, no duplicates, 60 source/right entries deferred.');

    // Existing published synthetic fixture cannot be silently mutated by another package.
    const existing=packageData.records.works[0]!;
    const original=await db.select().from(schema.works).where(eq(schema.works.id,existing.id));
    await db.update(schema.works).set({publicationStatus:'published'}).where(eq(schema.works.id,existing.id));
    const attacker=generatedPackage(1,randomUUID());
    attacker.records.works[0]={...attacker.records.works[0]!,id:existing.id,original_title:'Unauthorized new title'};
    attacker.records.editions[0]={...attacker.records.editions[0]!,work_id:existing.id};
    attacker.records.rightsRecords[0]={...attacker.records.rightsRecords[0]!,work_id:existing.id};
    const conflict=await previewPreparedCatalogImport(db,attacker);
    ensure(conflict.totals.conflict>=1&&!conflict.canStage,'Published work collision not blocked');
    let declined=false;
    try{await stagePreparedCatalogImport(db,actor,attacker);}catch{declined=true;}
    ensure(declined,'Conflict package staged despite published work clash');
    const [unchanged]=await db.select().from(schema.works).where(eq(schema.works.id,existing.id));
    ensure(unchanged?.originalTitle===original[0]?.originalTitle&&unchanged?.publicationStatus==='published',
      'Published source identity/status changed after rejected batch');
    console.log('Published synthetic work unchanged after attempted conflicting import; no silent merges or rights bypass.');

    const poison=generatedPackage(1,randomUUID());
    const another=await stagePreparedCatalogImport(db,actor,poison);
    const [firstStaged]=await db.select().from(schema.importItems).where(and(
      eq(schema.importItems.batchId,another.batchId),eq(schema.importItems.status,'staged'),
      eq(schema.importItems.kind,'author'))).limit(1);
    ensure(firstStaged,'Missing staged test record');
    await db.update(schema.importItems).set({payload:{modified:true}}).where(eq(schema.importItems.id,firstStaged.id));
    let tamperDenied=false;
    try{await resumeStagedCatalogMetadata(db,actor,another.batchId);}catch{tamperDenied=true;}
    ensure(tamperDenied,'Tampered durable staging payload was applied');
    console.log('Tampered staged payload SHA rejected. This remains a synthetic, isolated Folio test database.');

    // Two live PostgreSQL pools must not double-count, double-audit or regress
    // a fully applied batch back to paused. No real account or book data used.
    const concurrentPack=generatedPackage(4,randomUUID());
    const concurrentStage=await stagePreparedCatalogImport(db,actor,concurrentPack);
    const auditBefore=await count(schema.auditEvents);
    const secondPool=createFolioDb(url);
    try{
      const [left,right]=await Promise.all([
        resumeStagedCatalogMetadata(db,actor,concurrentStage.batchId,12),
        resumeStagedCatalogMetadata(secondPool.db,actor,concurrentStage.batchId,12),
      ]);
      ensure(left.processedThisRun+right.processedThisRun===12,
        'Two workers counted an already-processed item twice');
      const state=await getStagedCatalogImportStatus(db,concurrentStage.batchId);
      ensure(state?.status==='metadata_applied','Concurrent finalization regressed batch status');
      ensure(state.counts['author:applied']===4&&state.counts['work:applied']===4&&
        state.counts['edition:applied']===4&&state.counts['revision:deferred_asset']===4&&
        state.counts['rights:deferred_review']===4,'Concurrent resume skipped or exposed a record');
      ensure((await count(schema.auditEvents))-auditBefore===12,
        'Concurrent resume wrote duplicated or missing item audit events');
      const replay=await resumeStagedCatalogMetadata(secondPool.db,actor,concurrentStage.batchId);
      ensure(replay.processedThisRun===0&&replay.status==='metadata_applied',
        'Repeated concurrent stage changed completed metadata state');
      console.log('Two concurrent PostgreSQL import workers: 12 unique checkpoints, 12 audit events, final status stable.');
    }finally{await secondPool.pool.end();}

    // An unrelated canonical work can have a completely different title but
    // the EXACT same source artifact digest. That is review evidence, not
    // permission to deduplicate titles/editions or republish protected text.
    const donorAuthorId=randomUUID(),donorWorkId=randomUUID();
    const donorEditionId=randomUUID(),donorProvenanceId=randomUUID();
    const donorDigest=sha('synthetic-existing-source:'+randomUUID());
    await db.insert(schema.authors).values({
      id:donorAuthorId,canonicalName:'Synthetic SHA-256 donor '+donorAuthorId,
      sortName:'SHA-256 donor',
    });
    await db.insert(schema.works).values({
      id:donorWorkId,originalTitle:'Unrelated Synthetic Donor '+donorWorkId,
      originalLanguage:'en',publicationStatus:'draft',
    });
    await db.insert(schema.workAuthors).values({
      workId:donorWorkId,authorId:donorAuthorId,
      contribution:'author',sortOrder:0,
    });
    await db.insert(schema.editions).values({
      id:donorEditionId,workId:donorWorkId,language:'en',
      label:'Synthetic comparison source',status:'draft',
    });
    await db.insert(schema.sourceProvenance).values({
      id:donorProvenanceId,sourceName:'folio_test_only_manual',
    });
    await db.insert(schema.contentRevisions).values({
      id:randomUUID(),editionId:donorEditionId,language:'en',
      rawArtifactKey:'synthetic-content-not-created',
      rawSha256:donorDigest,normalizedSha256:donorDigest,
      parserVersion:'synthetic-only-1',provenanceId:donorProvenanceId,
      createdBy:actor,status:'draft',
    });
    const hashCollision=generatedPackage(1,randomUUID());
    hashCollision.records.revisions[0]={
      ...hashCollision.records.revisions[0]!,source_sha256:donorDigest,
    };
    const beforeCollision=await Promise.all([
      count(schema.authors),count(schema.works),count(schema.editions),
      count(schema.importBatches),count(schema.importItems),count(schema.auditEvents),
    ]);
    const review=await previewPreparedCatalogImport(db,hashCollision);
    const plannedWork=review.items.find(item=>
      item.kind==='work'&&item.externalId===hashCollision.records.works[0]?.id);
    const plannedRevision=review.items.find(item=>
      item.kind==='revision'&&item.externalId===hashCollision.records.revisions[0]?.id);
    ensure(review.canStage===false&&review.totals.conflict>=1&&
      plannedWork?.action==='conflict'&&
      plannedWork.reason==='possible_source_sha256_match_requires_human_review'&&
      plannedWork.candidateWorkIds?.includes(donorWorkId)&&
      plannedRevision?.candidateWorkIds?.includes(donorWorkId),
      'An exact source digest under another work silently bypassed human review');
    ensure(plannedWork.candidateWorkIds?.every(id=>id!==hashCollision.records.works[0]?.id),
      'Reviewer suggestion included the work itself');
    ensure(JSON.stringify(beforeCollision)===JSON.stringify(await Promise.all([
      count(schema.authors),count(schema.works),count(schema.editions),
      count(schema.importBatches),count(schema.importItems),count(schema.auditEvents),
    ])),'Hash-backed dry-run wrote canonical, stage or audit records');
    let denied=false;
    try{await stagePreparedCatalogImport(db,actor,hashCollision);}
    catch{denied=true;}
    ensure(denied,'Source hash conflict was staged without a human identity review');
    console.log('Different-title identical-SHA source: human-review candidates only; no dry-run/staging writes.');
    // The same digest across TWO new works in a single import is another
    // review conflict, even without any matching canonical source in DB.
    const inBatch=generatedPackage(2,randomUUID());
    const sharedSha=inBatch.records.revisions[0]!.source_sha256;
    inBatch.records.revisions[1]={
      ...inBatch.records.revisions[1]!,source_sha256:sharedSha,
    };
    const duplicateBatch=await previewPreparedCatalogImport(db,inBatch);
    const packageWorkIds=inBatch.records.works.map(item=>item.id);
    const plannedBatchWorks=duplicateBatch.items.filter(item=>item.kind==='work');
    ensure(!duplicateBatch.canStage&&plannedBatchWorks.length===2&&
      plannedBatchWorks.every(item=>item.action==='conflict'&&
        item.reason==='possible_source_sha256_match_requires_human_review'&&
        item.candidateWorkIds?.includes(packageWorkIds.find(id=>id!==item.externalId)??'')),
      'Identical in-package source content was silently treated as distinct works');
    let sameSourceBatchAccepted=false;
    try{await stagePreparedCatalogImport(db,actor,inBatch);sameSourceBatchAccepted=true;}
    catch{/* expected: a reviewer must resolve this ambiguous package */}
    ensure(!sameSourceBatchAccepted,
      'Duplicate source bytes across independent package works were staged');
    console.log('Two package works with identical source SHA: both require explicit human review.');


    // TOCTOU: metadata staged while no duplicate exists, then a different
    // canonical source revision arrives before apply. Work apply must recheck
    // the hash under the item transaction, not trust stale dry-run approval.
    const stageRace=generatedPackage(1,randomUUID());
    ensure((await previewPreparedCatalogImport(db,stageRace)).canStage,
      'Fresh independent staged package unexpectedly collided');
    const raceBatch=await stagePreparedCatalogImport(db,actor,stageRace);
    const raceWork=stageRace.records.works[0]!;
    const raceSha=stageRace.records.revisions[0]!.source_sha256;
    await db.insert(schema.contentRevisions).values({
      id:randomUUID(),editionId:donorEditionId,language:'en',
      rawArtifactKey:'synthetic-late-import-not-created',
      rawSha256:raceSha,normalizedSha256:raceSha,
      parserVersion:'synthetic-only-1',provenanceId:donorProvenanceId,
      createdBy:actor,status:'draft',
    });
    let raceBlocked=false;
    try{await resumeStagedCatalogMetadata(db,actor,raceBatch.batchId);}
    catch(error){
      raceBlocked=error instanceof Error&&error.message.includes('human identity review');
    }
    ensure(raceBlocked,'Work staged before source SHA collision was applied silently');
    const newRaceWork=await db.select().from(schema.works)
      .where(eq(schema.works.id,raceWork.id));
    ensure(newRaceWork.length===0,'Late SHA collision still created a duplicate canonical work');
    const raceState=await getStagedCatalogImportStatus(db,raceBatch.batchId);
    ensure(raceState?.counts['work:staged']===1&&
      raceState.counts['author:staged']===1,
      'Late SHA collision advanced a work or its author dependency before review');
    console.log('Post-staging source SHA race denied before work creation; review remains required.');
  }finally{await pool.end();}
}
void main().catch(err=>{console.error(err);process.exitCode=1;});
