// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for account signatures — applySignature helper + DB set/get (#signatures).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySignature } from './email-tools.js';
import { DatabaseService } from '../services/database-service.js';

describe('applySignature', () => {
  const sig = { text: 'Jane Doe\nAcme Corp', html: '<b>Jane Doe</b><br>Acme Corp' };

  it('appends the text signature under the "-- " delimiter', () => {
    const r = applySignature('Hello', undefined, sig, true);
    expect(r.text).toBe('Hello\n\n-- \nJane Doe\nAcme Corp');
  });

  it('appends the html signature to the html part', () => {
    const r = applySignature(undefined, '<p>Hi</p>', sig, true);
    expect(r.html).toBe('<p>Hi</p><br><br>-- <br><b>Jane Doe</b><br>Acme Corp');
  });

  it('derives an html signature from a text-only sig when the body is html', () => {
    const r = applySignature('Hi', '<p>Hi</p>', { text: 'A & B\n<x>' }, true);
    expect(r.html).toBe('<p>Hi</p><br><br>-- <br>A &amp; B<br>&lt;x&gt;'); // escaped + newline→br
    expect(r.text).toBe('Hi\n\n-- \nA & B\n<x>');
  });

  it('is a no-op when suppressed or no signature', () => {
    expect(applySignature('Hi', undefined, sig, false)).toEqual({ text: 'Hi', html: undefined });
    expect(applySignature('Hi', undefined, null, true)).toEqual({ text: 'Hi', html: undefined });
    expect(applySignature('Hi', undefined, { text: null, html: null }, true)).toEqual({ text: 'Hi', html: undefined });
  });
});

describe('DatabaseService signature methods', () => {
  let tmpDir: string, db: DatabaseService;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-sig-'));
    db = new DatabaseService({ dbPath: path.join(tmpDir, 'data.db') });
    db.getDb().exec('PRAGMA foreign_keys = OFF');
    db.getDb().prepare(
      `INSERT INTO accounts (account_id, user_id, name, host, port, username, password_encrypted, encryption_iv)
       VALUES ('acc','u','Test','imap.x.com',993,'me@x.com','enc','iv')`
    ).run();
  });
  afterEach(async () => { try { db.close(); } catch { /* */ } await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('sets, reads, and clears a signature', () => {
    expect(db.getAccountSignature('acc')).toEqual({ text: null, html: null });
    db.setAccountSignature('acc', { text: 'Sig', html: '<b>Sig</b>' });
    expect(db.getAccountSignature('acc')).toEqual({ text: 'Sig', html: '<b>Sig</b>' });
    db.setAccountSignature('acc', { text: null, html: null });
    expect(db.getAccountSignature('acc')).toEqual({ text: null, html: null });
  });

  it('returns null for an unknown account', () => {
    expect(db.getAccountSignature('nope')).toBeNull();
  });
});
