-- Rollback for schema 1.10.0 → 1.11.0 (v2.17.0 MVP: messages_cache table)
DROP INDEX IF EXISTS idx_messages_cache_date;
DROP INDEX IF EXISTS idx_messages_cache_from_address;
DROP INDEX IF EXISTS idx_messages_cache_from_domain;
DROP TABLE IF EXISTS messages_cache;
