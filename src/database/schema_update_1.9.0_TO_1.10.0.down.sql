-- Rollback for schema 1.9.0 → 1.10.0 (WP2: Attachment Staging API)
DROP INDEX IF EXISTS idx_attachment_staging_user_active;
DROP INDEX IF EXISTS idx_attachment_staging_expires;
DROP INDEX IF EXISTS idx_attachment_staging_user;
DROP TABLE IF EXISTS attachment_staging;
