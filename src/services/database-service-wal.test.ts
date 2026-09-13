// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for multi-process-safe SQLite configuration (#290): WAL journal mode,
// busy timeout, in-place upgrade of existing rollback-journal databases, and
// owner-only permissions on the WAL sidecars.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from './database-service.js';

const posix = process.platform !== 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-wal-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function pragma(db: DatabaseService, name: string): unknown {
  const row = db.getDb().prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return Object.values(row)[0];
}

describe('DatabaseService SQLite concurrency settings (#290)', () => {
  it('creates new databases in WAL mode with a busy timeout', () => {
    const db = new DatabaseService({ dbPath: path.join(tmpDir, 'data.db') });
    try {
      expect(pragma(db, 'journal_mode')).toBe('wal');
      expect(pragma(db, 'busy_timeout')).toBeGreaterThanOrEqual(5000);
    } finally {
      db.close();
    }
  });

  it('upgrades an existing rollback-journal database to WAL in place', () => {
    const dbPath = path.join(tmpDir, 'data.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA journal_mode=DELETE; CREATE TABLE legacy_marker (id INTEGER)');
    legacy.exec('INSERT INTO legacy_marker VALUES (42)');
    legacy.close();

    const db = new DatabaseService({ dbPath });
    try {
      expect(pragma(db, 'journal_mode')).toBe('wal');
      const row = db.getDb().prepare('SELECT id FROM legacy_marker').get() as { id: number };
      expect(row.id).toBe(42);
    } finally {
      db.close();
    }

    // WAL is persistent in the file header: a plain connection sees it too.
    const reopened = new DatabaseSync(dbPath);
    try {
      const row = reopened.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(row.journal_mode).toBe('wal');
    } finally {
      reopened.close();
    }
  });

  it('lets two instances on one file write while the other holds a read transaction', () => {
    const dbPath = path.join(tmpDir, 'data.db');
    const a = new DatabaseService({ dbPath });
    const b = new DatabaseService({ dbPath });
    try {
      a.getDb().exec('CREATE TABLE IF NOT EXISTS wal_probe (v INTEGER)');
      // An open read transaction on A would block B's write under the old
      // rollback journal; WAL lets readers and a writer proceed together.
      a.getDb().exec('BEGIN');
      a.getDb().prepare('SELECT COUNT(*) AS n FROM wal_probe').get();
      expect(() => b.getDb().exec('INSERT INTO wal_probe VALUES (1)')).not.toThrow();
      a.getDb().exec('COMMIT');
      const row = a.getDb().prepare('SELECT COUNT(*) AS n FROM wal_probe').get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      a.close();
      b.close();
    }
  });

  it.skipIf(!posix)('creates the -wal and -shm sidecars owner-only (0600)', () => {
    const dbPath = path.join(tmpDir, 'data.db');
    const db = new DatabaseService({ dbPath });
    try {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = dbPath + suffix;
        if (existsSync(sidecar)) expect(mode(sidecar)).toBe(0o600);
      }
    } finally {
      db.close();
    }
  });
});
