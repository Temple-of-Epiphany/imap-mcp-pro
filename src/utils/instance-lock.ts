// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// instance-lock.ts — detect a second IMAP MCP Pro instance on one data dir (#288).
//
// Installing the Claude Desktop extension twice (or running the extension +
// launchd Web UI service) starts multiple MCP servers. Now that every entry
// point defaults to the same data dir (~/.imap-mcp), a duplicate install shares
// the store — but two servers writing the same SQLite file and both probing the
// Web UI port is still a confusing, split-brain-prone setup. This writes a
// pidfile in the data dir and, if another LIVE instance already holds it,
// returns that instance's info so startup can log a clear warning. It does NOT
// block (two instances can technically coexist) — it surfaces the risk.

import fs from 'fs';
import path from 'path';

export interface InstanceInfo {
  pid: number;
  startedAt: number;
  version?: string;
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
  /** Injectable liveness check (tests). */
  alive?: (pid: number) => boolean;
  /** Injectable pid (tests). */
  pid?: number;
  /** Skip installing the process 'exit' cleanup hook (tests). */
  noExitHook?: boolean;
}

/**
 * Claim `dataDir` for this process. Returns the other live instance's info if
 * one already holds the lock (caller warns), else null. Always (re)writes the
 * lockfile to point at us and, unless disabled, removes it on process exit.
 */
export function registerInstance(dataDir: string, opts: RegisterOptions = {}): InstanceInfo | null {
  const alive = opts.alive ?? isPidAlive;
  const selfPid = opts.pid ?? process.pid;
  const lockPath = path.join(dataDir, '.instance.lock');

  let other: InstanceInfo | null = null;
  try {
    if (fs.existsSync(lockPath)) {
      const prev = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as InstanceInfo;
      if (prev?.pid && prev.pid !== selfPid && alive(prev.pid)) {
        other = prev;
      }
    }
  } catch {
    // Corrupt/unreadable lock — treat as stale and overwrite.
  }

  const info: InstanceInfo = { pid: selfPid, startedAt: Date.now(), version: opts.version };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(info), { mode: 0o600 });
    if (!opts.noExitHook) {
      process.once('exit', () => {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as InstanceInfo;
          if (cur?.pid === selfPid) fs.unlinkSync(lockPath);
        } catch {
          // best effort
        }
      });
    }
  } catch {
    // Best effort — a missing lockfile just means no dup detection.
  }

  return other;
}
