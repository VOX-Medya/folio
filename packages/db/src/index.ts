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
export {compareSemanticRevisionMetadata,getInternalRevisionMetadataDiff,getVerifiedAdminRevisionMetadataDiff,getVerifiedAdminEditionRevisions} from './content-diff.js';
export type {SemanticDiffBlock,SemanticDiffChange} from './content-diff.js';
export {submitRightsEvidence,reviewRightsEvidence,verifyRightsForAction,getVerifiedAdminRightsLedger} from './rights.js';
export {createPreparedTranslationLink,verifyPreparedTranslationEdges,resolveTranslationSwitch} from './translation.js';
export {registerPreparedAudioAsset,registerPreparedAudioVariant,replacePreparedAudioSegment,getPreparedAudioVariant} from './audio.js';
export {preparedImportSchema,canonicalJson,payloadHash,previewPreparedCatalogImport,stagePreparedCatalogImport,resumeStagedCatalogMetadata,getStagedCatalogImportStatus} from './import-staging.js';
export type {PreparedImport,ImportPlanItem} from './import-staging.js';

// Quarantine-only private byte staging. No public stream or publish API.
export {LocalStorageAdapter, LOCAL_STORAGE_MAX_BYTES, PRIVATE_ORPHAN_GRACE_MS} from './local-storage.js';
export type {AssetOwner, CandidateMime, QuarantinedBlob, StagePrivateBlob, StorageAdapter} from './local-storage.js';

// Bounded, structure-only EPUB ZIP inspection; never a text parser or approval.
export {inspectEpubZipStructure,inspectEpubZipPackageSpine,inspectEpubZipXhtmlMarkup,inspectEpubZipCssResources,inspectEpubZipPngResources,EPUB_ZIP_PREFLIGHT_MAX_BYTES,EPUB_ZIP_PREFLIGHT_MAX_ENTRIES} from './epub-structure.js';
export type {EpubXhtmlMarkupResult} from './epub-xhtml.js';
export type {EpubCssResourceResult} from './epub-css.js';
export type {EpubPngResourcesResult} from './epub-png.js';
export {inspectOggOpusContainer,OGG_OPUS_PREFLIGHT_MAX_BYTES} from './ogg-opus.js';
export type {OggOpusContainerResult} from './ogg-opus.js';
export type {EpubPackageSpineResult} from './epub-package.js';
export type {EpubZipStructuralResult} from './epub-structure.js';

// INTERNAL antivirus byte-stream adapter. A clean verdict is NEVER a verified
// media DB state, parser acceptance or publication/rights grant.
export {ClamAvStdinScanner,PRIVATE_CLAMAV_ARGS,PRIVATE_CLAMAV_MAX_BYTES} from './quarantine-scanner.js';
export type {QuarantineByteScanner,QuarantineScanVerdict} from './quarantine-scanner.js';

// INTERNAL private-user quota gate. Requires trusted auth caller; never publishes staged bytes.
export {reservePrivateUploadQuota,commitPrivateQuarantinedUpload,releasePrivateUploadQuota,inspectPrivateUploadQuota,sweepPrivateQuarantineOrphans,observePrivateQuarantineMalware,observePrivateQuarantineEpubStructure,observePrivateQuarantineEpubPackageSpine,observePrivateQuarantineEpubXhtmlMarkup,observePrivateQuarantineEpubCssResources,observePrivateQuarantineEpubPngResources,observePrivateQuarantineOggOpus} from './private-quota.js';

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
