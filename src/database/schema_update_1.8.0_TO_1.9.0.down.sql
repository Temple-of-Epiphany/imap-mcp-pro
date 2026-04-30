-- Rollback for schema 1.8.0 → 1.9.0 (WP1: Attachment-by-Reference)
-- SQLite supports DROP COLUMN since 3.35; if the runtime is older, this
-- migration's down step is a no-op (the column is harmless to leave).
ALTER TABLE users DROP COLUMN allowed_attachment_dirs;
