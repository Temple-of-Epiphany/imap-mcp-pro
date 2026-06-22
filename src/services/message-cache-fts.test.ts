// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// End-to-end tests for MessageCacheService.searchFullText (#119) against a real
// node:sqlite DatabaseService in a temp dir — exercises the 1.12.0 migration
// (FTS5 virtual table + sync triggers + backfill) and the ranked search path.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './database-service.js';
import { MessageCacheService, CacheMissError } from './message-cache-service.js';

let tmpDir: string;
let db: DatabaseService;
let cache: MessageCacheService;

const NOW = 1_750_000_000_000; // fixed unix-ms base (no Date.now() needed)

function seed(row: {
  uid: number; folder?: string; subject: string; fromAddress: string;
  fromName?: string; date?: number;
}) {
  const fromDomain = row.fromAddress.split('@')[1]?.toLowerCase() ?? null;
  db.getDb().prepare(
    `INSERT OR REPLACE INTO messages_cache
       (account_id, folder, uid, uid_validity, message_id, date_received,
        subject, from_address, from_domain, from_name, list_unsubscribe, flags_json, cached_at)
     VALUES ($a,$f,$u,1,$mid,$d,$s,$fa,$fd,$fn,NULL,'[]',$c)`
  ).run({
    $a: 'acc', $f: row.folder ?? 'INBOX', $u: row.uid, $mid: `<${row.uid}>`,
    $d: row.date ?? NOW, $s: row.subject, $fa: row.fromAddress.toLowerCase(),
    $fd: fromDomain, $fn: row.fromName ?? null, $c: NOW,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-fts-'));
  db = new DatabaseService({ dbPath: path.join(tmpDir, 'data.db') });
  // Seed cache rows directly without a full accounts fixture — disable FK
  // enforcement on this connection for the test (cache search is independent of
  // the accounts FK). Production inserts go through real, existing accounts.
  db.getDb().exec('PRAGMA foreign_keys = OFF');
  cache = new MessageCacheService(db, {} as any); // searchFullText never touches imapService
  seed({ uid: 1, subject: 'Closing schedule for the house', fromAddress: 'jane@lawfirm.com', fromName: 'Jane Counsel' });
  seed({ uid: 2, subject: 'Lunch tomorrow?', fromAddress: 'bob@friends.com', fromName: 'Bob' });
  seed({ uid: 3, subject: 'Re: closing documents', fromAddress: 'paralegal@lawfirm.com', fromName: 'Pat Legal', date: NOW - 400 * 86_400_000 });
});

afterEach(async () => {
  try { db.close(); } catch { /* ignore */ }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('MessageCacheService.searchFullText (#119)', () => {
  it('matches a term in the subject', async () => {
    const rows = await cache.searchFullText('acc', 'INBOX', 'schedule');
    expect(rows.map((r) => r.uid)).toEqual([1]);
  });

  it('matches a term in the sender display name', async () => {
    const rows = await cache.searchFullText('acc', 'INBOX', 'Counsel');
    expect(rows.map((r) => r.uid)).toEqual([1]);
  });

  it('matches a token from the sender address/domain', async () => {
    const rows = await cache.searchFullText('acc', 'INBOX', 'lawfirm');
    expect(rows.map((r) => r.uid).sort()).toEqual([1, 3]);
  });

  it('applies implicit AND across terms', async () => {
    const rows = await cache.searchFullText('acc', 'INBOX', 'closing schedule');
    expect(rows.map((r) => r.uid)).toEqual([1]); // uid 3 has "closing" but not "schedule"
  });

  it('returns nothing for a non-matching query', async () => {
    expect(await cache.searchFullText('acc', 'INBOX', 'zzzznomatch')).toEqual([]);
  });

  it('is injection-safe: FTS operators in input never throw', async () => {
    for (const q of ['"); drop table messages_cache; --', 'a OR b NEAR(', '^*(', '""']) {
      const rows = await cache.searchFullText('acc', 'INBOX', q);
      expect(Array.isArray(rows)).toBe(true);
    }
    // table still intact
    expect(await cache.searchFullText('acc', 'INBOX', 'schedule')).toHaveLength(1);
  });

  it('honors the since filter', async () => {
    // uid 3 is ~400 days old; restrict to last 90 days → only uid 1 matches "closing"
    const rows = await cache.searchFullText('acc', 'INBOX', 'closing', { since: NOW - 90 * 86_400_000 });
    expect(rows.map((r) => r.uid)).toEqual([1]);
  });

  it('throws CacheMissError for an unsynced folder', async () => {
    await expect(cache.searchFullText('acc', 'Sent', 'anything')).rejects.toBeInstanceOf(CacheMissError);
  });

  it('keeps the FTS index in sync when a row is deleted (trigger)', async () => {
    db.getDb().prepare(`DELETE FROM messages_cache WHERE account_id='acc' AND folder='INBOX' AND uid=1`).run();
    expect(await cache.searchFullText('acc', 'INBOX', 'schedule')).toEqual([]);
  });
});
