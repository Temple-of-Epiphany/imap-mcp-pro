/**
 * Results Service
 *
 * Implements the resource-handle pattern for MCP tool responses:
 *  - Bulk results are stored under a small `result_id`
 *  - Tools return a tiny envelope (resultId + summary + first-N preview)
 *  - Full data is fetched via paginated API
 *
 * Storage modes:
 *   - 'inline'    rows_json BLOB in SQLite (encrypted with AES-256-GCM)
 *   - 'file'      JSON / JSONL on disk via FileExportService (encrypted)
 *
 * Storage types:
 *   - 'temp'        TTL-bound (default 2h), counts toward quota, auto-cleaned
 *   - 'persistent'  user-retained, no expiry, only deleted explicitly
 *
 * Author: Temple of Epiphany
 * Date: 2026-04-18
 */

import crypto from 'crypto';
import path from 'path';
import { ContextReductionConfig as Cfg } from '../config/context-reduction.js';
import { DatabaseService } from './database-service.js';
import { FileExportService } from './file-export-service.js';

export type StorageMode = 'inline' | 'file';
export type StorageType = 'temp' | 'persistent';

export interface StoredResultRowSummary {
  uid?: number;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  flags?: string[];
  preview?: string;
  size?: number;
  hasAttachments?: boolean;
  [k: string]: unknown;
}

export interface StoredResultFacets {
  topSenders?: Array<{ from: string; count: number }>;
  unreadCount?: number;
  flaggedCount?: number;
  attachmentCount?: number;
  dateRange?: { earliest?: string; latest?: string };
}

export interface StoredResultEnvelope {
  resultId: string;
  toolName: string;
  folder?: string | null;
  rowCount: number;
  storageMode: StorageMode;
  storageType: StorageType;
  filePath?: string | null;
  fileSizeBytes?: number | null;
  createdAt: string;
  expiresAt: string | null;
  firstN: StoredResultRowSummary[];
  facets?: StoredResultFacets;
}

export interface StoreResultInput {
  userId: string;
  accountId?: string | null;
  toolName: string;
  folder?: string | null;
  params: unknown;
  rows: StoredResultRowSummary[];
  storageType?: StorageType;          // default: 'temp'
  ttlMs?: number;                     // override default TTL (temp only)
  forceFile?: boolean;
  facets?: StoredResultFacets;
}

export interface StoreResultOutput {
  resultId: string;
  envelope: StoredResultEnvelope;
}

export interface PageResult {
  resultId: string;
  total: number;
  offset: number;
  limit: number;
  rows: StoredResultRowSummary[];
  nextOffset: number | null;
}

interface ToolResultRow {
  result_id: string;
  user_id: string;
  account_id: string | null;
  tool_name: string;
  folder: string | null;
  params_json: string;
  summary_json: string;
  storage_mode: StorageMode;
  storage_type: StorageType;
  rows_json: Buffer | null;
  rows_iv: string | null;
  file_path: string | null;
  file_size_bytes: number | null;
  row_count: number;
  schema_version: number;
  created_at: number;
  expires_at: number | null;
  last_accessed_at: number;
  access_count: number;
}

export class ResultNotFoundError extends Error {
  constructor(resultId: string) {
    super(`Result not found or not accessible: ${resultId}`);
    this.name = 'ResultNotFoundError';
  }
}

