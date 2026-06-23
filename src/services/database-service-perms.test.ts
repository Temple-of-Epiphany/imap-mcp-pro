// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for owner-only data-at-rest permissions on the DB file + data dir (#235).
// POSIX-only: Windows does not model 0600/0700 modes, so the assertions are
// skipped there (chmod still runs harmlessly).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './database-service.js';

const posix = process.platform !== 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-perms-'));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!posix)('DatabaseService data-at-rest permissions (#235)', () => {
  it('creates the DB file 0600 and the data dir 0700', () => {
    const dbDir = path.join(tmpDir, 'store');
    const dbPath = path.join(dbDir, 'data.db');
    const db = new DatabaseService({ dbPath });
    try {
      expect(mode(dbPath)).toBe(0o600);
      expect(mode(dbDir)).toBe(0o700);
    } finally {
      db.close();
    }
  });

  it('repairs a world-readable DB file on startup', async () => {
    const dbPath = path.join(tmpDir, 'data.db');
    // First construction creates a valid SQLite file (now 0600).
    new DatabaseService({ dbPath }).close();
    // Loosen it as if it predated the fix.
    await fs.chmod(dbPath, 0o644);
    expect(mode(dbPath)).toBe(0o644);
    // Reopen → repaired.
    const db = new DatabaseService({ dbPath });
    try {
      expect(mode(dbPath)).toBe(0o600);
    } finally {
      db.close();
    }
  });
});
