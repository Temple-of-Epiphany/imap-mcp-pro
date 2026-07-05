// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// export-dest-resolver.ts — validate a user-chosen export destination (#270).
//
// The export tools normally write under the managed per-user outbox
// (~/.imap-mcp/users/{userId}/outbox/exports/). This resolver backs the
// optional `destPath` argument that lets a caller write .eml files DIRECTLY to
// a path outside the MCP (e.g. ~/Downloads/sent-mail) — no outbox two-hop.
//
// Direct writes are a security-relevant capability (the outbox scoping is the
// MSP multi-tenant boundary), so every destPath is validated:
//   - absolute; `..` collapsed via path.resolve
//   - within an allowed export root (default: home; override via
//     IMAP_MCP_ALLOWED_EXPORT_DIRS so operators can restrict/disable it)
//   - never inside the MCP data tree (~/.imap-mcp) — that's the outbox's job
//   - not the bare home root, and not a top-level hidden (dot) dir under home
//   - symlink-escape guarded: the nearest existing ancestor is realpath'd and
//     re-checked so a symlink can't redirect the write outside the allow-list
//
// Author: Colin Bitterfield
// Email: colin.bitterfield@templeofepiphany.com
// Date Created: 2026-07-05
// Version: 0.1.0
//
// Tracker: #270.

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Allowed roots an export `destPath` may resolve within. Defaults to the
 * user's home directory. Operators narrow or widen this with
 * IMAP_MCP_ALLOWED_EXPORT_DIRS — a comma-separated list of absolute dirs
 * (comma, not path.delimiter, so it matches the Claude Desktop
 * directory/multiple config serialization and stays correct on Windows where
 * `:` appears in drive paths). Set it to a path that doesn't exist to
 * effectively disable destPath. `~` / `~/…` entries expand to the home dir.
 */
export function allowedExportRoots(): string[] {
  const env = process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS;
  if (env && env.trim()) {
    const roots = env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p))
      .map((p) => path.resolve(p));
    if (roots.length > 0) return roots;
  }
  return [os.homedir()];
}

function mcpDataDir(): string {
  return path.join(os.homedir(), '.imap-mcp');
}

function withinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Validate a caller-supplied absolute export destination and return the
 * resolved directory (created 0700 if absent). Throws on any policy violation.
 */
export function resolveExportDest(destPath: string): string {
  if (!destPath || !path.isAbsolute(destPath)) {
    throw new Error(`destPath must be an absolute path (got: ${destPath || '<empty>'})`);
  }

  const resolved = path.resolve(destPath);
  const home = os.homedir();
  const mcpDir = mcpDataDir();

  // destPath is explicitly for writing OUTSIDE the MCP — never let it target
  // the MCP data/outbox tree (omit destPath to use the managed outbox).
  if (withinRoot(resolved, mcpDir)) {
    throw new Error(
      `destPath must be outside the MCP data dir (${mcpDir}); omit destPath to use the managed outbox`,
    );
  }

  const roots = allowedExportRoots();
  if (!roots.some((root) => withinRoot(resolved, root))) {
    throw new Error(
      `destPath ${resolved} is not within an allowed export root (${roots.join(', ')}). ` +
        'Set IMAP_MCP_ALLOWED_EXPORT_DIRS to widen the allow-list.',
    );
  }

  if (resolved === home) {
    throw new Error('destPath must be a subdirectory, not the home directory root');
  }

  // Reject top-level hidden dirs under home (e.g. ~/.ssh, ~/.config) to avoid
  // clobbering config trees. Only applies when the target is under home.
  const relFromHome = path.relative(home, resolved);
  if (relFromHome && !relFromHome.startsWith('..') && relFromHome.split(path.sep)[0].startsWith('.')) {
    throw new Error(`destPath must not target a hidden (dot) directory under home: ${resolved}`);
  }

  // Symlink-escape guard: walk up to the nearest existing ancestor, realpath
  // it, and re-verify it stays within an allowed root and outside the MCP dir.
  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  // Compare against realpath'd roots/mcpDir too — the roots themselves may sit
  // under a symlinked prefix (e.g. macOS /var -> /private/var).
  const realOf = (p: string): string => {
    try { return fs.realpathSync(p); } catch { return p; }
  };
  try {
    const real = fs.realpathSync(probe);
    const realRoots = roots.map(realOf);
    const realMcp = realOf(mcpDir);
    const realOk =
      realRoots.some((root) => withinRoot(real, root)) && !withinRoot(real, realMcp);
    if (!realOk) {
      throw new Error(`destPath resolves via symlink outside allowed roots: ${real}`);
    }
  } catch (e) {
    throw new Error(`destPath could not be validated: ${(e as Error).message}`);
  }

  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}
