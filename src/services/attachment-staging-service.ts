/**
 * AttachmentStagingService — chunked attachment uploads
 *
 * For clients that can't reach the server's filesystem (web client, remote
 * MCP, Windows talking to a Linux server). Workflow:
 *
 *   1. init     → returns stagingId, recommended chunkSizeBytes, expiresAt
 *   2. append × → upload chunks, optionally out-of-order, idempotent on
 *                 duplicate chunkIndex
 *   3. finalize → assemble chunks in order, compute SHA-256, mark ready
 *   4. (the staged blob is consumed by imap_send_email and cleaned up)
 *   ── or ──
 *   3'. cancel  → discard the session, free the disk
 *
 * Chunks live on disk under {stagingDir}/{userId}/{stagingId}/chunk-NNNNNN.bin.
 * Finalize concatenates them into ./assembled.bin (next to the chunks).
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Version: 0.1.0
 *
 * Tracker: #97. Issue: #101 (WP2).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseService } from './database-service.js';

export interface StagingConfig {
  /** Filesystem root for staging sessions. */
  stagingDir: string;
  /** Default TTL applied at init. */
  defaultTtlMs: number;
  /** Recommended chunk size returned to the client at init. */
  chunkSizeBytes: number;
  /** Per-user disk quota in bytes. init refuses to start a session that would exceed it. */
  perUserMaxBytes: number;
  /** GC sweep cadence. */
  cleanupIntervalMs: number;
}

export const DEFAULT_STAGING_CONFIG: StagingConfig = {
  stagingDir: '',         // populated from ServerConfig at construction time
  defaultTtlMs: 60 * 60 * 1000,    // 1 hour
  chunkSizeBytes: 256 * 1024,      // 256 KiB
  perUserMaxBytes: 500 * 1024 * 1024, // 500 MiB
  cleanupIntervalMs: 15 * 60 * 1000,  // 15 min
};

export interface StagingInitInput {
  userId: string;
  filename: string;
  contentType?: string;
  expectedSize: number;
  ttlMs?: number;
}

export interface StagingInitResult {
  stagingId: string;
  chunkSizeBytes: number;
  expiresAt: string;
}

export interface StagingAppendInput {
  stagingId: string;
  chunkIndex: number;        // 0-indexed
  chunkData: string;         // base64
  isFinal?: boolean;
}

export interface StagingAppendResult {
  bytesReceived: number;
  chunksReceived: number;
  complete: boolean;
}

export interface StagingFinalizeResult {
  stagingId: string;
  size: number;
  sha256: string;
  filename: string;
  contentType: string;
}

export interface StagingRow {
  staging_id: string;
  user_id: string;
  filename: string;
  content_type: string;
  expected_size: number;
  current_size: number;
  chunks_received: number;
  storage_dir: string;
  assembled_path: string | null;
  created_at: number;
  expires_at: number;
  finalized: number;        // 0/1
  finalized_at: number | null;
  sha256: string | null;
  consumed_at: number | null;
}

const CHUNK_NAME = (i: number) => `chunk-${String(i).padStart(6, '0')}.bin`;

export class StagingNotFoundError extends Error {
  constructor(public readonly stagingId: string) {
    super(`Staging session not found: ${stagingId}`);
    this.name = 'StagingNotFoundError';
  }
}

export class StagingExpiredError extends Error {
  constructor(public readonly stagingId: string) {
    super(`Staging session expired: ${stagingId}`);
    this.name = 'StagingExpiredError';
  }
}

export class StagingFinalizedError extends Error {
  constructor(public readonly stagingId: string) {
    super(`Staging session already finalized: ${stagingId}`);
    this.name = 'StagingFinalizedError';
  }
}

export class StagingQuotaError extends Error {
  constructor(public readonly userId: string, public readonly currentBytes: number, public readonly limitBytes: number) {
    super(`User ${userId} would exceed staging quota: ${currentBytes}/${limitBytes} bytes`);
    this.name = 'StagingQuotaError';
  }
}

