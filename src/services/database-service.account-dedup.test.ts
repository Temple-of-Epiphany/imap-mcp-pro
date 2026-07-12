// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for createAccount duplicate rejection + FTS5 reconciliation (#286).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseService } from './database-service.js';

const KEY = 'a'.repeat(64); // 32-byte hex AES key for the test DB

function baseAccount(userId: string, over: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    name: 'Test',
    host: 'imap.example.com',
    port: 993,
    username: 'user@example.com',
    password: 'secret',
    tls: true,
    ...over,
  } as any;
}

describe('createAccount duplicate rejection (#286)', () => {
  let dir: string;
  let db: DatabaseService;
  const userId = 'u1';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbsvc-dedup-'));
    db = new DatabaseService({ dbPath: path.join(dir, 'data.db'), encryptionKey: KEY });
    db.createUser({ user_id: userId, username: 'u1', email: null, organization: null, is_active: true, metadata: null } as any);
  });

  afterEach(() => {
    try { db.close?.(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconcileFts5 ran at init (FTS5 present in this build)', () => {
    expect(db.isFtsAvailable()).toBe(true);
  });

  it('rejects a second account with the same IMAP identity', () => {
    const first = db.createAccount(baseAccount(userId));
    expect(first.account_id).toBeTruthy();
    expect(() => db.createAccount(baseAccount(userId))).toThrow(/already exists/i);
  });

  it('matches identity case-insensitively (host + username)', () => {
    db.createAccount(baseAccount(userId));
    expect(() =>
      db.createAccount(baseAccount(userId, { host: 'IMAP.Example.COM', username: 'User@Example.com' })),
    ).toThrow(/already exists/i);
    expect(db.findAccountByImapIdentity(userId, 'imap.example.com', 'USER@EXAMPLE.COM')).toBeTruthy();
  });

  it('allows a different mailbox on the same host', () => {
    db.createAccount(baseAccount(userId));
    const second = db.createAccount(baseAccount(userId, { username: 'other@example.com' }));
    expect(second.account_id).toBeTruthy();
    expect(db.listAccountsForUser(userId)).toHaveLength(2);
  });

  it('account deletion cascades into messages_cache and fires the FTS trigger cleanly (#286)', () => {
    const acct = db.createAccount(baseAccount(userId));
    const raw = db.getDb();
    raw.prepare(
      `INSERT INTO messages_cache (account_id, folder, uid, uid_validity, subject, from_address, from_name, cached_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(acct.account_id, 'INBOX', 1, 1, 'hello world', 'a@b.com', 'Alice', 0);

    // On an FTS5 build the delete-cascade fires messages_cache_fts_ad; on an
    // FTS5-less build reconcileFts5 has dropped that trigger. Either way: no throw.
    expect(() => db.deleteAccount(acct.account_id)).not.toThrow();
    const row = raw.prepare('SELECT count(*) AS c FROM messages_cache WHERE account_id = ?').get(acct.account_id) as any;
    expect(row.c).toBe(0);
  });

  it('allows the same identity for a different user (multi-tenant isolation)', () => {
    db.createUser({ user_id: 'u2', username: 'u2', email: null, organization: null, is_active: true, metadata: null } as any);
    db.createAccount(baseAccount(userId));
    const other = db.createAccount(baseAccount('u2'));
    expect(other.account_id).toBeTruthy();
  });
});
