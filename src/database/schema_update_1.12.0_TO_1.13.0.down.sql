-- Rollback for schema 1.12.0 → 1.13.0 (#117: bulk job persistence)
DROP INDEX IF EXISTS idx_bulk_operation_items_job;
DROP TABLE IF EXISTS bulk_operation_items;
DROP INDEX IF EXISTS idx_bulk_operations_user_status;
DROP TABLE IF EXISTS bulk_operations;
