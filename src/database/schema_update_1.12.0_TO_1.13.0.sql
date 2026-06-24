-- Schema migration 1.12.0 → 1.13.0
-- Track A (#117): persistent job state for long-running bulk operations.
--
-- Adds two tables so a bulk scan can be polled, cancelled, and resumed:
--   bulk_operations       one row per job (status, progress, params, summary)
--   bulk_operation_items  one row per processed item (resume cursor + dedup)
--
-- Stores only JOB STATE, never message content (that's #119, Track B). Items
-- are keyed by a stable item_key (e.g. a normalized sender address) so a
-- resumed job skips everything already processed.
--
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2026-06-23

CREATE TABLE IF NOT EXISTS bulk_operations (
  job_id              TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  tool_name           TEXT NOT NULL,
  params_json         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN
                        ('queued','running','paused','done','failed','cancelled')),
  total_items         INTEGER,
  done_items          INTEGER NOT NULL DEFAULT 0,
  error_items         INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  started_at          INTEGER,
  finished_at         INTEGER,
  last_error          TEXT,
  result_summary_json TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bulk_operations_user_status
  ON bulk_operations(user_id, status, created_at);

CREATE TABLE IF NOT EXISTS bulk_operation_items (
  job_id          TEXT NOT NULL,
  item_key        TEXT NOT NULL,    -- normalized sender, UID, domain, etc.
  processed_at    INTEGER,
  outcome         TEXT CHECK (outcome IN ('ok','skip','error')),
  result_json     TEXT,
  error_text      TEXT,
  PRIMARY KEY (job_id, item_key),
  FOREIGN KEY (job_id) REFERENCES bulk_operations(job_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bulk_operation_items_job
  ON bulk_operation_items(job_id, processed_at);
