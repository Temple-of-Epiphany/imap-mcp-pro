-- Rollback Migration: 1.7.0 to 1.6.0
-- Date: 2026-04-19
-- Description: Drop tool_results + result_attachments cache
-- See: schema_update_1.6.0_TO_1.7.0.sql

DROP INDEX IF EXISTS idx_result_attachments_msg_uid;
DROP INDEX IF EXISTS idx_result_attachments_result;
DROP TABLE IF EXISTS result_attachments;

DROP INDEX IF EXISTS idx_tool_results_storage_type;
DROP INDEX IF EXISTS idx_tool_results_tool;
DROP INDEX IF EXISTS idx_tool_results_expires;
DROP INDEX IF EXISTS idx_tool_results_user_created;
DROP INDEX IF EXISTS idx_tool_results_user;
DROP TABLE IF EXISTS tool_results;

-- Note: schema_version rows are deleted by MigrationService.rollback()
