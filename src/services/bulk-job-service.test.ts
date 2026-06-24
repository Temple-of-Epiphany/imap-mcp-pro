// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// End-to-end tests for BulkJobService (#117) against a real node:sqlite temp DB
// — exercises the 1.13.0 migration, create/record/run, resume (skip processed),
// cooperative cancellation, and error counting.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './database-service.js';
import { BulkJobService } from './bulk-job-service.js';

let tmpDir: string;
let db: DatabaseService;
let jobs: BulkJobService;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-jobs-'));
  db = new DatabaseService({ dbPath: path.join(tmpDir, 'data.db') });
  db.getDb().exec('PRAGMA foreign_keys = OFF'); // skip the accounts FK fixture
  jobs = new BulkJobService(db);
});
afterEach(async () => {
  try { db.close(); } catch { /* ignore */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function newJob() {
  return jobs.createJob({ userId: 'u', accountId: 'acc', toolName: 'imap_test', params: { folder: 'INBOX' } });
}

describe('BulkJobService (#117)', () => {
  it('creates a queued job', () => {
    const id = newJob();
    const job = jobs.getJob(id)!;
    expect(job.status).toBe('queued');
    expect(job.toolName).toBe('imap_test');
    expect((job.params as any).folder).toBe('INBOX');
  });

  it('runs a job to completion, recording every item', async () => {
    const id = newJob();
    const seen: string[] = [];
    const job = await jobs.runJob(id, ['a', 'b', 'c'], (x) => x, async (x) => { seen.push(x); return { outcome: 'ok', result: x.toUpperCase() }; });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(job.status).toBe('done');
    expect(job.totalItems).toBe(3);
    expect(job.doneItems).toBe(3);
    expect(jobs.items(id).find((i) => i.itemKey === 'b')?.result).toBe('B');
  });

  it('resumes: skips already-processed items', async () => {
    const id = newJob();
    // First pass processes a, b then "dies".
    await jobs.runJob(id, ['a', 'b'], (x) => x, async () => ({ outcome: 'ok' }));
    // Resume over the full set — only c and d should be processed.
    const seen: string[] = [];
    const job = await jobs.runJob(id, ['a', 'b', 'c', 'd'], (x) => x, async (x) => { seen.push(x); return { outcome: 'ok' }; });
    expect(seen).toEqual(['c', 'd']);
    expect(job.doneItems).toBe(4);
    expect(job.status).toBe('done');
  });

  it('stops at the next checkpoint when cancelled mid-run', async () => {
    const id = newJob();
    const seen: string[] = [];
    const job = await jobs.runJob(id, ['a', 'b', 'c', 'd'], (x) => x, async (x) => {
      seen.push(x);
      if (x === 'b') jobs.cancel(id); // cancel after processing b
      return { outcome: 'ok' };
    });
    expect(seen).toEqual(['a', 'b']);   // c, d never processed
    expect(job.status).toBe('cancelled');
    expect(job.doneItems).toBe(2);
  });

  it('counts errors and continues', async () => {
    const id = newJob();
    const job = await jobs.runJob(id, ['ok1', 'boom', 'ok2'], (x) => x, async (x) => {
      if (x === 'boom') throw new Error('kaboom');
      return { outcome: 'ok' };
    });
    expect(job.status).toBe('done');
    expect(job.doneItems).toBe(3);
    expect(job.errorItems).toBe(1);
    expect(jobs.items(id).find((i) => i.itemKey === 'boom')?.error).toMatch(/kaboom/);
  });

  it('cancel() is a no-op on a finished job', async () => {
    const id = newJob();
    await jobs.runJob(id, ['a'], (x) => x, async () => ({ outcome: 'ok' }));
    expect(jobs.cancel(id)).toBe(false);
    expect(jobs.getJob(id)!.status).toBe('done');
  });

  it('lists and filters jobs', async () => {
    const a = newJob();
    const b = newJob();
    await jobs.runJob(a, ['x'], (x) => x, async () => ({ outcome: 'ok' }));
    expect(jobs.listJobs({ userId: 'u' }).length).toBe(2);
    expect(jobs.listJobs({ status: 'done' }).map((j) => j.jobId)).toEqual([a]);
    expect(jobs.listJobs({ status: 'queued' }).map((j) => j.jobId)).toEqual([b]);
  });
});
