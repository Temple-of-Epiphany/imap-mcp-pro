-- IMAP MCP Pro Database Schema
-- Version: 1.1.0
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2025-11-07
--
-- This schema supports MSP (Managed Service Provider) multi-tenant architecture
-- with encryption at rest for sensitive data.

-- Database metadata and versioning
CREATE TABLE IF NOT EXISTS schema_version (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);

-- schema.sql is a monolithic "current state" snapshot. When it runs on a fresh
-- DB it establishes the full schema up to the version below. The individual
-- schema_update_X.Y.Z_TO_X.Y.Z.sql files are for incremental upgrades of
-- databases that were created at an earlier version.
-- Keep these stamps in lockstep with migrations-manifest.json.
INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.0.0', 'Initial schema with MSP multi-tenant support');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.1.0', 'Add subscription management tables');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.2.0', 'Add unsubscribe execution tracking');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.3.0', 'Release 1.3.0 additions');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.4.0', 'Release 1.4.0 additions');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.5.0', 'Release 1.5.0 additions');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.6.0', 'Release 1.6.0 additions');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.7.0', 'Add tool_results + result_attachments cache for MCP context reduction (PR #94)');

-- Users/Organizations for MSP architecture
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  organization TEXT,
  role TEXT CHECK(role IN ('admin', 'user')) DEFAULT 'user', -- Issue #32: User roles/groups
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT 1,
  metadata TEXT -- JSON field for additional user data
);

CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- IMAP Email Accounts (migrated from JSON storage)
-- Passwords are encrypted at rest using AES-256-GCM
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  username TEXT NOT NULL,
  password_encrypted TEXT NOT NULL, -- Encrypted with AES-256-GCM
  encryption_iv TEXT NOT NULL, -- Initialization vector for decryption
  tls BOOLEAN DEFAULT 1,
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_secure BOOLEAN,
  smtp_username TEXT,
  smtp_password_encrypted TEXT, -- Encrypted with AES-256-GCM
  smtp_encryption_iv TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_connected TIMESTAMP,
  is_active BOOLEAN DEFAULT 1,
  capabilities TEXT,                -- JSON: IMAP capability flags (RFC 9051, Issue #58)
  capabilities_updated_at INTEGER,  -- Unix timestamp of last capability refresh
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);

-- User-Account access control with roles
CREATE TABLE IF NOT EXISTS user_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('owner', 'admin', 'user', 'readonly')) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  UNIQUE(user_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_user_accounts_user ON user_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_accounts_account ON user_accounts(account_id);

-- Contact management (auto-learned from emails)
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  message_count INTEGER DEFAULT 1,
  notes TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen DESC);

-- Email filtering rules (user-scoped)
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_id TEXT, -- NULL = applies to all accounts
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  pattern_type TEXT CHECK(pattern_type IN ('from', 'to', 'subject', 'body', 'header')) NOT NULL,
  action TEXT CHECK(action IN ('move', 'copy', 'mark_read', 'mark_unread', 'mark_spam', 'delete', 'flag')) NOT NULL,
  target_folder TEXT,
  enabled BOOLEAN DEFAULT 1,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_executed TIMESTAMP,
  execution_count INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rules_user ON rules(user_id);
CREATE INDEX IF NOT EXISTS idx_rules_account ON rules(account_id);
CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);
CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority DESC);

