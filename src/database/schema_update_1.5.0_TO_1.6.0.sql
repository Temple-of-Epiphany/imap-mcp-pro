-- Schema Migration: 1.5.0 to 1.6.0
-- Date: 2025-12-22
-- Description: Add Quick Categories for email organization (Issue #71)
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com

-- Quick Categories for email filtering/organization
-- Stores simple keyword-based rules for automatic email categorization
CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  keywords TEXT NOT NULL, -- Comma or semicolon separated keywords/email addresses
  target_folder TEXT NOT NULL, -- Folder path to move matching emails
  enabled BOOLEAN DEFAULT 1,
  match_count INTEGER DEFAULT 0, -- Track how many emails matched this category
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

-- Update schema version
INSERT OR IGNORE INTO schema_version (version, description)
VALUES ('1.6.0', 'Add Quick Categories for email organization');
