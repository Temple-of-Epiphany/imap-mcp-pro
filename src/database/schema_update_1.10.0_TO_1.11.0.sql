-- Schema migration 1.10.0 → 1.11.0
-- v2.17.0 MVP: local message header cache (Issue #124, Track B thin slice of #119)
--
-- Adds:
--   messages_cache    Per-message header cache for fast sender enumeration
--                     and SQL-backed search. Powers imap_sync_folder_cache
--                     and imap_search_cache tools introduced in v2.17.0.
--                     One row per (account_id, folder, uid). The cache is
--                     populated explicitly by imap_sync_folder_cache; existing
--                     read tools (imap_search_emails, imap_get_email) are NOT
--                     transparently rewritten to consult it in v2.17.0.
--
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2026-04-30

CREATE TABLE IF NOT EXISTS messages_cache (
  account_id        TEXT NOT NULL,
  folder            TEXT NOT NULL,
  uid               INTEGER NOT NULL,
  uid_validity      INTEGER NOT NULL,        -- detect mailbox renumbering
  message_id        TEXT,                    -- RFC 5322 Message-ID
  date_received     INTEGER,                 -- unix milliseconds
  subject           TEXT,
  from_address      TEXT,                    -- normalized lowercase
  from_domain       TEXT,                    -- denormalized for GROUP BY
  from_name         TEXT,                    -- "John Smith" — searchable display name
  list_unsubscribe  TEXT,                    -- raw List-Unsubscribe header (RFC 2369)
  flags_json        TEXT,                    -- JSON array of flags ['\\Seen', '\\Flagged']
  cached_at         INTEGER NOT NULL,        -- unix ms when this row was last refreshed
  PRIMARY KEY (account_id, folder, uid),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

-- Sender domain GROUP BY (top-N senders by count) — primary search path.
CREATE INDEX IF NOT EXISTS idx_messages_cache_from_domain
  ON messages_cache(account_id, from_domain);

-- Sender address lookup (specific sender's mail).
CREATE INDEX IF NOT EXISTS idx_messages_cache_from_address
  ON messages_cache(account_id, from_address);

-- Date range filtering ("last 90 days") — combined with from_domain in the
-- compound index above, this carries a wide range of triage queries.
CREATE INDEX IF NOT EXISTS idx_messages_cache_date
  ON messages_cache(account_id, date_received);
