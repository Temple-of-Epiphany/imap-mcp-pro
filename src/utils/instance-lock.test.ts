// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for registerInstance — the duplicate-instance guard (#288).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerInstance } from './instance-lock.js';

describe('registerInstance (#288)', () => {
  let dir: string;
  const lock = () => path.join(dir, '.instance.lock');

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-lock-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null and writes the lock when no prior instance', () => {
    const other = registerInstance(dir, { pid: 100, noExitHook: true, alive: () => true });
    expect(other).toBeNull();
    expect(JSON.parse(fs.readFileSync(lock(), 'utf8')).pid).toBe(100);
  });

  it('detects another LIVE instance holding the lock', () => {
    registerInstance(dir, { pid: 100, noExitHook: true, alive: () => true });
    const other = registerInstance(dir, { pid: 200, noExitHook: true, alive: (p) => p === 100 });
    expect(other?.pid).toBe(100);
    // The lock is re-pointed at us regardless.
    expect(JSON.parse(fs.readFileSync(lock(), 'utf8')).pid).toBe(200);
  });

  it('ignores a stale lock whose pid is dead', () => {
    registerInstance(dir, { pid: 100, noExitHook: true, alive: () => true });
    const other = registerInstance(dir, { pid: 200, noExitHook: true, alive: () => false });
    expect(other).toBeNull();
  });

  it('ignores its own pid (restart / re-register)', () => {
    registerInstance(dir, { pid: 100, noExitHook: true, alive: () => true });
    const other = registerInstance(dir, { pid: 100, noExitHook: true, alive: () => true });
    expect(other).toBeNull();
  });

  it('overwrites a corrupt lockfile without throwing', () => {
    fs.writeFileSync(lock(), 'not json');
    const other = registerInstance(dir, { pid: 200, noExitHook: true, alive: () => true });
    expect(other).toBeNull();
    expect(JSON.parse(fs.readFileSync(lock(), 'utf8')).pid).toBe(200);
  });
});
