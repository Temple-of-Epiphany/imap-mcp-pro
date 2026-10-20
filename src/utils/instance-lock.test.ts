// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// instance-lock (#288, #292): per-process records, dead-pid pruning, same vs
// different install, primary election, legacy lockfile retirement.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { INSTANCES_DIR, isSameInstall, readLiveInstances, registerInstance } from './instance-lock.js';

describe('registerInstance (#288 / #292)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-inst-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const A = { installPath: '/Applications/Claude.app/ext/imap-mcp-pro', version: '2.37.0' };
  const B = { installPath: '/Users/x/.local/share/imap-mcp-pro', version: '2.37.0' };
  const live = (...pids: number[]) => (p: number) => pids.includes(p);

  it('first process: no others, is primary, writes its own record', () => {
    const r = registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100), now: () => 1000 });
    expect(r.sameInstall).toEqual([]);
    expect(r.differentInstall).toEqual([]);
    expect(r.isPrimary).toBe(true);
    expect(fs.existsSync(path.join(dir, INSTANCES_DIR, '100.json'))).toBe(true);
  });

  it('two Desktop hosts from one install: reported as sameInstall, second is not primary', () => {
    registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100), now: () => 1000 });
    const r = registerInstance(dir, { ...A, pid: 101, noExitHook: true, alive: live(100, 101), now: () => 1001 });
    expect(r.sameInstall.map(o => o.pid)).toEqual([100]);
    expect(r.differentInstall).toEqual([]);
    expect(r.isPrimary).toBe(false);
  });

  it('a different install path is reported as differentInstall and names its path', () => {
    registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100), now: () => 1000 });
    const r = registerInstance(dir, { ...B, pid: 200, noExitHook: true, alive: live(100, 200), now: () => 1001 });
    expect(r.sameInstall).toEqual([]);
    expect(r.differentInstall).toHaveLength(1);
    expect(r.differentInstall[0].installPath).toBe(A.installPath);
    expect(r.differentInstall[0].version).toBe('2.37.0');
  });

  it('same path but a different version counts as a different install', () => {
    registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100), now: () => 1000 });
    const r = registerInstance(dir, { ...A, version: '2.36.0', pid: 200, noExitHook: true, alive: live(100, 200), now: () => 1001 });
    expect(r.differentInstall.map(o => o.pid)).toEqual([100]);
  });

  it('prunes records whose pid is dead and does not report them', () => {
    registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100), now: () => 1000 });
    registerInstance(dir, { ...A, pid: 101, noExitHook: true, alive: live(100, 101), now: () => 1001 });
    const r = registerInstance(dir, { ...A, pid: 102, noExitHook: true, alive: live(102), now: () => 1002 });
    expect(r.pruned.sort()).toEqual([100, 101]);
    expect(r.sameInstall).toEqual([]);
    expect(r.isPrimary).toBe(true);
    expect(fs.readdirSync(path.join(dir, INSTANCES_DIR))).toEqual(['102.json']);
  });

  it('primary passes to the survivor once the earlier process dies', () => {
    registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100), now: () => 1000 });
    const second = registerInstance(dir, { ...A, pid: 101, noExitHook: true, alive: live(100, 101), now: () => 1001 });
    expect(second.isPrimary).toBe(false);
    // 100 exits; 101 re-registers (or a later check runs): it is now primary
    const again = registerInstance(dir, { ...A, pid: 101, noExitHook: true, alive: live(101), now: () => 1001 });
    expect(again.isPrimary).toBe(true);
  });

  it('removes the legacy single .instance.lock from #288', () => {
    fs.writeFileSync(path.join(dir, '.instance.lock'), JSON.stringify({ pid: 999, startedAt: 1 }));
    registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100), now: () => 1000 });
    expect(fs.existsSync(path.join(dir, '.instance.lock'))).toBe(false);
  });

  it('tolerates a corrupt record (pruned) and a non-record file (ignored)', () => {
    fs.mkdirSync(path.join(dir, INSTANCES_DIR), { recursive: true });
    fs.writeFileSync(path.join(dir, INSTANCES_DIR, '555.json'), '{not json');
    fs.writeFileSync(path.join(dir, INSTANCES_DIR, 'README'), 'x');
    const r = registerInstance(dir, { ...A, pid: 100, noExitHook: true, alive: live(100, 555), now: () => 1000 });
    expect(r.pruned).toEqual([555]);
    expect(r.sameInstall).toEqual([]);
    expect(fs.existsSync(path.join(dir, INSTANCES_DIR, 'README'))).toBe(true);
  });

  it('isSameInstall normalizes trailing slashes', () => {
    expect(isSameInstall({ pid: 1, startedAt: 0, installPath: '/a/b/', version: '1' }, { pid: 2, startedAt: 0, installPath: '/a/b', version: '1' })).toBe(true);
  });

  it('readLiveInstances on a dir without records returns empty', () => {
    expect(readLiveInstances(dir)).toEqual({ live: [], pruned: [] });
  });
});
