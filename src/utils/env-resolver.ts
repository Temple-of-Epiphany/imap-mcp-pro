/**
 * env-resolver.ts (#156) — heal env vars that Claude Desktop fails to
 * substitute before launching the extension's child process.
 *
 * # Precedence (#160)
 *
 * The bundle has TWO config sources of truth. They are consulted in this
 * order; the first non-empty value wins:
 *
 *   1. process.env, AFTER this module finishes its cleanup pass:
 *        - lingering "${user_config.X}" or "${HOME}" placeholders are
 *          treated as "broken substitution" and CLEARED before any other
 *          code reads the value
 *        - "${HOME}" / "${USER}" inside otherwise-valid values are
 *          expanded in place
 *      A non-empty value at this point is treated as authoritative —
 *      i.e., a future Claude Desktop release that ships properly-
 *      substituted user_config values is always preferred over the
 *      fallback below.
 *
 *   2. The saved per-extension settings JSON
 *      (~/Library/Application Support/Claude/Claude Extensions Settings/
 *       *imap-mcp-pro.json on darwin; platform equivalents elsewhere).
 *      Read directly when env was cleared in step 1. Currently scoped to
 *      IMAP_MCP_ALLOWED_ATTACHMENT_DIRS only — that's the single field
 *      Claude Desktop 1.5354 cannot ship correctly via env (array
 *      values stringify as the literal placeholder).
 *
 *   3. Server-side code defaults — applied by the consumer (e.g., the
 *      attachment validator's empty allow-list rejects every path).
 *
 * # Known edge case
 *
 * `if (!process.env.X)` treats both undefined AND empty string as
 * missing. If a future Claude Desktop release fixes substitution and
 * ships an explicit empty value (user opted out), the fallback in step 2
 * will fire and may incorrectly repopulate the value from the settings
 * JSON. This is acceptable today (v2.17.x users are not in that scenario
 * — the env is broken, not legitimately empty), but worth distinguishing
 * if/when Desktop ships its own fix. Tracked on #160.
 *
 * # Why two failure modes
 *
 * Two distinct Claude Desktop substitution gaps observed against
 * Claude Desktop 1.5354:
 *
 *   1. user_config fields with `type: "directory"` + `multiple: true`
 *      (i.e., array values) ship as the literal string
 *      "${user_config.<field>}" — Claude Desktop has no rule for
 *      serializing an array into a single env-var string.
 *
 *   2. user_config defaults containing "${HOME}" ship verbatim — Claude
 *      Desktop only substitutes "${user_config.X}" references, not
 *      "${HOME}" / "${USER}" / etc.
 *
 * What this module does at startup:
 *
 *   - Scans every IMAP_MCP_* env var.
 *   - Expands "${HOME}" -> os.homedir() and "${USER}" -> os.userInfo().username
 *     within env values.
 *   - Detects values that still contain literal "${user_config.X}" or
 *     plain "${HOME}" placeholders and CLEARS them (treats as unset, so
 *     the server-side code defaults apply).
 *   - For IMAP_MCP_ALLOWED_ATTACHMENT_DIRS specifically (the array case),
 *     when the env was cleared, looks up the per-extension settings JSON
 *     file Claude Desktop persists, reads userConfig.allowed_attachment_dirs
 *     directly, joins with ',', and re-exports as the env var.
 *
 * Cleanups are logged via [startup] component=env-resolver so the operator
 * can see exactly what got rewritten. Side effects are limited to
 * mutation of `process.env`.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-08
 * Version: 0.1.0
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { logEvent } from '../startup.js';

const PLACEHOLDER_RE = /\$\{[^}]+\}/;
const USER_CONFIG_RE = /\$\{user_config\.[A-Za-z0-9_]+\}/;
const HOME_RE = /\$\{HOME\}/g;
const USER_RE = /\$\{USER\}/g;

/** Settings-dir candidates per platform; first one that exists wins. */
function settingsDirCandidates(): string[] {
  const home = os.homedir();
  const platform = process.platform;
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions Settings')];
  }
  if (platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appdata, 'Claude', 'Claude Extensions Settings')];
  }
  // Linux / others — Claude Desktop config dir convention is XDG-style.
  return [
    path.join(home, '.config', 'Claude', 'Claude Extensions Settings'),
    path.join(home, '.local', 'share', 'Claude', 'Claude Extensions Settings'),
  ];
}

/**
 * Look up the per-extension settings JSON Claude Desktop persists. We
 * don't know the exact filename ahead of time (it includes the publisher
 * username), so we glob for `*imap-mcp-pro.json` in the settings dir and
 * pick the most-recently-modified match.
 */
