-- Rollback for schema 1.13.0 → 1.14.0 (#69/#70: address allow/deny lists)
DROP INDEX IF EXISTS idx_address_list_user_type;
DROP TABLE IF EXISTS address_list_entries;