-- Spam domain cache (global, shared across all users)
CREATE TABLE IF NOT EXISTS spam_domains (
  domain TEXT PRIMARY KEY,
  spam_score REAL CHECK(spam_score >= 0 AND spam_score <= 1) NOT NULL,
  is_spam BOOLEAN NOT NULL,
  last_checked TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  check_count INTEGER DEFAULT 1,
  api_source TEXT, -- e.g., 'cleantalk', 'spamhaus'
  api_response TEXT, -- JSON response from API
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spam_domains_checked ON spam_domains(last_checked DESC);
CREATE INDEX IF NOT EXISTS idx_spam_domains_expires ON spam_domains(expires_at);

-- Spam cache for email content hashes (global)
CREATE TABLE IF NOT EXISTS spam_cache (
  email_hash TEXT PRIMARY KEY,
  spam_score REAL CHECK(spam_score >= 0 AND spam_score <= 1) NOT NULL,
  is_spam BOOLEAN NOT NULL,
  checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  api_source TEXT,
  sender_email TEXT,
  subject TEXT
);

CREATE INDEX IF NOT EXISTS idx_spam_cache_expires ON spam_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_spam_cache_sender ON spam_cache(sender_email);

-- Unsubscribe links (for Issue #15)
CREATE TABLE IF NOT EXISTS unsubscribe_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  uid INTEGER NOT NULL,
  sender_email TEXT NOT NULL,
  subject TEXT,
  unsubscribe_link TEXT,
  list_unsubscribe_header TEXT,
  message_date TIMESTAMP,
  extracted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  UNIQUE(account_id, folder, uid)
);

CREATE INDEX IF NOT EXISTS idx_unsubscribe_user ON unsubscribe_links(user_id);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_sender ON unsubscribe_links(sender_email);
CREATE INDEX IF NOT EXISTS idx_unsubscribe_extracted ON unsubscribe_links(extracted_at DESC);

-- Subscription summary (aggregated view for Issue #45 Phase 4, Issue #47)
CREATE TABLE IF NOT EXISTS subscription_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  sender_name TEXT,
  total_emails INTEGER DEFAULT 1,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  unsubscribe_link TEXT,
  unsubscribe_method TEXT CHECK(unsubscribe_method IN ('http', 'mailto', 'both')),
  unsubscribed BOOLEAN DEFAULT 0,
  unsubscribed_at TIMESTAMP,
  unsubscribe_attempted_at TIMESTAMP,
  unsubscribe_result TEXT CHECK(unsubscribe_result IN ('success', 'failed', 'error')),
  unsubscribe_error TEXT,
  category TEXT CHECK(category IN ('marketing', 'newsletter', 'promotional', 'transactional', 'other')) DEFAULT 'other',
  notes TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(user_id, sender_email)
);

CREATE INDEX IF NOT EXISTS idx_subscription_user ON subscription_summary(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_sender ON subscription_summary(sender_email);
CREATE INDEX IF NOT EXISTS idx_subscription_domain ON subscription_summary(sender_domain);
CREATE INDEX IF NOT EXISTS idx_subscription_category ON subscription_summary(category);
CREATE INDEX IF NOT EXISTS idx_subscription_unsubscribed ON subscription_summary(unsubscribed);

-- UserCheck API keys (per-user for Issues #17, #18, #3)
-- Each user/customer has their own UserCheck API key for SPAM detection
CREATE TABLE IF NOT EXISTS usercheck_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  is_active BOOLEAN DEFAULT 1,
  daily_limit INTEGER DEFAULT 1000,
  daily_usage INTEGER DEFAULT 0,
  usage_reset_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used TIMESTAMP,
  notes TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  UNIQUE(user_id, api_key)
);

CREATE INDEX IF NOT EXISTS idx_usercheck_user ON usercheck_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_usercheck_active ON usercheck_keys(is_active);

-- Audit log for security and compliance
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  account_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT, -- JSON field
  ip_address TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- Cached tool results (resource handle pattern) - v1.7.0
-- See schema_update_1.6.0_TO_1.7.0.sql
CREATE TABLE IF NOT EXISTS tool_results (
  result_id          TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  account_id         TEXT,
  tool_name          TEXT NOT NULL,
  folder             TEXT,
  params_json        TEXT NOT NULL,
  summary_json       TEXT NOT NULL,
  storage_mode       TEXT NOT NULL CHECK(storage_mode IN ('inline','file')),
  storage_type       TEXT NOT NULL CHECK(storage_type IN ('temp','persistent')) DEFAULT 'temp',
  rows_json          BLOB,
  rows_iv            TEXT,
  file_path          TEXT,
  file_size_bytes    INTEGER,
  row_count          INTEGER NOT NULL,
  schema_version     INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER,
  last_accessed_at   INTEGER NOT NULL,
  access_count       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
  CHECK (
    (storage_mode = 'inline' AND rows_json IS NOT NULL AND rows_iv IS NOT NULL
       AND file_path IS NULL)
    OR
    (storage_mode = 'file'   AND file_path IS NOT NULL AND file_size_bytes IS NOT NULL
       AND rows_json IS NULL AND rows_iv IS NULL)
  ),
  CHECK (
    (storage_type = 'persistent' AND expires_at IS NULL)
    OR
    (storage_type = 'temp'       AND expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tool_results_user          ON tool_results(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_results_user_created  ON tool_results(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_results_expires       ON tool_results(expires_at);
CREATE INDEX IF NOT EXISTS idx_tool_results_tool          ON tool_results(user_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_results_storage_type  ON tool_results(user_id, storage_type);

CREATE TABLE IF NOT EXISTS result_attachments (
  attachment_id      TEXT PRIMARY KEY,
  result_id          TEXT NOT NULL,
  message_uid        INTEGER,
  filename           TEXT NOT NULL,
  content_type       TEXT,
  size_bytes         INTEGER NOT NULL,
  file_path          TEXT NOT NULL,
  file_iv            TEXT NOT NULL,
  checksum_sha256    TEXT,
  skipped            INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (result_id) REFERENCES tool_results(result_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_result_attachments_result   ON result_attachments(result_id);
CREATE INDEX IF NOT EXISTS idx_result_attachments_msg_uid  ON result_attachments(result_id, message_uid);

-- ---------------------------------------------------------------------------
-- Backfill of tables that were introduced ONLY in migrations 1.4.0/1.5.0/1.6.0
-- but never mirrored here (#279). Because schema.sql seeds schema_version up
-- through 1.7.0 (above), the migrator treats those migrations as already
-- applied on a fresh DB and skips them — so without these definitions a fresh
-- install is missing the categories + DNS firewall tables entirely. schema.sql
-- runs on every startup with IF NOT EXISTS / INSERT OR IGNORE, so this is
-- idempotent and also self-heals already-created DBs on next launch.
-- ---------------------------------------------------------------------------

-- DNS Firewall cache (from schema_update_1.3.0_TO_1.4.0.sql, Issue #59)
CREATE TABLE IF NOT EXISTS dns_firewall_cache (
  domain TEXT PRIMARY KEY,
  is_safe BOOLEAN NOT NULL,
  is_blocked BOOLEAN NOT NULL,
  provider TEXT NOT NULL DEFAULT 'quad9',
  checked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_dns_cache_expires ON dns_firewall_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_dns_cache_domain ON dns_firewall_cache(domain);

-- DNS Firewall providers (from schema_update_1.4.0_TO_1.5.0.sql, Issue #60)
CREATE TABLE IF NOT EXISTS dns_firewall_providers (
  provider_id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('dns-over-https', 'dns-lookup')),
  api_endpoint TEXT,
  api_key TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT 1,
  is_default BOOLEAN NOT NULL DEFAULT 0,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_dns_providers_enabled ON dns_firewall_providers(is_enabled);
CREATE INDEX IF NOT EXISTS idx_dns_providers_default ON dns_firewall_providers(is_default);

-- Seed Quad9 as the default provider. INSERT OR IGNORE (not the migration's
-- plain INSERT) because schema.sql re-runs on every startup.
INSERT OR IGNORE INTO dns_firewall_providers (
  provider_id, provider_name, provider_type, api_endpoint, api_key,
  is_enabled, is_default, timeout_ms, created_at, updated_at, metadata
) VALUES (
  'quad9', 'Quad9', 'dns-over-https', 'dns.quad9.net', NULL,
  1, 1, 5000,
  strftime('%s', 'now') * 1000, strftime('%s', 'now') * 1000,
  '{"description":"Quad9 DNS-over-HTTPS threat intelligence service"}'
);

CREATE TRIGGER IF NOT EXISTS ensure_single_default_provider
BEFORE UPDATE ON dns_firewall_providers
WHEN NEW.is_default = 1 AND OLD.is_default = 0
BEGIN
  UPDATE dns_firewall_providers SET is_default = 0 WHERE provider_id != NEW.provider_id;
END;

-- Quick Categories (from schema_update_1.5.0_TO_1.6.0.sql, Issue #71)
CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  keywords TEXT NOT NULL,
  target_folder TEXT NOT NULL,
  enabled BOOLEAN DEFAULT 1,
  match_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_matched TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  UNIQUE(user_id, account_id, category_name)
);

CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_account ON categories(account_id);
CREATE INDEX IF NOT EXISTS idx_categories_enabled ON categories(enabled);
CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(category_name);