function findSettingsFile(): string | null {
  for (const dir of settingsDirCandidates()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const matches = entries.filter(f => f.endsWith('imap-mcp-pro.json'));
    if (matches.length === 0) continue;
    if (matches.length === 1) return path.join(dir, matches[0]);
    // Multiple matches (shouldn't happen, but handle gracefully). Pick newest.
    let newest: { path: string; mtime: number } | null = null;
    for (const f of matches) {
      const p = path.join(dir, f);
      try {
        const stat = fs.statSync(p);
        const mtime = stat.mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
      } catch { /* skip */ }
    }
    if (newest) return newest.path;
  }
  return null;
}

interface SettingsFile {
  isEnabled?: boolean;
  userConfig?: Record<string, unknown>;
}

function readSettings(file: string): SettingsFile | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as SettingsFile;
  } catch {
    return null;
  }
}

/** Expand ${HOME} and ${USER} in a string. Returns the expanded value. */
function expandShellVars(value: string): string {
  return value
    .replace(HOME_RE, os.homedir())
    .replace(USER_RE, os.userInfo().username);
}

/**
 * Walk every IMAP_MCP_* env var and apply both cleanups (placeholder
 * detection + ${HOME}/${USER} expansion). Returns a structured summary
 * for logging.
 */
export function resolveEnvPlaceholders(): {
  expanded: string[];        // names of env vars where ${HOME} / ${USER} expanded
  cleared: string[];         // names of env vars where unsubstituted ${user_config.X} was cleared
  recoveredFromSettings: string[];  // names of env vars repopulated from the settings JSON
} {
  const expanded: string[] = [];
  const cleared: string[] = [];
  const recoveredFromSettings: string[] = [];

  for (const [name, raw] of Object.entries(process.env)) {
    if (!name.startsWith('IMAP_MCP_')) continue;
    if (typeof raw !== 'string') continue;

    let value = raw;
    let didExpand = false;

    // First: ${HOME}/${USER} expansion. Idempotent; expands only if present.
    if (HOME_RE.test(value) || USER_RE.test(value)) {
      // Reset lastIndex on the global regexes (test() advances it).
      HOME_RE.lastIndex = 0;
      USER_RE.lastIndex = 0;
      const replaced = expandShellVars(value);
      if (replaced !== value) {
        value = replaced;
        didExpand = true;
      }
    }

    // Second: detect lingering literal ${...} placeholders. Treat as unset.
    if (USER_CONFIG_RE.test(value) || PLACEHOLDER_RE.test(value)) {
      delete process.env[name];
      cleared.push(name);
      continue;
    }

    if (didExpand) {
      process.env[name] = value;
      expanded.push(name);
    }
  }

  // Targeted recovery for the array case: if the allow-list env var got
  // cleared (or was never set), pull it from the saved settings JSON.
  if (!process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS) {
    const file = findSettingsFile();
    if (file) {
      const settings = readSettings(file);
      const dirs = settings?.userConfig?.allowed_attachment_dirs;
      if (Array.isArray(dirs) && dirs.length > 0) {
        // Each entry may itself contain ${HOME} / ~. Expand both.
        const expandedDirs = dirs
          .map(d => typeof d === 'string' ? d : '')
          .filter(d => d.length > 0)
          .map(d => expandShellVars(d))
          .map(d => d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : d);
        if (expandedDirs.length > 0) {
          process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS = expandedDirs.join(',');
          recoveredFromSettings.push('IMAP_MCP_ALLOWED_ATTACHMENT_DIRS');
        }
      }
    }
  }

  return { expanded, cleared, recoveredFromSettings };
}

/**
 * Convenience wrapper that runs the resolver and emits a single
 * [startup] log line summarizing what got rewritten. Safe to call from
 * the early pre-handshake stage.
 */
export function resolveEnvPlaceholdersWithLogging(): void {
  const r = resolveEnvPlaceholders();
  if (r.expanded.length === 0 && r.cleared.length === 0 && r.recoveredFromSettings.length === 0) {
    return;
  }
  logEvent('[startup]', {
    component: 'env-resolver',
    expanded: r.expanded,
    cleared: r.cleared,
    recoveredFromSettings: r.recoveredFromSettings,
    detail:
      'Claude Desktop user_config substitution leaks literal placeholders for some field types ' +
      '(arrays, ${HOME} defaults). Server-side cleanup applied at startup; see issue #156.',
  });
}