export class ResultsService {
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private db: DatabaseService,
    private fileExport: FileExportService
  ) {
    this.startCleanupTimer();
  }

  // ---------- store ----------

  async storeResult(input: StoreResultInput): Promise<StoreResultOutput> {
    const resultId = crypto.randomUUID();
    const now = Date.now();
    const storageType: StorageType = input.storageType ?? 'temp';
    const expiresAt =
      storageType === 'persistent'
        ? null
        : now + (input.ttlMs ?? Cfg.RESULT_TTL_MS);

    const rowCount = input.rows.length;
    const facets = input.facets ?? this.computeFacets(input.rows);
    const firstN = input.rows.slice(0, Cfg.FIRST_N_PREVIEW_ROWS);

    // Decide storage mode
    const serialized = JSON.stringify(input.rows);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const useFile =
      input.forceFile === true ||
      rowCount > Cfg.FILE_THRESHOLD ||
      bytes > Cfg.INLINE_BYTE_BUDGET;

    let storageMode: StorageMode;
    let rowsBlob: Buffer | null = null;
    let rowsIv: string | null = null;
    let filePath: string | null = null;
    let fileSize: number | null = null;

    if (useFile) {
      storageMode = 'file';
      const written = await this.fileExport.writeRows(input.userId, resultId, input.rows);
      filePath = written.filePath;
      fileSize = written.size;
    } else {
      storageMode = 'inline';
      const enc = this.db.encryptString(serialized);
      // enc.encrypted is hex(ciphertext) + hex(authTag); store as one blob,
      // round-trip via Buffer<->hex on read.
      rowsBlob = Buffer.from(enc.encrypted, 'hex');
      rowsIv = enc.iv;
    }

    const summary: StoredResultEnvelope = {
      resultId,
      toolName: input.toolName,
      folder: input.folder ?? null,
      rowCount,
      storageMode,
      storageType,
      filePath,
      fileSizeBytes: fileSize,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      firstN,
      facets,
    };

    const stmt = this.db.getDb().prepare(`
      INSERT INTO tool_results (
        result_id, user_id, account_id, tool_name, folder, params_json, summary_json,
        storage_mode, storage_type, rows_json, rows_iv, file_path, file_size_bytes,
        row_count, schema_version, created_at, expires_at, last_accessed_at, access_count
      ) VALUES (
        $result_id, $user_id, $account_id, $tool_name, $folder, $params_json, $summary_json,
        $storage_mode, $storage_type, $rows_json, $rows_iv, $file_path, $file_size_bytes,
        $row_count, $schema_version, $created_at, $expires_at, $last_accessed_at, $access_count
      )
    `);

    stmt.run({
      result_id: resultId,
      user_id: input.userId,
      account_id: input.accountId ?? null,
      tool_name: input.toolName,
      folder: input.folder ?? null,
      params_json: JSON.stringify(input.params ?? {}),
      summary_json: JSON.stringify(summary),
      storage_mode: storageMode,
      storage_type: storageType,
      rows_json: rowsBlob,
      rows_iv: rowsIv,
      file_path: filePath,
      file_size_bytes: fileSize,
      row_count: rowCount,
      schema_version: 1,
      created_at: now,
      expires_at: expiresAt,
      last_accessed_at: now,
      access_count: 0,
    });

    await this.enforceUserCap(input.userId);

    return { resultId, envelope: summary };
  }

  // ---------- read ----------

  getEnvelope(userId: string, resultId: string): StoredResultEnvelope | null {
    const row = this.fetchRow(userId, resultId);
    if (!row) return null;
    try {
      return JSON.parse(row.summary_json) as StoredResultEnvelope;
    } catch {
      return null;
    }
  }

  async getPage(
    userId: string,
    resultId: string,
    offset: number,
    limit: number
  ): Promise<PageResult> {
    const row = this.fetchRow(userId, resultId);
    if (!row) throw new ResultNotFoundError(resultId);

    this.touch(resultId);

    let rows: StoredResultRowSummary[];
    if (row.storage_mode === 'file') {
      if (!row.file_path) throw new Error(`Result ${resultId} marked file-mode but has no path`);
      rows = (await this.fileExport.readRowsSlice(row.file_path, offset, limit)) as StoredResultRowSummary[];
    } else {
      if (!row.rows_json || !row.rows_iv) {
        throw new Error(`Result ${resultId} marked inline but missing rows_json/iv`);
      }
      // node:sqlite returns BLOB as Uint8Array (not Node Buffer); coerce so
      // .toString('hex') uses Buffer's encoding-aware impl.
      const blob = Buffer.isBuffer(row.rows_json)
        ? row.rows_json
        : Buffer.from(row.rows_json as Uint8Array);
      const plain = this.db.decryptString(blob.toString('hex'), row.rows_iv);
      const all = JSON.parse(plain) as StoredResultRowSummary[];
      rows = all.slice(offset, offset + limit);
    }

    const total = row.row_count;
    const nextOffset = offset + rows.length < total ? offset + rows.length : null;
    return { resultId, total, offset, limit, rows, nextOffset };
  }

  listResults(
    userId: string,
    opts: { limit?: number; toolName?: string; storageType?: StorageType } = {}
  ): StoredResultEnvelope[] {
    const limit = opts.limit ?? 20;
    const params: (string | number)[] = [userId];
    let where = 'user_id = ?';
    if (opts.toolName) {
      where += ' AND tool_name = ?';
      params.push(opts.toolName);
    }
    if (opts.storageType) {
      where += ' AND storage_type = ?';
      params.push(opts.storageType);
    }

    const stmt = this.db.getDb().prepare(`
      SELECT summary_json FROM tool_results
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    params.push(limit);
    const rows = stmt.all(...params) as Array<{ summary_json: string }>;
    return rows.map(r => JSON.parse(r.summary_json) as StoredResultEnvelope);
  }

  // ---------- mutate ----------

  async deleteResult(userId: string, resultId: string): Promise<void> {
    const row = this.fetchRow(userId, resultId);
    if (!row) return;

    if (row.storage_mode === 'file') {
      try {
        await this.fileExport.deleteResultDir(userId, resultId);
      } catch (e) {
        console.error('[ResultsService] Failed to delete file dir:', e);
      }
    }

    this.db.getDb().prepare('DELETE FROM tool_results WHERE result_id = ? AND user_id = ?')
      .run(resultId, userId);
  }

  /**
   * Promote a temp result to persistent (clears expires_at).
   * Returns the updated envelope.
   */
  persistResult(userId: string, resultId: string): StoredResultEnvelope {
    const row = this.fetchRow(userId, resultId);
    if (!row) throw new ResultNotFoundError(resultId);

    if (row.storage_type === 'persistent') {
      return JSON.parse(row.summary_json) as StoredResultEnvelope;
    }

    const updatedSummary: StoredResultEnvelope = {
      ...(JSON.parse(row.summary_json) as StoredResultEnvelope),
      storageType: 'persistent',
      expiresAt: null,
    };

    this.db.getDb().prepare(`
      UPDATE tool_results
      SET storage_type = 'persistent',
          expires_at = NULL,
          summary_json = ?
      WHERE result_id = ? AND user_id = ?
    `).run(JSON.stringify(updatedSummary), resultId, userId);

    return updatedSummary;
  }

  // ---------- attachments ----------

  recordAttachment(opts: {
    resultId: string;
    messageUid?: number;
    filename: string;
    contentType?: string;
    sizeBytes: number;
    filePath: string;
    fileIv: string;
    checksum?: string;
    skipped?: boolean;
  }): string {
    const attachmentId = crypto.randomUUID();
    this.db.getDb().prepare(`
      INSERT INTO result_attachments (
        attachment_id, result_id, message_uid, filename, content_type,
        size_bytes, file_path, file_iv, checksum_sha256, skipped, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attachmentId,
      opts.resultId,
      opts.messageUid ?? null,
      opts.filename,
      opts.contentType ?? null,
      opts.sizeBytes,
      opts.filePath,
      opts.fileIv,
      opts.checksum ?? null,
      opts.skipped ? 1 : 0,
      Date.now()
    );
    return attachmentId;
  }

  listAttachments(userId: string, resultId: string, messageUid?: number): Array<{
    attachment_id: string;
    message_uid: number | null;
    filename: string;
    content_type: string | null;
    size_bytes: number;
    file_path: string;
    file_iv: string;
    checksum_sha256: string | null;
    skipped: number;
  }> {
    // User-isolation: ensure the caller owns the result before returning
    // any attachment rows. Joining through tool_results prevents user A from
    // enumerating user B's attachments by guessing a resultId.
    if (messageUid !== undefined) {
      return this.db.getDb().prepare(`
        SELECT a.attachment_id, a.message_uid, a.filename, a.content_type,
               a.size_bytes, a.file_path, a.file_iv, a.checksum_sha256, a.skipped
        FROM result_attachments a
        INNER JOIN tool_results r ON r.result_id = a.result_id
        WHERE a.result_id = ? AND a.message_uid = ? AND r.user_id = ?
      `).all(resultId, messageUid, userId) as any;
    }
    return this.db.getDb().prepare(`
      SELECT a.attachment_id, a.message_uid, a.filename, a.content_type,
             a.size_bytes, a.file_path, a.file_iv, a.checksum_sha256, a.skipped
      FROM result_attachments a
      INNER JOIN tool_results r ON r.result_id = a.result_id
      WHERE a.result_id = ? AND r.user_id = ?
    `).all(resultId, userId) as any;
  }

  // ---------- internals ----------

  private fetchRow(userId: string, resultId: string): ToolResultRow | null {
    const row = this.db.getDb().prepare(`
      SELECT * FROM tool_results WHERE result_id = ? AND user_id = ?
    `).get(resultId, userId) as ToolResultRow | undefined;
    return row ?? null;
  }

  private touch(resultId: string): void {
    this.db.getDb().prepare(`
      UPDATE tool_results
      SET last_accessed_at = ?, access_count = access_count + 1
      WHERE result_id = ?
    `).run(Date.now(), resultId);
  }

  private async enforceUserCap(userId: string): Promise<void> {
    // Only consider 'temp' results for the cap; persistent results are user-managed.
    const overflow = this.db.getDb().prepare(`
      SELECT result_id FROM tool_results
      WHERE user_id = ? AND storage_type = 'temp'
      ORDER BY last_accessed_at ASC
    `).all(userId) as Array<{ result_id: string }>;

    if (overflow.length <= Cfg.MAX_RESULTS_PER_USER) return;
    const toEvict = overflow.slice(0, overflow.length - Cfg.MAX_RESULTS_PER_USER);
    for (const r of toEvict) {
      try {
        await this.deleteResult(userId, r.result_id);
      } catch (e) {
        console.error('[ResultsService] Eviction failed for', r.result_id, e);
      }
    }
  }

  private computeFacets(rows: StoredResultRowSummary[]): StoredResultFacets {
    if (!rows.length) return {};
    const senderCounts = new Map<string, number>();
    let unread = 0, flagged = 0, withAtt = 0;
    let earliest: string | undefined;
    let latest: string | undefined;
    for (const r of rows) {
      if (r.from) senderCounts.set(r.from, (senderCounts.get(r.from) ?? 0) + 1);
      if (r.flags && !r.flags.includes('\\Seen')) unread += 1;
      if (r.flags && r.flags.includes('\\Flagged')) flagged += 1;
      if (r.hasAttachments) withAtt += 1;
      if (r.date) {
        if (!earliest || r.date < earliest) earliest = r.date;
        if (!latest || r.date > latest) latest = r.date;
      }
    }
    const topSenders = [...senderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([from, count]) => ({ from, count }));
    return {
      topSenders,
      unreadCount: unread,
      flaggedCount: flagged,
      attachmentCount: withAtt,
      dateRange: { earliest, latest },
    };
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch(e =>
        console.error('[ResultsService] cleanup error:', e)
      );
    }, Cfg.CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const expired = this.db.getDb().prepare(`
      SELECT user_id, result_id FROM tool_results
      WHERE storage_type = 'temp' AND expires_at IS NOT NULL AND expires_at < ?
    `).all(now) as Array<{ user_id: string; result_id: string }>;

    for (const r of expired) {
      try {
        await this.deleteResult(r.user_id, r.result_id);
      } catch (e) {
        console.error('[ResultsService] expired-cleanup failed:', r.result_id, e);
      }
    }
    if (expired.length) {
      console.error(`[ResultsService] Cleaned up ${expired.length} expired result(s)`);
    }
  }

  /**
   * Enumerate the on-disk paths that should be retained.
   * Used by FileExportService.sweepOrphans on startup.
   */
  knownResultPaths(): Set<string> {
    const rows = this.db.getDb().prepare(`
      SELECT user_id, result_id FROM tool_results WHERE storage_mode = 'file'
    `).all() as Array<{ user_id: string; result_id: string }>;
    const root = Cfg.RESULTS_ROOT_DIR;
    const set = new Set<string>();
    for (const r of rows) {
      set.add(path.join(root, r.user_id, r.result_id));
    }
    return set;
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}
