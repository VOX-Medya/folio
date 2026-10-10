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
export {createCanonicalAuthor,createCanonicalWork,createVerifiedAdminDraftAuthor,createVerifiedAdminDraftWork,getCanonicalWorkDetails,getVerifiedAdminWorkDetails,getVerifiedAdminAuthorDetails,patchVerifiedAdminAuthorMetadata,patchVerifiedAdminWorkMetadata,appendVerifiedAdminWorkEdition,appendVerifiedAdminWorkTitle,appendVerifiedAdminWorkAuthor,patchVerifiedAdminEditionMetadata} from './catalog.js';
export {createContentRevision, getRevisionBlocks, sha256Text} from './content.js';
export {compareSemanticRevisionMetadata,getInternalRevisionMetadataDiff,getVerifiedAdminRevisionMetadataDiff} from './content-diff.js';
export type {SemanticDiffBlock,SemanticDiffChange} from './content-diff.js';
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
export {searchCanonicalWorksForAdmin,searchCanonicalAuthorsForAdmin,searchVerifiedAdminWorks,searchVerifiedAdminAuthors} from './catalog-search.js';

// Internal verified email/session foundation. No public auth routes until anti-abuse, secure cookie and MFA gates.
export {registerPendingAccount,verifyAccountEmail,issuePasswordResetChallenge,resetAccountPassword,signInVerifiedAccount,authenticateUserSession,revokeUserSession,revokeAllUserSessions,MAX_ACTIVE_DEVICE_SESSIONS} from './auth.js';

// Authenticated-only per-user onboarding preference/version synchronization.
export {getVerifiedUserOnboarding,updateVerifiedUserOnboarding} from './onboarding.js';

// DB-backed role + MFA gates. Encrypted TOTP issuer is INTERNAL ONLY; no HTTP admin route.
export {withVerifiedAdminPermission} from './admin-authorization.js';
export {grantManagedAdminRole,revokeManagedAdminRole} from './admin-role-lifecycle.js';
export type {AdminRoleChange} from './admin-role-lifecycle.js';
// Internal verified-admin-member factor enrollment and replay-safe MFA step-up.
export {beginAdminTotpEnrollment,confirmAdminTotpEnrollment,verifyAdminTotpForSession} from './admin-totp.js';
export {rotateAdminTotpEnvelopeForUser,inspectAdminTotpKeyVersions} from './admin-totp-rotation.js';
export type {TotpEnvelopeRotation} from './admin-totp-rotation.js';
export {proposeAdminMfaRecoveryReview,approveAdminMfaRecoveryReview,cancelAdminMfaRecoveryReview,ADMIN_MFA_REVIEW_EXPIRY_MS} from './admin-mfa-recovery.js';
export type {AdminMfaRecoveryReview} from './admin-mfa-recovery.js';
export {requireTotpKeyring} from './admin-totp-crypto.js';
export type {TotpKeyring,TotpKeyMaterial,TotpKeyVersion} from './admin-totp-crypto.js';
export type {VerifiedAdminIdentity} from './admin-authorization.js';

// INTERNAL ONLY; caller must provide trusted client IP and server-managed HMAC key.
export {AuthRateLimitExceeded,prepareAuthAttemptBuckets,consumeAuthAttemptRateLimit,pruneExpiredAuthAttemptWindows} from './auth-rate-limit.js';

// Verified owner-only active session metadata and targeted revocation.
export {listVerifiedDeviceSessions,revokeVerifiedDeviceSession} from './device-sessions.js';
