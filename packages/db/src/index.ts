import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
export { schema };
/** This module connects only to explicitly provided Folio DB URLs. */
export function createFolioDb(url: string) {
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('An explicit PostgreSQL database URL is required');
  const pool = new Pool({connectionString: url, max: 5, application_name: 'folio_lab'});
  return {pool, db: drizzle(pool, {schema})};
}

export {createFolioBoss, initializeFolioQueues, folioQueues} from './queues.js';
export {createCanonicalAuthor, createCanonicalWork, getCanonicalWorkDetails} from './catalog.js';
export {createContentRevision, getRevisionBlocks, sha256Text} from './content.js';
export {submitRightsEvidence,reviewRightsEvidence,verifyRightsForAction} from './rights.js';
export {createPreparedTranslationLink,verifyPreparedTranslationEdges,resolveTranslationSwitch} from './translation.js';
export {registerPreparedAudioAsset,registerPreparedAudioVariant,replacePreparedAudioSegment,getPreparedAudioVariant} from './audio.js';
