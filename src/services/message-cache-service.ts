/**
 * MessageCacheService — local SQLite header cache for fast sender enumeration.
 *
 * v2.17.0 MVP scope (Issue #124, thin slice of Track B / #119):
 *   - One table: messages_cache (account_id, folder, uid, header fields)
 *   - Explicit sync (no transparent rewrite of existing tools)
 *   - Three search modes: by_domain, by_address, group_by_sender
 *   - Cache miss returns an explicit error — no silent IMAP fallback
 *
 * Out of scope for v2.17.0 (deferred to full B.1 in #119):
 *   - Participants table, attachments table, threading columns
 *   - Cache mutation write-through on flag changes
 *   - Multi-folder sync (one folder per call)
 *   - Body cache, FTS5 index
 *
 * Cache-miss heuristic: a folder is considered "synced" when at least one row
 * exists for (account_id, folder). MVP limitation — an empty folder that was
 * legitimately synced will look like a cache miss. Acceptable for v2.17.0;
 * v2.18.0 may add a folder_cache_state table to track sync without rows.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Date Updated: 2026-04-30
 * Version: 0.2.0
 */

import { DatabaseService } from './database-service.js';
import { ImapService } from './imap-service.js';
import type { FetchMessageObject } from 'imapflow';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape persisted in the messages_cache table. */
export interface CachedMessageRow {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: number;
  messageId: string | null;
  dateReceived: number | null;          // unix ms
  subject: string | null;
  fromAddress: string | null;           // normalized lowercase
  fromDomain: string | null;
  fromName: string | null;
  listUnsubscribe: string | null;
  flags: string[];
  cachedAt: number;                     // unix ms
}

export interface SyncFolderOptions {
  /** Force full resync regardless of UIDVALIDITY. */
  fullResync?: boolean;
}

export interface SyncFolderReport {
  accountId: string;
  folder: string;
  uidValidity: number;
  /** True if UIDVALIDITY changed and cache was wiped before this sync. */
  uidValidityChanged: boolean;
  rowsBefore: number;
  rowsAfter: number;
  rowsAdded: number;
  rowsUpdated: number;
  durationMs: number;
}

export interface SearchOptions {
  /** Lower bound for date_received (unix ms). Optional. */
  since?: number;
  /** Upper bound for date_received (unix ms). Optional. */
  until?: number;
  /** Cap on returned rows. Default 50. */
  limit?: number;
}

export interface SenderGroupRow {
  fromAddress: string;
  fromDomain: string;
  fromName: string | null;
  count: number;
  lastSeen: number;                     // most recent date_received in the group
  listUnsubscribePresent: boolean;      // any row in the group has the header
}

/** Cache miss is an explicit error — caller (tool layer) translates it to a
 *  structured response rather than silently falling back to IMAP. */
export class CacheMissError extends Error {
  readonly accountId: string;
  readonly folder: string;
  constructor(accountId: string, folder: string) {
    super(`Cache miss: folder "${folder}" on account "${accountId}" has not been synced. ` +
          `Call imap_sync_folder_cache first.`);
    this.name = 'CacheMissError';
    this.accountId = accountId;
    this.folder = folder;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pull domain off "user@host" → "host" (lowercase).
 *  Exported for unit tests (src/services/message-cache-service.test.ts). */
export function extractDomain(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

/** Find a header in imapflow's raw-headers Buffer (case-insensitive,
 *  handles folded continuation lines).
 *  Exported for unit tests (src/services/message-cache-service.test.ts). */
export function extractHeader(headersBuf: Buffer | undefined, name: string): string | null {
  if (!headersBuf || headersBuf.length === 0) return null;
  const text = headersBuf.toString('utf8');
  const lines = text.split(/\r?\n/);
  const lowerName = name.toLowerCase() + ':';
  let value: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.toLowerCase().startsWith(lowerName)) {
      value = line.slice(lowerName.length).trim();
      // Continuation lines start with whitespace; concatenate.
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) {
        i++;
        value += ' ' + lines[i].trim();
      }
      return value;
    }
  }
  return null;
}

