-- Schema migration 1.11.0 → 1.12.0
-- Track B (#119): FTS5 full-text search over the local message header cache.
--
-- Adds a full-text index over the fields already stored in messages_cache
-- (subject + sender display name + sender address) so partial-recall queries
-- ("something about a closing schedule from someone at a law firm") become a
-- single ranked MATCH instead of fetching N bodies into the model's context.
--
-- PRIVACY NOTE: this indexes only data the header cache already holds — no
-- message bodies are fetched or stored. Body-text FTS, the participants table,
-- and threading columns remain deferred (the rest of #119).
--
-- Implementation: an external-content FTS5 table (content='messages_cache')
-- kept in sync by AFTER INSERT/UPDATE/DELETE triggers, so no service code needs
-- to write to it. INSERT OR REPLACE (used by syncFolder) fires DELETE+INSERT,
-- which the triggers handle. Existing cached rows are backfilled below.
--
-- Author: Colin Bitterfield
-- Email: colin.bitterfield@templeofepiphany.com
-- Date: 2026-06-22

CREATE VIRTUAL TABLE IF NOT EXISTS messages_cache_fts USING fts5(
  subject,
  from_name,
  from_address,
  content='messages_cache',
  content_rowid='rowid',
  tokenize='unicode61'
);

-- Keep the FTS index in lockstep with messages_cache.
CREATE TRIGGER IF NOT EXISTS messages_cache_fts_ai AFTER INSERT ON messages_cache BEGIN
  INSERT INTO messages_cache_fts(rowid, subject, from_name, from_address)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address);
END;

CREATE TRIGGER IF NOT EXISTS messages_cache_fts_ad AFTER DELETE ON messages_cache BEGIN
  INSERT INTO messages_cache_fts(messages_cache_fts, rowid, subject, from_name, from_address)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address);
END;

CREATE TRIGGER IF NOT EXISTS messages_cache_fts_au AFTER UPDATE ON messages_cache BEGIN
  INSERT INTO messages_cache_fts(messages_cache_fts, rowid, subject, from_name, from_address)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address);
  INSERT INTO messages_cache_fts(rowid, subject, from_name, from_address)
  VALUES (new.rowid, new.subject, new.from_name, new.from_address);
END;

-- Backfill any rows cached before this migration.
INSERT INTO messages_cache_fts(rowid, subject, from_name, from_address)
  SELECT rowid, subject, from_name, from_address FROM messages_cache;
