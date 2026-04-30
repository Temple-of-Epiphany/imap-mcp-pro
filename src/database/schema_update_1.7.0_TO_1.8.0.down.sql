-- Rollback for schema 1.7.0 → 1.8.0 (WP4: Sent Folder Placement)
DROP INDEX IF EXISTS idx_append_retry_pending;
DROP INDEX IF EXISTS idx_append_retry_expires;
DROP INDEX IF EXISTS idx_append_retry_account;
DROP TABLE IF EXISTS append_retry_queue;

DROP INDEX IF EXISTS idx_sent_folder_cache_expires;
DROP TABLE IF EXISTS sent_folder_cache;
