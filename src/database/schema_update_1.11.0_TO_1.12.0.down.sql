-- Rollback for schema 1.11.0 → 1.12.0 (#119: messages_cache FTS5 index)
DROP TRIGGER IF EXISTS messages_cache_fts_au;
DROP TRIGGER IF EXISTS messages_cache_fts_ad;
DROP TRIGGER IF EXISTS messages_cache_fts_ai;
DROP TABLE IF EXISTS messages_cache_fts;
