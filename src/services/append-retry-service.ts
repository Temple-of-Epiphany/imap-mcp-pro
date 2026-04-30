/**
 * AppendRetryService — durable retry queue for failed Sent-folder APPENDs
 *
 * When SMTP send succeeds but the IMAP APPEND to the Sent folder fails
 * (transient IMAP error, server unreachable, mailbox locked, etc.), the
 * message MIME bytes are queued here. A background timer retries every
 * 5 minutes for up to 24 hours, then drops the entry. Bytes are stored
 * AES-256-GCM encrypted at rest.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Version: 0.1.0
 *
 * Tracker: #97. Issue: #98.
 */

import { DatabaseService } from './database-service.js';
import { ImapService } from './imap-service.js';

export interface EnqueueRequest {
  accountId: string;
  targetFolder: string;
  messageBytes: Buffer;
  flags: string[];
  internalDate: Date;
  /** Override the default 24h expiry. */
  expiresAtMs?: number;
}

export interface QueuedAppend {
  id: number;
  accountId: string;
  targetFolder: string;
  flags: string[];
  internalDate: Date;
  createdAt: Date;
  lastAttemptAt: Date | null;
  attemptCount: number;
  lastError: string | null;
  expiresAt: Date;
}

const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ATTEMPTS_PER_TICK = 10; // limit per tick to avoid bursts

export class AppendRetryService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DatabaseService,
    private imap: ImapService
  ) {}

  /** Add an entry to the queue. Encrypts the message bytes at rest. */
  async enqueue(req: EnqueueRequest): Promise<QueuedAppend> {
    const now = Date.now();
    const expiresAt = now + (req.expiresAtMs ?? DEFAULT_EXPIRY_MS);
    const enc = this.db.encryptString(req.messageBytes.toString('latin1'));
    // Use latin1 to round-trip arbitrary bytes through string. JS strings
    // are UCS-2; latin1 maps each byte to one code unit so we don't lose
    // any byte even if the MIME has 8-bit content.

    const result = this.db.getDb().prepare(`
      INSERT INTO append_retry_queue
        (account_id, target_folder, message_bytes, message_iv, flags,
         internal_date, created_at, expires_at, attempt_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      req.accountId,
      req.targetFolder,
      Buffer.from(enc.encrypted, 'hex'),
      enc.iv,
      JSON.stringify(req.flags),
      req.internalDate.getTime(),
      now,
      expiresAt
    );

    return {
      id: Number(result.lastInsertRowid),
      accountId: req.accountId,
      targetFolder: req.targetFolder,
      flags: req.flags,
      internalDate: req.internalDate,
      createdAt: new Date(now),
      lastAttemptAt: null,
      attemptCount: 0,
      lastError: null,
      expiresAt: new Date(expiresAt),
    };
  }

  /** Read-only listing for diagnostics / the imap_list_unarchived_sends tool. */
  list(opts: { accountId?: string; limit?: number } = {}): QueuedAppend[] {
    const limit = opts.limit ?? 100;
    let where = 'WHERE expires_at > ?';
    const params: (string | number)[] = [Date.now()];
    if (opts.accountId) {
      where += ' AND account_id = ?';
      params.push(opts.accountId);
    }
    const rows = this.db.getDb()
      .prepare(`
        SELECT id, account_id, target_folder, flags, internal_date, created_at,
               last_attempt_at, attempt_count, last_error, expires_at
        FROM append_retry_queue
        ${where}
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(...params, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      targetFolder: r.target_folder,
      flags: JSON.parse(r.flags),
      internalDate: new Date(r.internal_date),
      createdAt: new Date(r.created_at),
      lastAttemptAt: r.last_attempt_at ? new Date(r.last_attempt_at) : null,
      attemptCount: r.attempt_count,
      lastError: r.last_error,
      expiresAt: new Date(r.expires_at),
    }));
  }

  /** Run one retry tick. Public so tests can drive it deterministically. */
  async tick(): Promise<{ attempted: number; succeeded: number; failed: number; expired: number }> {
    const now = Date.now();

    // Drop expired entries first.
    const expired = this.db.getDb()
      .prepare('DELETE FROM append_retry_queue WHERE expires_at <= ?')
      .run(now).changes;

    const due = this.db.getDb()
      .prepare(`
        SELECT id, account_id, target_folder, message_bytes, message_iv, flags, internal_date
        FROM append_retry_queue
        WHERE expires_at > ?
        ORDER BY COALESCE(last_attempt_at, 0) ASC
        LIMIT ?
      `)
      .all(now, MAX_ATTEMPTS_PER_TICK) as any[];

    let succeeded = 0;
    let failed = 0;
    for (const row of due) {
      try {
        const plain = this.db.decryptString(
          (row.message_bytes as Buffer).toString('hex'),
          row.message_iv
        );
        const flags = JSON.parse(row.flags);
        await this.imap.appendMessage(
          row.account_id,
          row.target_folder,
          plain, // latin1 round-trip preserved bytes
          { flags, internalDate: new Date(row.internal_date) }
        );
        // Success: drop from queue.
        this.db.getDb()
          .prepare('DELETE FROM append_retry_queue WHERE id = ?')
          .run(row.id);
        succeeded++;
      } catch (e: any) {
        failed++;
        this.db.getDb()
          .prepare(`
            UPDATE append_retry_queue
            SET last_attempt_at = ?, attempt_count = attempt_count + 1, last_error = ?
            WHERE id = ?
          `)
          .run(Date.now(), String(e?.message ?? e), row.id);
      }
    }

    return { attempted: due.length, succeeded, failed, expired };
  }

  /** Start the background retry timer. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        process.stderr.write(`[append-retry] tick failed: ${e?.message ?? e}\n`);
      });
    }, RETRY_INTERVAL_MS);
    // Don't keep the event loop alive for this timer alone.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the background timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
