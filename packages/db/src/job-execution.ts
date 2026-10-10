import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { createFolioDb } from './index.js';
import { auditEvents, jobCompletionReceipts } from './schema.js';
import {isFolioQueueName} from './queues.js';
import type {FolioQueueName} from './queues.js';

type FolioDb = ReturnType<typeof createFolioDb>['db'];
export type FolioJobTx = Parameters<Parameters<FolioDb['transaction']>[0]>[0];
export type FolioJobIdentity = {
  queueName: FolioQueueName;
  operationKey: string;
  jobId: string;
  payloadSha256: string;
};
const identitySchema = z.object({
  queueName: z.string().refine(isFolioQueueName, 'Unknown V1 queue'),
  operationKey: z.string().trim().min(1).max(200),
  jobId: z.uuid(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/**
 * Handler-side idempotency for DB-only side effects. The callback MUST use tx,
 * not an external connection or a file/network side effect. Receipt, business
 * writes, and success audit share one transaction. On failure all roll back,
 * allowing pg-boss retry; a separate bounded failure audit is written.
 */
export async function executeFolioJobOnce(
  db: FolioDb, rawIdentity: FolioJobIdentity, run: (tx: FolioJobTx) => Promise<void>,
): Promise<'processed' | 'already-completed'> {
  const identity = identitySchema.parse(rawIdentity);
  try {
    return await db.transaction(async tx => {
      const [created] = await tx.insert(jobCompletionReceipts).values({
        queueName: identity.queueName,
        operationKey: identity.operationKey,
        payloadSha256: identity.payloadSha256,
        firstJobId: identity.jobId,
      }).onConflictDoNothing().returning();
      if (!created) {
        const [prior] = await tx.select().from(jobCompletionReceipts).where(and(
          eq(jobCompletionReceipts.queueName, identity.queueName),
          eq(jobCompletionReceipts.operationKey, identity.operationKey),
        ));
        if (!prior || prior.payloadSha256 !== identity.payloadSha256) {
          throw new Error('Idempotency key reused with a different payload');
        }
        return 'already-completed';
      }
      await run(tx);
      await tx.insert(auditEvents).values({
        action: 'job.completed', entityType: 'job', entityId: identity.jobId,
        afterJson: {queueName: identity.queueName, operationKey: identity.operationKey,
          payloadSha256: identity.payloadSha256},
      });
      return 'processed';
    });
  } catch (error) {
    // Do not record raw job payload, stack traces, or source content in audit.
    await db.insert(auditEvents).values({
      action: 'job.attempt.failed', entityType: 'job', entityId: identity.jobId,
      afterJson: {queueName: identity.queueName, operationKey: identity.operationKey,
        failureCode: 'JOB_ATTEMPT_FAILED'},
    });
    throw error;
  }
}
