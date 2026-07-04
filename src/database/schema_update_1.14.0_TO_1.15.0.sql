-- Schema migration 1.14.0 → 1.15.0
-- Per-account email signatures (plain-text + optional HTML), appended to
-- outgoing mail by imap_send_email / reply / forward unless disabled.
--
-- Author: Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
-- Date: 2026-07-04

ALTER TABLE accounts ADD COLUMN signature_text TEXT;
ALTER TABLE accounts ADD COLUMN signature_html TEXT;