export class AttachmentStagingService {
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: DatabaseService,
    private config: StagingConfig
  ) {}

  // ---------- public API ----------

  async init(input: StagingInitInput): Promise<StagingInitResult> {
    if (!input.userId) throw new Error('userId is required');
    if (!input.filename) throw new Error('filename is required');
    if (!Number.isFinite(input.expectedSize) || input.expectedSize < 0) {
      throw new Error('expectedSize must be a non-negative integer');
    }

    // Quota pre-check: include `expectedSize` of the new session against
    // the user's current usage (active + finalized but not consumed).
    const current = this.userBytesInUse(input.userId);
    if (current + input.expectedSize > this.config.perUserMaxBytes) {
      throw new StagingQuotaError(input.userId, current + input.expectedSize, this.config.perUserMaxBytes);
    }

    const stagingId = crypto.randomUUID();
    const userDir = path.join(this.config.stagingDir, input.userId);
    const sessionDir = path.join(userDir, stagingId);
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const now = Date.now();
    const ttl = input.ttlMs ?? this.config.defaultTtlMs;
    const expiresAt = now + ttl;

    this.db.getDb().prepare(`
      INSERT INTO attachment_staging
        (staging_id, user_id, filename, content_type, expected_size,
         current_size, chunks_received, storage_dir, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    `).run(
      stagingId,
      input.userId,
      input.filename,
      input.contentType ?? 'application/octet-stream',
      input.expectedSize,
      sessionDir,
      now,
      expiresAt,
    );

    return {
      stagingId,
      chunkSizeBytes: this.config.chunkSizeBytes,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async append(input: StagingAppendInput): Promise<StagingAppendResult> {
    const row = this.fetchActive(input.stagingId);

    if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) {
      throw new Error('chunkIndex must be a non-negative integer');
    }
    if (typeof input.chunkData !== 'string') {
      throw new Error('chunkData must be a base64 string');
    }

    const buf = Buffer.from(input.chunkData, 'base64');
    const chunkPath = path.join(row.storage_dir, CHUNK_NAME(input.chunkIndex));

    // Idempotency: if the same chunkIndex already exists with the same byte
    // length, treat as no-op. Otherwise overwrite (allows clients to retry
    // a corrupted chunk by re-uploading).
    let existingSize: number | null = null;
    try {
      existingSize = (await fs.promises.stat(chunkPath)).size;
    } catch {
      existingSize = null;
    }

    if (existingSize === buf.length) {
      // exact duplicate — no DB update needed beyond bumping last-seen
    } else {
      await fs.promises.writeFile(chunkPath, buf);
      // Recompute current_size and chunks_received from disk so out-of-order
      // and duplicate writes converge to the truth.
      const { totalBytes, chunkCount } = await this.scanDir(row.storage_dir);
      this.db.getDb().prepare(`
        UPDATE attachment_staging
        SET current_size = ?, chunks_received = ?
        WHERE staging_id = ?
      `).run(totalBytes, chunkCount, input.stagingId);
      row.current_size = totalBytes;
      row.chunks_received = chunkCount;
    }

    let complete = false;
    if (input.isFinal === true) {
      // Auto-finalize: caller asserts no more chunks are coming.
      await this.finalize({ stagingId: input.stagingId });
      complete = true;
    }

    return {
      bytesReceived: row.current_size,
      chunksReceived: row.chunks_received,
      complete,
    };
  }

  async finalize(input: { stagingId: string }): Promise<StagingFinalizeResult> {
    const row = this.fetchActive(input.stagingId);

    // Assemble in chunkIndex order. Use a streaming hash so we don't have
    // to load the whole blob into memory.
    const entries = (await fs.promises.readdir(row.storage_dir))
      .filter((n) => /^chunk-\d{6}\.bin$/.test(n))
      .sort();

    if (entries.length === 0) {
      throw new Error(`No chunks received for staging session ${input.stagingId}`);
    }

    const assembledPath = path.join(row.storage_dir, 'assembled.bin');
    const out = fs.createWriteStream(assembledPath);
    const hash = crypto.createHash('sha256');
    let totalBytes = 0;
    try {
      for (const name of entries) {
        const data = await fs.promises.readFile(path.join(row.storage_dir, name));
        hash.update(data);
        totalBytes += data.length;
        if (!out.write(data)) {
          await new Promise<void>((r) => out.once('drain', () => r()));
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    const sha256 = hash.digest('hex');

    const now = Date.now();
    this.db.getDb().prepare(`
      UPDATE attachment_staging
      SET assembled_path = ?, current_size = ?, finalized = 1,
          finalized_at = ?, sha256 = ?
      WHERE staging_id = ?
    `).run(assembledPath, totalBytes, now, sha256, input.stagingId);

    return {
      stagingId: input.stagingId,
      size: totalBytes,
      sha256,
      filename: row.filename,
      contentType: row.content_type,
    };
  }

  async cancel(stagingId: string): Promise<void> {
    const row = this.fetchRowOrThrow(stagingId);
    await this.deleteSessionFiles(row.storage_dir);
    this.db.getDb()
      .prepare('DELETE FROM attachment_staging WHERE staging_id = ?')
      .run(stagingId);
  }

  /**
   * Look up a finalized session for use in imap_send_email. Verifies the
   * caller (`userId`) owns the session; returns the assembled file path
   * and metadata. Does NOT delete — the caller passes consumeAfterUse=true
   * to remove on success.
   */
  getFinalized(userId: string, stagingId: string): {
    assembledPath: string;
    filename: string;
    contentType: string;
    size: number;
    sha256: string;
  } | null {
    const row = this.fetchRow(stagingId);
    if (!row) return null;
    if (row.user_id !== userId) return null;
    if (!row.finalized || !row.assembled_path || !row.sha256) return null;
    if (row.expires_at < Date.now()) return null;
    if (row.consumed_at !== null) return null;
    return {
      assembledPath: row.assembled_path,
      filename: row.filename,
      contentType: row.content_type,
      size: row.current_size,
      sha256: row.sha256,
    };
  }

  /** Mark a finalized session as consumed and delete its files. */
  async consume(stagingId: string): Promise<void> {
    const row = this.fetchRow(stagingId);
    if (!row) return;
    await this.deleteSessionFiles(row.storage_dir);
    this.db.getDb().prepare(`
      UPDATE attachment_staging SET consumed_at = ? WHERE staging_id = ?
    `).run(Date.now(), stagingId);
  }

  /** Listing for diagnostic / quota inspection. */
  list(opts: { userId?: string; limit?: number } = {}): StagingRow[] {
    const limit = opts.limit ?? 100;
    let where = 'WHERE 1 = 1';
    const params: (string | number)[] = [];
    if (opts.userId) {
      where += ' AND user_id = ?';
      params.push(opts.userId);
    }
    const rows = this.db.getDb()
      .prepare(`SELECT * FROM attachment_staging ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as StagingRow[];
    return rows;
  }

  /** Sum of bytes used by sessions that haven't been consumed yet. */
  userBytesInUse(userId: string): number {
    const row = this.db.getDb()
      .prepare(`
        SELECT COALESCE(SUM(current_size), 0) AS total
        FROM attachment_staging
        WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?
      `)
      .get(userId, Date.now()) as { total: number };
    return row.total;
  }

  // ---------- garbage collection ----------

  /** Run one GC pass. Drops expired sessions plus orphaned dirs. */
  async gcTick(): Promise<{ expiredSessions: number; orphanDirs: number }> {
    const now = Date.now();
    const expiredRows = this.db.getDb()
      .prepare('SELECT staging_id, storage_dir FROM attachment_staging WHERE expires_at <= ? AND consumed_at IS NULL')
      .all(now) as Array<{ staging_id: string; storage_dir: string }>;
    for (const r of expiredRows) {
      try { await this.deleteSessionFiles(r.storage_dir); } catch {}
    }
    if (expiredRows.length > 0) {
      this.db.getDb()
        .prepare('DELETE FROM attachment_staging WHERE expires_at <= ? AND consumed_at IS NULL')
        .run(now);
    }

    // Also clean DB rows that are consumed and older than 24h (housekeeping)
    this.db.getDb()
      .prepare('DELETE FROM attachment_staging WHERE consumed_at IS NOT NULL AND consumed_at < ?')
      .run(now - 24 * 60 * 60 * 1000);

    return { expiredSessions: expiredRows.length, orphanDirs: 0 };
  }

  start(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => {
      this.gcTick().catch((e) => {
        process.stderr.write(`[staging-gc] tick failed: ${e?.message ?? e}\n`);
      });
    }, this.config.cleanupIntervalMs);
    if (typeof this.gcTimer.unref === 'function') this.gcTimer.unref();
  }

  stop(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  // ---------- internals ----------

  private fetchRow(stagingId: string): StagingRow | null {
    const row = this.db.getDb()
      .prepare('SELECT * FROM attachment_staging WHERE staging_id = ?')
      .get(stagingId) as StagingRow | undefined;
    return row ?? null;
  }

  private fetchRowOrThrow(stagingId: string): StagingRow {
    const row = this.fetchRow(stagingId);
    if (!row) throw new StagingNotFoundError(stagingId);
    return row;
  }

  private fetchActive(stagingId: string): StagingRow {
    const row = this.fetchRowOrThrow(stagingId);
    if (row.expires_at < Date.now()) throw new StagingExpiredError(stagingId);
    if (row.finalized) throw new StagingFinalizedError(stagingId);
    return row;
  }

  private async scanDir(dir: string): Promise<{ totalBytes: number; chunkCount: number }> {
    let totalBytes = 0;
    let chunkCount = 0;
    const entries = await fs.promises.readdir(dir);
    for (const e of entries) {
      if (!/^chunk-\d{6}\.bin$/.test(e)) continue;
      const s = await fs.promises.stat(path.join(dir, e));
      totalBytes += s.size;
      chunkCount++;
    }
    return { totalBytes, chunkCount };
  }

  private async deleteSessionFiles(dir: string): Promise<void> {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
