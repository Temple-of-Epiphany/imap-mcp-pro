-- Schema migration 1.8.0 → 1.9.0
-- WP1: Attachment-by-Reference (Issue #100, tracker #97)
--
-- Adds:
--   users.allowed_attachment_dirs   Per-user override (CSV) for the global
--                                   IMAP_MCP_ALLOWED_ATTACHMENT_DIRS list.
--                                   When non-null, takes precedence.
--
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2026-04-30

ALTER TABLE users ADD COLUMN allowed_attachment_dirs TEXT;
