-- V1 #30: forward-only dual-read AES-GCM key rollover.
-- Existing rows stay v1, no seed/ciphertext or MFA proof reset.
-- V2 encryption is opt-in and requires a distinct server-managed key.
ALTER TABLE "admin_totp_credentials"
  DROP CONSTRAINT "admin_totp_key_version_ck";
--> statement-breakpoint
ALTER TABLE "admin_totp_credentials"
  ADD CONSTRAINT "admin_totp_key_version_ck"
  CHECK ("key_version" IN ('v1','v2'));
