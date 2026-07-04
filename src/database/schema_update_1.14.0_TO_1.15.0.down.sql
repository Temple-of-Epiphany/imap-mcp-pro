-- Rollback for 1.14.0 → 1.15.0. SQLite < 3.35 cannot DROP COLUMN; on modern
-- SQLite (node:sqlite) these succeed. Safe to no-op if unsupported.
ALTER TABLE accounts DROP COLUMN signature_html;
ALTER TABLE accounts DROP COLUMN signature_text;
