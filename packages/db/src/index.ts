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

export {createFolioBoss, initializeFolioQueues, folioQueues, folioQueueNames, folioDeadLetter, folioJobPolicy, folioDeadLetterPolicy} from './queues.js';
export {executeFolioJobOnce} from './job-execution.js';
export type {FolioJobIdentity, FolioJobTx} from './job-execution.js';
export {createCanonicalAuthor, createCanonicalWork, getCanonicalWorkDetails} from './catalog.js';
export {createContentRevision, getRevisionBlocks, sha256Text} from './content.js';
export {submitRightsEvidence,reviewRightsEvidence,verifyRightsForAction} from './rights.js';
export {createPreparedTranslationLink,verifyPreparedTranslationEdges,resolveTranslationSwitch} from './translation.js';
export {registerPreparedAudioAsset,registerPreparedAudioVariant,replacePreparedAudioSegment,getPreparedAudioVariant} from './audio.js';
export {preparedImportSchema,canonicalJson,payloadHash,previewPreparedCatalogImport,stagePreparedCatalogImport,resumeStagedCatalogMetadata,getStagedCatalogImportStatus} from './import-staging.js';
export type {PreparedImport,ImportPlanItem} from './import-staging.js';

// Quarantine-only private byte staging. No public stream or publish API.
export {LocalStorageAdapter, LOCAL_STORAGE_MAX_BYTES} from './local-storage.js';
export type {AssetOwner, CandidateMime, QuarantinedBlob, StagePrivateBlob} from './local-storage.js';

// INTERNAL private-user quota gate. Requires trusted auth caller; never publishes staged bytes.
export {reservePrivateUploadQuota,commitPrivateQuarantinedUpload,releasePrivateUploadQuota,inspectPrivateUploadQuota} from './private-quota.js';

// Internal RBAC-only catalog metadata queries. Never mount as a public route without rights verification.
export {searchCanonicalWorksForAdmin,searchCanonicalAuthorsForAdmin} from './catalog-search.js';
