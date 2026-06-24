// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// BulkJobService — persistent job state for long-running bulk operations (#117).
//
// Persists JOB STATE (not message content) in SQLite so a bulk scan can be
// polled, cancelled, and resumed. Items are keyed by a stable item_key (e.g. a
// normalized sender address); a resumed job skips every already-processed key.
//
// Execution model: in-process. A tool starts a job and calls runJob(); it may
// await with a time budget (sync shim) or let it continue in the background.
// Cancellation is cooperative — runJob re-reads the job status each item and
// stops at the next checkpoint when it sees 'cancelled'.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)

import crypto from 'crypto';
import { DatabaseService } from './database-service.js';

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type ItemOutcome = 'ok' | 'skip' | 'error';

export interface BulkJob {
  jobId: string;
  userId: string;
  accountId: string;
  toolName: string;
  params: unknown;
  status: JobStatus;
  totalItems: number | null;
  doneItems: number;
  errorItems: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
  resultSummary: unknown | null;
}

export interface ItemResult {
  outcome: ItemOutcome;
  result?: unknown;
  error?: string;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(['done', 'failed', 'cancelled']);

function rowToJob(r: any): BulkJob {
  return {
    jobId: r.job_id,
    userId: r.user_id,
    accountId: r.account_id,
    toolName: r.tool_name,
    params: r.params_json ? safeParse(r.params_json) : null,
    status: r.status,
    totalItems: r.total_items ?? null,
    doneItems: r.done_items ?? 0,
    errorItems: r.error_items ?? 0,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    lastError: r.last_error ?? null,
    resultSummary: r.result_summary_json ? safeParse(r.result_summary_json) : null,
  };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export class BulkJobService {
  constructor(private db: DatabaseService, private nowFn: () => number = () => Date.now()) {}

  /** Create a queued job; returns its id. */
  createJob(input: { userId: string; accountId: string; toolName: string; params: unknown; totalItems?: number }): string {
    const jobId = crypto.randomUUID();
    this.db.getDb().prepare(
      `INSERT INTO bulk_operations
        (job_id, user_id, account_id, tool_name, params_json, status, total_items, created_at)
       VALUES ($id, $u, $a, $t, $p, 'queued', $total, $now)`
    ).run({
      $id: jobId, $u: input.userId, $a: input.accountId, $t: input.toolName,
      $p: JSON.stringify(input.params ?? {}), $total: input.totalItems ?? null, $now: this.nowFn(),
    });
    return jobId;
  }

  getJob(jobId: string): BulkJob | null {
    const r = this.db.getDb().prepare(`SELECT * FROM bulk_operations WHERE job_id = $id`).get({ $id: jobId }) as any;
    return r ? rowToJob(r) : null;
  }

  listJobs(opts: { userId?: string; status?: JobStatus; limit?: number } = {}): BulkJob[] {
    const params: Record<string, unknown> = { $limit: Math.min(opts.limit ?? 50, 500) };
    const where: string[] = [];
    if (opts.userId) { where.push('user_id = $u'); params.$u = opts.userId; }
    if (opts.status) { where.push('status = $s'); params.$s = opts.status; }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.getDb().prepare(
      `SELECT * FROM bulk_operations ${clause} ORDER BY created_at DESC LIMIT $limit`
    ).all(params as any) as any[];
    return rows.map(rowToJob);
  }

  /** Flip a non-terminal job to 'cancelled'. Returns true if it changed. */
  cancel(jobId: string): boolean {
    const job = this.getJob(jobId);
    if (!job || TERMINAL.has(job.status)) return false;
    this.db.getDb().prepare(
      `UPDATE bulk_operations SET status = 'cancelled', finished_at = $now WHERE job_id = $id`
    ).run({ $id: jobId, $now: this.nowFn() });
    return true;
  }

  /** Current status, or null if the job is gone. */
  statusOf(jobId: string): JobStatus | null {
    const r = this.db.getDb().prepare(`SELECT status FROM bulk_operations WHERE job_id = $id`).get({ $id: jobId }) as any;
    return r ? (r.status as JobStatus) : null;
  }

  /** Keys already processed (for resume dedup). */
  processedKeys(jobId: string): Set<string> {
    const rows = this.db.getDb().prepare(
      `SELECT item_key FROM bulk_operation_items WHERE job_id = $id AND processed_at IS NOT NULL`
    ).all({ $id: jobId }) as Array<{ item_key: string }>;
    return new Set(rows.map((r) => r.item_key));
  }

  /** Record one processed item + bump the job's done/error counters atomically. */
  recordItem(jobId: string, itemKey: string, res: ItemResult): void {
    const raw = this.db.getDb();
    raw.exec('BEGIN');
    try {
      raw.prepare(
        `INSERT OR REPLACE INTO bulk_operation_items
          (job_id, item_key, processed_at, outcome, result_json, error_text)
         VALUES ($j, $k, $now, $o, $r, $e)`
      ).run({
        $j: jobId, $k: itemKey, $now: this.nowFn(), $o: res.outcome,
        $r: res.result === undefined ? null : JSON.stringify(res.result),
        $e: res.error ?? null,
      });
      raw.prepare(
        `UPDATE bulk_operations
           SET done_items = done_items + 1,
               error_items = error_items + $err
         WHERE job_id = $j`
      ).run({ $j: jobId, $err: res.outcome === 'error' ? 1 : 0 });
      raw.exec('COMMIT');
    } catch (e) {
      try { raw.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * Run (or resume) a job: process each item not already done, checkpointing
   * after each, and stop cooperatively if the job is cancelled. Sets the job
   * 'running' on entry and to 'done'/'failed'/'cancelled' on exit. Safe to call
   * again on a non-terminal job to resume from the last unprocessed item.
   */
  async runJob<T>(
    jobId: string,
    items: T[],
    keyOf: (item: T) => string,
    processOne: (item: T) => Promise<ItemResult>,
    opts: { summarize?: (jobId: string) => unknown } = {},
  ): Promise<BulkJob> {
    const raw = this.db.getDb();
    const already = this.processedKeys(jobId);
    const pending = items.filter((it) => !already.has(keyOf(it)));

    raw.prepare(
      `UPDATE bulk_operations SET status = 'running', started_at = COALESCE(started_at, $now), total_items = $total WHERE job_id = $id`
    ).run({ $id: jobId, $now: this.nowFn(), $total: items.length });

    for (const item of pending) {
      if (this.statusOf(jobId) === 'cancelled') break;
      try {
        const res = await processOne(item);
        this.recordItem(jobId, keyOf(item), res);
      } catch (e) {
        this.recordItem(jobId, keyOf(item), { outcome: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }

    // Finalize — don't override a cancellation that landed mid-loop.
    const finalStatus: JobStatus = this.statusOf(jobId) === 'cancelled' ? 'cancelled' : 'done';
    const summary = opts.summarize ? opts.summarize(jobId) : null;
    raw.prepare(
      `UPDATE bulk_operations
         SET status = $s, finished_at = $now, result_summary_json = $sum
       WHERE job_id = $id`
    ).run({ $id: jobId, $s: finalStatus, $now: this.nowFn(), $sum: summary === null ? null : JSON.stringify(summary) });

    return this.getJob(jobId)!;
  }

  /** Mark a job failed with an error message (for setup failures before/at run). */
  fail(jobId: string, error: string): void {
    this.db.getDb().prepare(
      `UPDATE bulk_operations SET status = 'failed', finished_at = $now, last_error = $e WHERE job_id = $id`
    ).run({ $id: jobId, $now: this.nowFn(), $e: error });
  }

  /** Read each recorded item (e.g. to assemble a final result from a resumed job). */
  items(jobId: string): Array<{ itemKey: string; outcome: ItemOutcome | null; result: unknown; error: string | null }> {
    const rows = this.db.getDb().prepare(
      `SELECT item_key, outcome, result_json, error_text FROM bulk_operation_items WHERE job_id = $id`
    ).all({ $id: jobId }) as any[];
    return rows.map((r) => ({
      itemKey: r.item_key,
      outcome: r.outcome ?? null,
      result: r.result_json ? safeParse(r.result_json) : null,
      error: r.error_text ?? null,
    }));
  }
}
