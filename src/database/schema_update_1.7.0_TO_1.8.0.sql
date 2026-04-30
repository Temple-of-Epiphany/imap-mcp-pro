-- Schema migration 1.7.0 → 1.8.0
-- WP4: Sent Folder Placement (Issue #98, tracker #97)
--
-- Adds:
--   sent_folder_cache    Per-account cache of resolved Sent folder name
--   append_retry_queue   Queue of failed APPEND-to-Sent operations for
--                        background retry. Decoupled from SMTP send so a
--                        transient IMAP failure after a successful SMTP
--                        delivery doesn't lose the user's Sent copy.
--
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2026-04-30

CREATE TABLE IF NOT EXISTS sent_folder_cache (
  account_id          TEXT PRIMARY KEY,
  folder_name         TEXT NOT NULL,
  resolution_method   TEXT NOT NULL CHECK (resolution_method IN (
                        'special_use', 'preset', 'fallback', 'auto_created', 'override'
                      )),
  resolved_at         INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sent_folder_cache_expires ON sent_folder_cache(expires_at);

CREATE TABLE IF NOT EXISTS append_retry_queue (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          TEXT NOT NULL,
  target_folder       TEXT NOT NULL,
  message_bytes       BLOB NOT NULL,        -- AES-256-GCM encrypted MIME bytes
  message_iv          TEXT NOT NULL,        -- IV used to encrypt message_bytes
  flags               TEXT NOT NULL,        -- JSON array of IMAP flags
  internal_date       INTEGER NOT NULL,     -- unix ms; passed as APPEND internal date
  created_at          INTEGER NOT NULL,
  last_attempt_at     INTEGER,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  expires_at          INTEGER NOT NULL,     -- after this, drop the entry
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_append_retry_account ON append_retry_queue(account_id);
CREATE INDEX IF NOT EXISTS idx_append_retry_expires ON append_retry_queue(expires_at);
CREATE INDEX IF NOT EXISTS idx_append_retry_pending ON append_retry_queue(last_attempt_at, expires_at);
