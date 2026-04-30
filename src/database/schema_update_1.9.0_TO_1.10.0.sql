-- Schema migration 1.9.0 → 1.10.0
-- WP2: Attachment Staging API (Issue #101, tracker #97)
--
-- Adds:
--   attachment_staging   Metadata for chunked attachment uploads. Bytes are
--                        stored on disk under {stagingDir}/{userId}/{stagingId}/
--                        as one file per chunk (chunk-NNNNNN.bin); finalize
--                        concatenates them in order and writes the assembled
--                        file alongside.
--
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2026-04-30

CREATE TABLE IF NOT EXISTS attachment_staging (
  staging_id          TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  filename            TEXT NOT NULL,
  content_type        TEXT NOT NULL DEFAULT 'application/octet-stream',
  expected_size       INTEGER NOT NULL,        -- bytes the client said it would upload
  current_size        INTEGER NOT NULL DEFAULT 0,
  chunks_received     INTEGER NOT NULL DEFAULT 0,
  storage_dir         TEXT NOT NULL,           -- {stagingDir}/{userId}/{stagingId}/
  assembled_path      TEXT,                    -- set on finalize
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  finalized           INTEGER NOT NULL DEFAULT 0,  -- 0/1
  finalized_at        INTEGER,
  sha256              TEXT,                    -- hex digest set on finalize
  consumed_at         INTEGER,                 -- when the staged file was attached to a sent email and cleaned up
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachment_staging_user    ON attachment_staging(user_id);
CREATE INDEX IF NOT EXISTS idx_attachment_staging_expires ON attachment_staging(expires_at);
CREATE INDEX IF NOT EXISTS idx_attachment_staging_user_active
  ON attachment_staging(user_id, finalized, expires_at);
