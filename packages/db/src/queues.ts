import { PgBoss } from 'pg-boss';

/** Queues are provisioned for V1 processors, with no mock processors or future AI providers. */
export const folioQueues = {
  importValidate: 'folio.import.validate',
  bookParse: 'folio.book.parse',
  coverRender: 'folio.cover.render',
  mediaValidate: 'folio.media.validate',
} as const;

export function createFolioBoss(url: string): PgBoss {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('Database URL must be explicit');
  return new PgBoss({connectionString: url, schema: 'folio_boss'});
}
export async function initializeFolioQueues(boss: PgBoss): Promise<void> {
  for (const name of Object.values(folioQueues)) await boss.createQueue(name);
}