/** Convert imapflow's FetchMessageObject into a CachedMessageRow. */
function toCacheRow(
  accountId: string,
  folder: string,
  uidValidity: number,
  cachedAt: number,
  msg: FetchMessageObject,
): CachedMessageRow | null {
  if (!msg || typeof msg.uid !== 'number') return null;

  const fromEntry = msg.envelope?.from?.[0];
  const fromAddrRaw = fromEntry?.address ?? null;
  const fromAddress = fromAddrRaw ? fromAddrRaw.toLowerCase() : null;
  const fromDomain = extractDomain(fromAddress);
  const fromName = fromEntry?.name ?? null;

  // imapflow gives `headers` as a Buffer when fetched via `headers: [...]`.
  const headersBuf = (msg as any).headers as Buffer | undefined;
  const listUnsubscribe = extractHeader(headersBuf, 'List-Unsubscribe');

  const date = msg.envelope?.date instanceof Date ? msg.envelope.date.getTime()
             : msg.envelope?.date ? new Date(msg.envelope.date as any).getTime()
             : null;

  return {
    accountId,
    folder,
    uid: msg.uid,
    uidValidity,
    messageId: msg.envelope?.messageId ?? null,
    dateReceived: date,
    subject: msg.envelope?.subject ?? null,
    fromAddress,
    fromDomain,
    fromName,
    listUnsubscribe,
    flags: msg.flags ? Array.from(msg.flags) : [],
    cachedAt,
  };
}

