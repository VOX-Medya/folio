import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {and,eq} from 'drizzle-orm';
import {
  createFolioDb, createFolioBoss, initializeFolioQueues, folioQueueNames, folioDeadLetter,
  folioJobPolicy, folioDeadLetterPolicy, executeFolioJobOnce, schema,
} from '../src/index.js';

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

async function until(predicate: () => Promise<boolean>, label: string, timeoutMs=30000): Promise<void> {
  const deadline=Date.now()+timeoutMs;
  do {
    if(await predicate()) return;
    await sleep(500);
  } while(Date.now()<deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const database = url ? new URL(url) : undefined;
  const allowedPort = process.env.FOLIO_DB_PORT || '55432';
  if (!database || database.pathname !== '/folio_test' || !['127.0.0.1','localhost'].includes(database.hostname) || database.port !== allowedPort) {
    throw new Error('Folio job smoke requires the local loopback folio_test DB on the dedicated Folio port');
  }
  const {db,pool}=createFolioDb(url);
  const boss=createFolioBoss(url);
  boss.on('error',(err:Error)=>console.error('Isolated pg-boss worker error:',err.message));
  await boss.start();
  const marker=randomUUID().replaceAll('-','');
  try {
    await initializeFolioQueues(boss);
    await initializeFolioQueues(boss); // a restart/second provisioning must preserve policy
    for(const queueName of folioQueueNames){
      const queue=await boss.getQueue(queueName);
      assert(queue?.deadLetter===folioDeadLetter(queueName),`${queueName} missing dead-letter`);
      assert(queue.retryLimit===folioJobPolicy.retryLimit,`${queueName} missing bounded retries`);
      assert(queue.retryBackoff===true && queue.retryDelayMax===folioJobPolicy.retryDelayMax,`${queueName} missing backoff cap`);
      assert(queue.expireInSeconds===folioJobPolicy.expireInSeconds,`${queueName} missing job timeout`);
      const dead=await boss.getQueue(folioDeadLetter(queueName));
      assert(dead?.retryLimit===folioDeadLetterPolicy.retryLimit,`${queueName} dead-letter should not retry`);
    }
    console.log('All four V1 queue policies reconciled twice: retry, backoff, expiration, retention, dead-letter.');

    const key=`synthetic-${marker}`;
    const contentHash=createHash('sha256').update(`source:${marker}`).digest('hex');
    const jobA=randomUUID(),jobB=randomUUID();
    let sideEffectCount=0;
    const job=(jobId:string)=>({queueName:folioQueueNames[0]!,operationKey:key,jobId,payloadSha256:contentHash});
    const execute=(jobId:string)=>executeFolioJobOnce(db,job(jobId),async tx=>{
      sideEffectCount++;
      await tx.insert(schema.auditEvents).values({action:'folio_test.synthetic_side_effect',entityType:'job',entityId:jobId,reason:key});
    });
    const outcomes=await Promise.all([execute(jobA),execute(jobB)]);
    assert(outcomes.filter(x=>x==='processed').length===1,'Concurrent work did not serialize idempotency');
    assert(outcomes.filter(x=>x==='already-completed').length===1,'Duplicate work was not skipped');
    assert(sideEffectCount===1,'Concurrent DB operation executed more than once');
    const [receipt]=await db.select().from(schema.jobCompletionReceipts).where(and(
      eq(schema.jobCompletionReceipts.queueName,folioQueueNames[0]!),
      eq(schema.jobCompletionReceipts.operationKey,key),
    ));
    assert(receipt?.payloadSha256===contentHash,'Durable completion receipt missing');
    assert(await execute(randomUUID())==='already-completed','Replayed job should not execute after receipt commit');
    let mismatched=false;
    try {await executeFolioJobOnce(db,{...job(randomUUID()),payloadSha256:'f'.repeat(64)},async()=>{});}catch{mismatched=true;}
    assert(mismatched,'Same operation key with different payload was accepted');

    const rollbackKey=`failed-${marker}`;
    const rollbackIdentity={...job(randomUUID()),operationKey:rollbackKey};
    let failureCaught=false;
    try {
      await executeFolioJobOnce(db,rollbackIdentity,async tx=>{
        await tx.insert(schema.auditEvents).values({action:'folio_test.rolled_back',entityType:'job',reason:rollbackKey});
        throw new Error('synthetic transactional failure');
      });
    }catch{failureCaught=true;}
    assert(failureCaught,'Failed handler did not propagate error');
    const rolledBack=await db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.action,'folio_test.rolled_back'),eq(schema.auditEvents.reason,rollbackKey),
    ));
    assert(rolledBack.length===0,'Transactional DB side effect was not rolled back');
    const [notCompleted]=await db.select().from(schema.jobCompletionReceipts).where(eq(schema.jobCompletionReceipts.operationKey,rollbackKey));
    assert(!notCompleted,'Failure incorrectly committed completion receipt');
    const failureAudit=await db.select().from(schema.auditEvents).where(and(
      eq(schema.auditEvents.action,'job.attempt.failed'),eq(schema.auditEvents.entityId,rollbackIdentity.jobId),
    ));
    assert(failureAudit.length===1,'Failure audit was not persisted');
    assert(await executeFolioJobOnce(db,rollbackIdentity,async()=>{})==='processed','Failed logical operation could not be retried');
    console.log('Atomic DB idempotency verified under concurrent replay, same-key corruption, rollback, audit and retry.');

    const failingQueue=`folio.lab.fail.${marker}`;
    const deadQueue=`${failingQueue}.dead`;
    await boss.createQueue(deadQueue,{retryLimit:0,expireInSeconds:3,deleteAfterSeconds:86400});
    await boss.createQueue(failingQueue,{
      retryLimit:1,retryDelay:1,retryBackoff:false,expireInSeconds:3,
      deleteAfterSeconds:86400,deadLetter:deadQueue,
    });
    const failedJobId=await boss.send(failingQueue,{marker});
    assert(failedJobId,'Cannot queue failure fixture');
    let attempts=0;
    await boss.work(failingQueue,{pollingIntervalSeconds:0.5},async jobs=>{
      if(jobs[0]?.id===failedJobId){attempts++;throw new Error('synthetic job failure');}
    });
    let deadLetterJob: Awaited<ReturnType<typeof boss.fetch<{marker:string}>>>[number] | undefined;
    await until(async()=>{
      const [candidate]=await boss.fetch<{marker:string}>(deadQueue,{includeMetadata:true});
      if(candidate) deadLetterJob=candidate;
      return !!candidate;
    },'terminal job in dead-letter queue');
    assert(attempts===2,`Expected initial + one retry, got ${attempts}`);
    const failed=deadLetterJob;
    assert(failed?.sourceId===failedJobId,'Dead-letter does not reference original job');
    assert(failed.sourceRetryCount===1,'Dead-letter retry count mismatch');
    assert(failed.data.marker===marker,'Dead-letter payload was lost');
    await boss.complete(deadQueue,failed.id);
    await boss.offWork(failingQueue);
    console.log('Real pg-boss worker threw twice, then a durable dead-letter retained original ID, payload and retry count.');

    const expiringQueue=`folio.lab.timeout.${marker}`;
    const expiryDead=`${expiringQueue}.dead`;
    await boss.createQueue(expiryDead,{retryLimit:0,expireInSeconds:3});
    await boss.createQueue(expiringQueue,{retryLimit:0,expireInSeconds:1,deadLetter:expiryDead});
    const timeoutJobId=await boss.send(expiringQueue,{marker});
    assert(timeoutJobId,'Cannot queue expiry fixture');
    const [leased]=await boss.fetch(expiringQueue,{includeMetadata:true});
    assert(leased?.id===timeoutJobId,'Timeout fixture was not claimed');
    await sleep(1250);
    let expiredJob: Awaited<ReturnType<typeof boss.fetch<{marker:string}>>>[number] | undefined;
    await until(async()=>{
      await boss.supervise();
      const [candidate]=await boss.fetch<{marker:string}>(expiryDead,{includeMetadata:true});
      if(candidate) expiredJob=candidate;
      return !!candidate;
    },'expired lease to dead-letter',20000);
    const expired=expiredJob;
    assert(expired?.sourceId===timeoutJobId,'Expired job was not dead-lettered with source linkage');
    await boss.complete(expiryDead,expired.id);
    console.log('Job lease expiration and supervisor recovery into dead-letter verified.');
  } finally {
    await boss.stop();
    await pool.end();
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
