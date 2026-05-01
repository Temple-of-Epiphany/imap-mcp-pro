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
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Date Updated: 2026-04-30
 * Version: 0.1.0
 */

import { DatabaseService } from './database-service.js';
import { ImapService } from './imap-service.js';

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
   *   1. Resolve current UIDVALIDITY from IMAP.
   *   2. If the cache holds rows for this (accountId, folder) at a different
   *      UIDVALIDITY (or fullResync=true), drop those rows.
   *   3. UID FETCH headers for every UID not already in the cache at the
   *      current UIDVALIDITY. Insert rows.
   *   4. Return a report with row counts + duration.
   *
   * @throws AccountNotFoundError, FolderNotFoundError, ImapConnectionError
   */
  async syncFolder(
    _accountId: string,
    _folder: string,
    _options: SyncFolderOptions = {},
  ): Promise<SyncFolderReport> {
    throw new Error('MessageCacheService.syncFolder: not yet implemented (v2.17.0 MVP.1)');
  }

  /**
   * Return cached rows where from_domain matches `domain` (case-insensitive).
   * Throws CacheMissError if the folder has never been synced.
   */
  async searchByFromDomain(
    _accountId: string,
    _folder: string,
    _domain: string,
    _options: SearchOptions = {},
  ): Promise<CachedMessageRow[]> {
    throw new Error('MessageCacheService.searchByFromDomain: not yet implemented (v2.17.0 MVP.1)');
  }

  /**
   * Return cached rows where from_address matches `address` exactly
   * (case-insensitive). Throws CacheMissError if the folder has never been synced.
   */
  async searchByFromAddress(
    _accountId: string,
    _folder: string,
    _address: string,
    _options: SearchOptions = {},
  ): Promise<CachedMessageRow[]> {
    throw new Error('MessageCacheService.searchByFromAddress: not yet implemented (v2.17.0 MVP.1)');
  }

  /**
   * Group cached rows by from_address, return top N senders by message count.
   * Throws CacheMissError if the folder has never been synced.
   */
  async groupBySender(
    _accountId: string,
    _folder: string,
    _options: SearchOptions = {},
  ): Promise<SenderGroupRow[]> {
    throw new Error('MessageCacheService.groupBySender: not yet implemented (v2.17.0 MVP.1)');
  }

  /**
   * Drop cache rows for one folder (folder=string) or an entire account
   * (folder=undefined). Returns the number of rows removed.
   */
  async invalidate(_accountId: string, _folder?: string): Promise<number> {
    throw new Error('MessageCacheService.invalidate: not yet implemented (v2.17.0 MVP.1)');
  }

  /**
   * Diagnostic: per-folder cached row count + last sync time.
   * Read-only; safe to call before any sync has happened (returns []).
   */
  async getStatus(_accountId: string): Promise<Array<{
    folder: string;
    rowCount: number;
    uidValidity: number;
    lastCachedAt: number;
  }>> {
    throw new Error('MessageCacheService.getStatus: not yet implemented (v2.17.0 MVP.1)');
  }
}
