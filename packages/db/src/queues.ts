import { PgBoss } from 'pg-boss';
import type {QueueOptions} from 'pg-boss';

/** Only the four manually fed V1 pipelines; no AI or external provider queues. */
export const folioQueues = {
  importValidate: 'folio.import.validate',
  bookParse: 'folio.book.parse',
  coverRender: 'folio.cover.render',
  mediaValidate: 'folio.media.validate',
} as const;
export type FolioQueueName = typeof folioQueues[keyof typeof folioQueues];
export const folioQueueNames: readonly FolioQueueName[] = Object.values(folioQueues);
export const folioDeadLetter = (name: FolioQueueName): string => `${name}.dead`;

/** One bounded policy for V1 workers, excluding accidental unbounded retries. */
export const folioJobPolicy = {
  retryLimit: 3,
  retryDelay: 2,
  retryBackoff: true,
  retryDelayMax: 60,
  expireInSeconds: 120,
  retentionSeconds: 14 * 86400,
  deleteAfterSeconds: 7 * 86400,
} as const satisfies QueueOptions;

export const folioDeadLetterPolicy = {
  retryLimit: 0,
  expireInSeconds: 120,
  retentionSeconds: 14 * 86400,
  deleteAfterSeconds: 14 * 86400,
} as const satisfies QueueOptions;

export function isFolioQueueName(name: string): name is FolioQueueName {
  return (folioQueueNames as readonly string[]).includes(name);
}

export function createFolioBoss(url: string): PgBoss {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('Database URL must be explicit');
  return new PgBoss({connectionString: url, schema: 'folio_boss'});
}

/**
 * Reconcile old queues created before policies existed. Dead-letter queues must
 * exist first. No worker is registered until feature-specific handlers exist.
 */
export async function initializeFolioQueues(boss: PgBoss): Promise<void> {
  for (const name of folioQueueNames) {
    const dead = folioDeadLetter(name);
    await boss.createQueue(dead, folioDeadLetterPolicy);
    await boss.updateQueue(dead, folioDeadLetterPolicy);
  }
  for (const name of folioQueueNames) {
    const options = {...folioJobPolicy, deadLetter: folioDeadLetter(name)};
    await boss.createQueue(name, options);
    await boss.updateQueue(name, options);
  }
}