/** Row coming back from SQLite → typed CachedMessageRow. */
function rowFromDb(r: any): CachedMessageRow {
  let flags: string[] = [];
  try {
    if (r.flags_json) flags = JSON.parse(r.flags_json);
  } catch { /* swallow */ }
  return {
    accountId: r.account_id,
    folder: r.folder,
    uid: r.uid,
    uidValidity: r.uid_validity,
    messageId: r.message_id,
    dateReceived: r.date_received,
    subject: r.subject,
    fromAddress: r.from_address,
    fromDomain: r.from_domain,
    fromName: r.from_name,
    listUnsubscribe: r.list_unsubscribe,
    flags,
    cachedAt: r.cached_at,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MessageCacheService {
  constructor(
    private db: DatabaseService,
    private imap: ImapService,
  ) {}

  /**
   * Sync a folder's headers into the local cache. Idempotent.
   *
   * Behavior:
   *   1. Read existing cache state (count, max uid, uid_validity).
   *   2. Open IMAP folder, read current UIDVALIDITY + UIDNEXT.
   *   3. If cached UIDVALIDITY differs (or fullResync=true), wipe rows.
   *   4. Fetch every UID > max-cached-UID (or 1:* on full resync).
   *   5. INSERT OR REPLACE rows in a single transaction.
   *   6. Return a SyncFolderReport.
   */
  async syncFolder(
    accountId: string,
    folder: string,
    options: SyncFolderOptions = {},
  ): Promise<SyncFolderReport> {
    const start = Date.now();
    const rawDb = this.db.getDb();

    // 1. Existing cache state for this folder.
    const existing = rawDb.prepare(
      `SELECT
         COUNT(*)          AS count,
         MAX(uid)          AS max_uid,
         MAX(uid_validity) AS uid_validity
       FROM messages_cache
       WHERE account_id = $a AND folder = $f`
    ).get({ $a: accountId, $f: folder }) as
      | { count: number; max_uid: number | null; uid_validity: number | null }
      | undefined;

    const rowsBefore = existing?.count ?? 0;
    const cachedUidValidity = existing?.uid_validity ?? null;
    const maxCachedUid = existing?.max_uid ?? 0;

    // 2. Resolve current IMAP folder state (no fetch yet).
    const head = await this.imap.fetchHeadersForCache(accountId, folder, null);
    const currentUidValidity = head.uidValidity;
    const currentUidNext = head.uidNext;

    // 3. Decide: full resync or incremental?
    const uidValidityChanged =
      cachedUidValidity !== null && cachedUidValidity !== currentUidValidity;
    const fullResync = options.fullResync === true || uidValidityChanged;

    if (fullResync && rowsBefore > 0) {
      rawDb.prepare(
        `DELETE FROM messages_cache WHERE account_id = $a AND folder = $f`
      ).run({ $a: accountId, $f: folder });
    }

    const baseRows = fullResync ? 0 : rowsBefore;

    // 4. Compute UID range. Skip fetch entirely when there's nothing new.
    const fetchFrom = fullResync ? 1 : maxCachedUid + 1;
    const nothingNew = currentUidNext > 0 && fetchFrom >= currentUidNext;

    let rowsAdded = 0;
    if (!nothingNew) {
      const uidRange = `${fetchFrom}:*`;
      const fetched = await this.imap.fetchHeadersForCache(accountId, folder, uidRange);

      // 5. Insert in a single transaction for performance.
      const insert = rawDb.prepare(`
        INSERT OR REPLACE INTO messages_cache (
          account_id, folder, uid, uid_validity, message_id, date_received,
          subject, from_address, from_domain, from_name, list_unsubscribe,
          flags_json, cached_at
        ) VALUES (
          $accountId, $folder, $uid, $uidValidity, $messageId, $dateReceived,
          $subject, $fromAddress, $fromDomain, $fromName, $listUnsubscribe,
          $flagsJson, $cachedAt
        )
      `);

      const cachedAt = Date.now();
      rawDb.exec('BEGIN');
      try {
        for (const msg of fetched.messages) {
          const row = toCacheRow(accountId, folder, currentUidValidity, cachedAt, msg);
          if (!row) continue;
          insert.run({
            $accountId: row.accountId,
            $folder: row.folder,
            $uid: row.uid,
            $uidValidity: row.uidValidity,
            $messageId: row.messageId,
            $dateReceived: row.dateReceived,
            $subject: row.subject,
            $fromAddress: row.fromAddress,
            $fromDomain: row.fromDomain,
            $fromName: row.fromName,
            $listUnsubscribe: row.listUnsubscribe,
            $flagsJson: JSON.stringify(row.flags),
            $cachedAt: row.cachedAt,
          });
          rowsAdded++;
        }
        rawDb.exec('COMMIT');
      } catch (e) {
        try { rawDb.exec('ROLLBACK'); } catch { /* swallow */ }
        throw e;
      }
    }

    return {
      accountId,
      folder,
      uidValidity: currentUidValidity,
      uidValidityChanged,
      rowsBefore,
      rowsAfter: baseRows + rowsAdded,
      rowsAdded,
      rowsUpdated: 0,                   // INSERT OR REPLACE doesn't distinguish
      durationMs: Date.now() - start,
    };
  }

  /** Throw CacheMissError if the folder has no cached rows. */
  private assertSynced(accountId: string, folder: string): void {
    const row = this.db.getDb().prepare(
      `SELECT 1 FROM messages_cache WHERE account_id = $a AND folder = $f LIMIT 1`
    ).get({ $a: accountId, $f: folder });
    if (!row) throw new CacheMissError(accountId, folder);
  }

  async searchByFromDomain(
    accountId: string,
    folder: string,
    domain: string,
    options: SearchOptions = {},
  ): Promise<CachedMessageRow[]> {
    this.assertSynced(accountId, folder);
    const limit = Math.min(options.limit ?? 50, 1000);
    const params: Record<string, unknown> = {
      $a: accountId,
      $f: folder,
      $d: domain.toLowerCase(),
      $limit: limit,
    };
    let where = `account_id = $a AND folder = $f AND from_domain = $d`;
    if (options.since !== undefined) { where += ` AND date_received >= $since`; params.$since = options.since; }
    if (options.until !== undefined) { where += ` AND date_received <= $until`; params.$until = options.until; }

    const rows = this.db.getDb().prepare(
      `SELECT * FROM messages_cache WHERE ${where}
       ORDER BY date_received DESC LIMIT $limit`
    ).all(params as any) as any[];

    return rows.map(rowFromDb);
  }

  async searchByFromAddress(
    accountId: string,
    folder: string,
    address: string,
    options: SearchOptions = {},
  ): Promise<CachedMessageRow[]> {
    this.assertSynced(accountId, folder);
    const limit = Math.min(options.limit ?? 50, 1000);
    const params: Record<string, unknown> = {
      $a: accountId,
      $f: folder,
      $addr: address.toLowerCase(),
      $limit: limit,
    };
    let where = `account_id = $a AND folder = $f AND from_address = $addr`;
    if (options.since !== undefined) { where += ` AND date_received >= $since`; params.$since = options.since; }
    if (options.until !== undefined) { where += ` AND date_received <= $until`; params.$until = options.until; }

    const rows = this.db.getDb().prepare(
      `SELECT * FROM messages_cache WHERE ${where}
       ORDER BY date_received DESC LIMIT $limit`
    ).all(params as any) as any[];

    return rows.map(rowFromDb);
  }

  /**
   * Full-text search over the cached subject + sender display name + sender
   * address via the messages_cache_fts FTS5 index (#119). Ranked by bm25, then
   * recency. No message bodies are involved — this searches only the header
   * fields already in the cache. Cache miss (folder not synced) throws.
   *
   * The query is tokenized and each term quoted, so FTS5 operators in user
   * input can't change the query semantics or cause a syntax error.
   */
  async searchFullText(
    accountId: string,
    folder: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<CachedMessageRow[]> {
    this.assertSynced(accountId, folder);

    const ftsQuery = String(query ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => '"' + t.replace(/"/g, '""') + '"')
      .join(' ');
    if (!ftsQuery) return [];

    const limit = Math.min(options.limit ?? 50, 1000);
    const params: Record<string, unknown> = {
      $a: accountId,
      $f: folder,
      $q: ftsQuery,
      $limit: limit,
    };
    let extra = '';
    if (options.since !== undefined) { extra += ` AND m.date_received >= $since`; params.$since = options.since; }
    if (options.until !== undefined) { extra += ` AND m.date_received <= $until`; params.$until = options.until; }

    const rows = this.db.getDb().prepare(
      `SELECT m.* FROM messages_cache m
       JOIN messages_cache_fts ON messages_cache_fts.rowid = m.rowid
       WHERE messages_cache_fts MATCH $q
         AND m.account_id = $a AND m.folder = $f${extra}
       ORDER BY bm25(messages_cache_fts), m.date_received DESC
       LIMIT $limit`
    ).all(params as any) as any[];

    return rows.map(rowFromDb);
  }

  async groupBySender(
    accountId: string,
    folder: string,
    options: SearchOptions = {},
  ): Promise<SenderGroupRow[]> {
    this.assertSynced(accountId, folder);
    const limit = Math.min(options.limit ?? 50, 1000);
    const params: Record<string, unknown> = {
      $a: accountId,
      $f: folder,
      $limit: limit,
    };
    let where = `account_id = $a AND folder = $f AND from_address IS NOT NULL`;
    if (options.since !== undefined) { where += ` AND date_received >= $since`; params.$since = options.since; }
    if (options.until !== undefined) { where += ` AND date_received <= $until`; params.$until = options.until; }

    const rows = this.db.getDb().prepare(
      `SELECT
         from_address                                              AS from_address,
         MIN(from_domain)                                          AS from_domain,
         MIN(COALESCE(from_name, ''))                              AS from_name,
         COUNT(*)                                                  AS count,
         MAX(date_received)                                        AS last_seen,
         MAX(CASE WHEN list_unsubscribe IS NOT NULL THEN 1 ELSE 0 END)
                                                                   AS list_unsubscribe_present
       FROM messages_cache
       WHERE ${where}
       GROUP BY from_address
       ORDER BY count DESC, last_seen DESC
       LIMIT $limit`
    ).all(params as any) as Array<{
      from_address: string;
      from_domain: string | null;
      from_name: string;
      count: number;
      last_seen: number | null;
      list_unsubscribe_present: number;
    }>;

    return rows.map(r => ({
      fromAddress: r.from_address,
      fromDomain: r.from_domain ?? '',
      fromName: r.from_name === '' ? null : r.from_name,
      count: r.count,
      lastSeen: r.last_seen ?? 0,
      listUnsubscribePresent: r.list_unsubscribe_present === 1,
    }));
  }

  /** Drop cache rows for one folder or an entire account. Returns rows removed. */
  async invalidate(accountId: string, folder?: string): Promise<number> {
    const rawDb = this.db.getDb();
    const result = folder !== undefined
      ? rawDb.prepare(
          `DELETE FROM messages_cache WHERE account_id = $a AND folder = $f`
        ).run({ $a: accountId, $f: folder })
      : rawDb.prepare(
          `DELETE FROM messages_cache WHERE account_id = $a`
        ).run({ $a: accountId });
    return Number(result.changes ?? 0);
  }

  /** Per-folder cached row count + last sync time. Read-only; safe before sync. */
  async getStatus(accountId: string): Promise<Array<{
    folder: string;
    rowCount: number;
    uidValidity: number;
    lastCachedAt: number;
  }>> {
    const rows = this.db.getDb().prepare(
      `SELECT folder,
              COUNT(*)             AS row_count,
              MIN(uid_validity)    AS uid_validity,
              MAX(cached_at)       AS last_cached_at
       FROM messages_cache
       WHERE account_id = $a
       GROUP BY folder
       ORDER BY folder`
    ).all({ $a: accountId }) as Array<{
      folder: string;
      row_count: number;
      uid_validity: number;
      last_cached_at: number;
    }>;

    return rows.map(r => ({
      folder: r.folder,
      rowCount: r.row_count,
      uidValidity: r.uid_validity,
      lastCachedAt: r.last_cached_at,
    }));
  }
}
