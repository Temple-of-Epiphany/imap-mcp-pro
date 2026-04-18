-- Schema Migration: 1.6.0 to 1.7.0
-- Date: 2026-04-18
-- Description: Add tool_results + result_attachments cache for MCP context-reduction
-- Author: Temple of Epiphany

-- Cached tool results (resource handle pattern)
-- storage_mode: 'inline' = rows_json BLOB; 'file' = file_path on disk
-- storage_type: 'temp' = TTL-bound; 'persistent' = user-retained
CREATE TABLE IF NOT EXISTS tool_results (
  result_id          TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  account_id         TEXT,
  tool_name          TEXT NOT NULL,
  folder             TEXT,
  params_json        TEXT NOT NULL,
  summary_json       TEXT NOT NULL,
  storage_mode       TEXT NOT NULL CHECK(storage_mode IN ('inline','file')),
  storage_type       TEXT NOT NULL CHECK(storage_type IN ('temp','persistent')) DEFAULT 'temp',
  rows_json          BLOB,                       -- AES-256-GCM encrypted
  rows_iv            TEXT,                       -- IV hex; NULL when storage_mode='file'
  file_path          TEXT,                       -- absolute path; NULL when storage_mode='inline'
  file_size_bytes    INTEGER,
  row_count          INTEGER NOT NULL,
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER,                    -- NULL when storage_type='persistent'
  last_accessed_at   INTEGER NOT NULL,
  access_count       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_results_user          ON tool_results(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_user_created  ON tool_results(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_results_expires       ON tool_results(expires_at);
CREATE INDEX IF NOT EXISTS idx_tool_results_tool          ON tool_results(user_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_results_storage_type  ON tool_results(user_id, storage_type);

-- Per-attachment metadata for cached results
-- Attachment blobs live on disk under <results_root>/<userId>/<resultId>/attachments/<attachment_id>.bin
-- (encrypted with the same AES-256-GCM key as the database)
CREATE TABLE IF NOT EXISTS result_attachments (
  attachment_id      TEXT PRIMARY KEY,
  result_id          TEXT NOT NULL,
  message_uid        INTEGER,
  filename           TEXT NOT NULL,
  content_type       TEXT,
  size_bytes         INTEGER NOT NULL,
  file_path          TEXT NOT NULL,
  file_iv            TEXT NOT NULL,              -- IV used to encrypt the attachment file
  checksum_sha256    TEXT,
  skipped            INTEGER NOT NULL DEFAULT 0, -- 1 = oversize, content not stored
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (result_id) REFERENCES tool_results(result_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_result_attachments_result   ON result_attachments(result_id);
CREATE INDEX IF NOT EXISTS idx_result_attachments_msg_uid  ON result_attachments(result_id, message_uid);

-- Update schema version
INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.7.0', 'Add tool_results + result_attachments cache for MCP context reduction');
