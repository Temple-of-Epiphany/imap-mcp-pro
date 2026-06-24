// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for the bulk-runner registry + the 30s sync-shim behavior (#117 Phase 2).
// Real BulkJobService on a temp DB; UserCheck + IMAP are stubbed.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../services/database-service.js';
import { BulkJobService } from '../services/bulk-job-service.js';
import { BULK_RUNNERS, runJobWithBudget, RunnerDeps } from './bulk-runners.js';

let tmpDir: string, db: DatabaseService, jobs: BulkJobService;

const deps: RunnerDeps = {
  imapService: {
    listFolders: async () => [{ name: 'INBOX' }, { name: 'Sent' }],
    searchEmails: async (_a: string, folder: string) =>
      folder === 'INBOX'
        ? [{ from: 'Spammer <a@spam.com>' }, { from: 'a@spam.com' }, { from: 'Bob <bob@x.com>' }]
        : [{ from: 'bob@x.com' }],
  } as any,
  userCheck: {
    getCachedResult: async () => null,
    checkEmail: async (_u: string, email: string) => ({ email, isSpam: email.includes('spam'), spamScore: email.includes('spam') ? 1 : 0 }),
    cacheResult: async () => {},
  } as any,
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-runner-'));
  db = new DatabaseService({ dbPath: path.join(tmpDir, 'data.db') });
  db.getDb().exec('PRAGMA foreign_keys = OFF');
  jobs = new BulkJobService(db);
});
afterEach(async () => {
  try { db.close(); } catch { /* ignore */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function parse(res: any) { return JSON.parse(res.content[0].text); }

describe('BULK_RUNNERS.deriveItems', () => {
  it('scan_account_spam: unique normalized senders across folders', async () => {
    const items = await BULK_RUNNERS.imap_scan_account_spam.deriveItems('u', { accountId: 'acc', maxEmailsPerFolder: 100 }, deps);
    expect(items.sort()).toEqual(['a@spam.com', 'bob@x.com']); // deduped across INBOX+Sent, normalized
  });

  it('check_emails_spam_bulk: dedupes/normalizes the input list', async () => {
    const items = await BULK_RUNNERS.imap_check_emails_spam_bulk.deriveItems('u', { emails: ['A <a@x.com>', 'a@x.com', 'b@y.com'] }, deps);
    expect(items.sort()).toEqual(['a@x.com', 'b@y.com']);
  });
});

describe('runJobWithBudget (sync shim)', () => {
  it('returns the full summary when the job finishes within budget', async () => {
    const params = { accountId: 'acc' };
    const runner = BULK_RUNNERS.imap_scan_account_spam;
    const items = await runner.deriveItems('u', params, deps);
    const jobId = jobs.createJob({ userId: 'u', accountId: 'acc', toolName: 'imap_scan_account_spam', params, totalItems: items.length });
    const out = parse(await runJobWithBudget(jobs, jobId, items, (k) => runner.processOne('u', k, params, deps), (jid) => runner.summarize(jid, params, jobs), 5000));
    expect(out.mode).toBe('completed');
    expect(out.status).toBe('done');
    expect(out.summary.sendersChecked).toBe(2);
    expect(out.summary.spamSenders).toBe(1); // a@spam.com
  });

  it('returns a running envelope when the budget elapses, then finishes in the background', async () => {
    const params = { accountId: 'acc' };
    const items = ['s1@x.com', 's2@x.com', 's3@x.com'];
    const jobId = jobs.createJob({ userId: 'u', accountId: 'acc', toolName: 'imap_scan_account_spam', params, totalItems: items.length });
    const slow = async (k: string) => { await new Promise((r) => setTimeout(r, 40)); return { outcome: 'ok' as const, result: { email: k, isSpam: false } }; };
    const out = parse(await runJobWithBudget(jobs, jobId, items, slow, (jid) => BULK_RUNNERS.imap_scan_account_spam.summarize(jid, params, jobs), 5));
    expect(out.mode).toBe('running');
    expect(out.jobId).toBe(jobId);
    // Background run continues; wait it out and confirm completion.
    await new Promise((r) => setTimeout(r, 250));
    expect(jobs.getJob(jobId)!.status).toBe('done');
    expect(jobs.getJob(jobId)!.doneItems).toBe(3);
  });
});
