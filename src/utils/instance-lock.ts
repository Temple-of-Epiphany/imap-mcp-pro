// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// instance-lock.ts — register this IMAP MCP Pro process against its data dir
// and discover the other live ones (#288, #292).
//
// Claude Desktop starts one server process per host that uses the extension
// (the chat client and the Cowork bridge), both against the same data dir.
// Since #290 (WAL + busy timeout) that is supported, so two processes from the
// SAME install path and version are expected and must not be reported as a
// duplicate install. Two processes from DIFFERENT install paths or versions are
// the real duplicate-install case #288 was written for.
//
// Each process writes its own `.instances/<pid>.json`; dead pids are pruned on
// every registration. This replaces the single `.instance.lock` (#288), which
// the newest process overwrote so the first process's exit hook never removed
// it, and which the newest process deleted on exit while older ones lived.

import fs from 'fs';
import path from 'path';

export interface InstanceInfo {
  pid: number;
  startedAt: number;
  version?: string;
  /** Package root of the running install (differs per extension install). */
  installPath?: string;
}

export interface InstanceRegistration {
  /** This process's record. */
  self: InstanceInfo;
  /** Other live instances from the same install path AND version (expected: multiple Desktop hosts). */
  sameInstall: InstanceInfo[];
  /** Other live instances from a different install path or version (a real duplicate install). */
  differentInstall: InstanceInfo[];
  /** True when this is the earliest-started live instance; only the primary starts the embedded Web UI. */
  isPrimary: boolean;
  /** Dead-pid records removed during this registration. */
  pruned: number[];
}

/** True if a process with `pid` currently exists (EPERM counts as alive). */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0 || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists but owned by another user
  }
}

export interface RegisterOptions {
  version?: string;
  installPath?: string;
  /** Injectable liveness check (tests). */
  alive?: (pid: number) => boolean;
  /** Injectable pid (tests). */
  pid?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Skip installing the process 'exit' cleanup hook (tests). */
  noExitHook?: boolean;
}

export const INSTANCES_DIR = '.instances';
const LEGACY_LOCK = '.instance.lock';

function normalizePath(p: string | undefined): string {
  return p ? path.resolve(p).replace(/[\\/]+$/, '') : '';
}

/** Same install = same (normalized) install path and same version string. */
export function isSameInstall(a: InstanceInfo, b: InstanceInfo): boolean {
  return normalizePath(a.installPath) === normalizePath(b.installPath) && (a.version ?? '') === (b.version ?? '');
}

/** Read every live record under `<dataDir>/.instances`, pruning dead ones. */
export function readLiveInstances(
  dataDir: string,
  opts: { alive?: (pid: number) => boolean; exceptPid?: number } = {}
): { live: InstanceInfo[]; pruned: number[] } {
  const alive = opts.alive ?? isPidAlive;
  const dir = path.join(dataDir, INSTANCES_DIR);
  const live: InstanceInfo[] = [];
  const pruned: number[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return { live, pruned }; }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    let rec: InstanceInfo | null = null;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceInfo; } catch { rec = null; }
    const pid = rec?.pid ?? Number(name.replace('.json', ''));
    if (!rec || !pid || !alive(pid)) {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
      pruned.push(pid);
      continue;
    }
    if (pid === opts.exceptPid) continue;
    live.push({ ...rec, pid });
  }
  return { live, pruned };
}

/**
 * Register this process against `dataDir` and report the other live instances,
 * split into same-install (expected) and different-install (real duplicate).
 * Never blocks; the caller decides what to log and whether to start the Web UI.
 */
export function registerInstance(dataDir: string, opts: RegisterOptions = {}): InstanceRegistration {
  const alive = opts.alive ?? isPidAlive;
  const selfPid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const self: InstanceInfo = {
    pid: selfPid,
    startedAt: now(),
    version: opts.version,
    installPath: opts.installPath ? normalizePath(opts.installPath) : undefined,
  };

  const dir = path.join(dataDir, INSTANCES_DIR);
  const selfFile = path.join(dir, `${selfPid}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(selfFile, JSON.stringify(self), { mode: 0o600 });
    if (!opts.noExitHook) {
      process.once('exit', () => { try { fs.unlinkSync(selfFile); } catch { /* best effort */ } });
    }
  } catch {
    // Best effort — no record just means no duplicate detection for this process.
  }

  // Retire the single lockfile from #288 (it could point at a dead or wrong pid).
  try { fs.unlinkSync(path.join(dataDir, LEGACY_LOCK)); } catch { /* absent */ }

  const { live, pruned } = readLiveInstances(dataDir, { alive, exceptPid: selfPid });
  const sameInstall = live.filter(o => isSameInstall(o, self));
  const differentInstall = live.filter(o => !isSameInstall(o, self));
  // Primary = earliest start; tie → lowest pid. Only the primary starts the Web UI.
  const isPrimary = !live.some(o => o.startedAt < self.startedAt || (o.startedAt === self.startedAt && o.pid < selfPid));

  return { self, sameInstall, differentInstall, isPrimary, pruned };
}
