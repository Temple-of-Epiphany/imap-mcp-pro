-- Schema migration 1.13.0 → 1.14.0
-- Per-user allow/deny address lists (#69/#70).
--
-- One row per (user, list, value). `value` is a normalized email address or a
-- bare domain; `value_type` says which. Lists are per-user (multi-tenant ready);
-- consulted by imap_check_address and, later, the spam/DNS decision paths.
--
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2026-06-24

CREATE TABLE IF NOT EXISTS address_list_entries (
  user_id     TEXT NOT NULL,
  list_type   TEXT NOT NULL CHECK (list_type IN ('allow','deny')),
  value       TEXT NOT NULL,    -- normalized: lowercase email or bare domain
  value_type  TEXT NOT NULL CHECK (value_type IN ('email','domain')),
  note        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, list_type, value)
);

CREATE INDEX IF NOT EXISTS idx_address_list_user_type
  ON address_list_entries(user_id, list_type);
