/**
 * SkillsInstallerService — copy bundled skills from dist/skills/ to the AI
 * client's skills directory on startup.
 *
 * v2.17.0 MVP scope (Issue #124, thin slice of #120):
 *   - Hardcoded install path: ~/.claude/skills/imap-mcp-pro/
 *   - Startup-only install (no periodic refresh)
 *   - Version-compare overwrite (no SHA-based user-edit preservation)
 *   - Skip if disabled via IMAP_MCP_SKIP_SKILLS_INSTALL=1
 *
 * Out of scope (deferred to full #120 design):
 *   - Configurable install path
 *   - Periodic TTL-based re-sync
 *   - SHA comparison to preserve user edits
 *   - imap_get_skills_manifest tool for remote consumers
 *
 * Bundle layout (produced by scripts/postbuild.mjs):
 *
 *   dist/skills/
 *     manifest.json
 *     <skill-name>/SKILL.md
 *     <skill-name>/version.json
 *
 * Install layout (created by this service):
 *
 *   ~/.claude/skills/imap-mcp-pro/
 *     <skill-name>/SKILL.md
 *     <skill-name>/version.json
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-01
 * Version: 0.1.0
 *
 * Tracker: #124 (MVP umbrella). Full design: #120.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillsInstallReport {
  /** Skills that didn't exist on disk and were freshly copied. */
  installed: string[];
  /** Skills present on disk with an older version that were overwritten. */
  updated: string[];
  /** Skills already at the bundled version (no-op). */
  unchanged: string[];
  /** Skills the user has modified or that have a newer on-disk version. */
  preserved: string[];
  /** Skipped entirely via IMAP_MCP_SKIP_SKILLS_INSTALL=1. */
  skipped: boolean;
  durationMs: number;
}

interface BundleManifest {
  manifest_version: string;
  publisher: string;
  publisher_version?: string;
  skills: Array<{
    name: string;
    version: string;
    description?: string;
    content_path?: string;
    min_mcp_server_version?: string;
  }>;
}

interface SkillVersionFile {
  name: string;
  version: string;
}

/** GitHub source descriptor for skill updates. */
export interface GitHubSource {
  owner: string;
  repo: string;
  ref: string;
}

/**
 * Default GitHub source — overridable via env vars or per-call options.
 *
 * v2.17.5: defaults to the MCP's own repo (`Temple-of-Epiphany/imap-mcp-pro`)
 * rather than the upstream `claude-skills-library`. Skills ship bundled with
 * the MCP and live at `skills/<name>/` inside its repo, so the MCP repo IS
 * the canonical update source. imap-mcp-pro is public, so the
 * raw.githubusercontent.com fetch path works without a PAT.
 *
 * Override via `IMAP_MCP_SKILL_GITHUB_REPO` if you fork or maintain skills
 * elsewhere; the back-compat env-var override path is intact.
 */
export function defaultGitHubSource(): GitHubSource {
  return {
    owner: process.env.IMAP_MCP_SKILL_GITHUB_OWNER ?? 'Temple-of-Epiphany',
    repo: process.env.IMAP_MCP_SKILL_GITHUB_REPO ?? 'imap-mcp-pro',
    ref: process.env.IMAP_MCP_SKILL_GITHUB_REF ?? 'main',
  };
}

/** Per-skill availability status from a GitHub check. */
export interface SkillUpdateStatus {
  name: string;
  installed: string | null;     // version.json on disk; null if not installed
  bundled: string;              // version shipped with this MCP build
  available: string | null;     // version on GitHub at the requested ref
  hasUpdate: boolean;           // available > max(installed, bundled)
  fetchError: string | null;    // network/parse error, if any
}

export interface SkillUpdateCheckReport {
  checkedAt: string;            // ISO timestamp
  source: GitHubSource;
  baseUrl: string;              // raw.githubusercontent.com URL up to /skills/
  skills: SkillUpdateStatus[];
  summary: string;              // human-readable single-line summary
  cached: boolean;              // whether this came from the in-memory TTL cache
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SkillsInstallerService {
  /**
   * @param bundleDir  Absolute path to the bundle root (e.g. dist/skills/)
   * @param installDir Absolute path to install root (default: ~/.claude/skills/imap-mcp-pro/)
   */
  constructor(
    private bundleDir: string,
    private installDir: string = path.join(os.homedir(), '.claude', 'skills', 'imap-mcp-pro'),
  ) {}

  /**
   * Run the install. Idempotent. Safe to call on every startup.
   */
  async install(): Promise<SkillsInstallReport> {
    const start = Date.now();
    const report: SkillsInstallReport = {
      installed: [],
      updated: [],
      unchanged: [],
      preserved: [],
      skipped: false,
      durationMs: 0,
    };

    if (process.env.IMAP_MCP_SKIP_SKILLS_INSTALL === '1') {
      report.skipped = true;
      report.durationMs = Date.now() - start;
      return report;
    }

    // 1. Read bundle manifest. If absent, no skills to install — return empty report.
    let manifest: BundleManifest;
    try {
      const raw = await fs.readFile(path.join(this.bundleDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(raw) as BundleManifest;
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        report.durationMs = Date.now() - start;
        return report;
      }
      throw e;
    }

    // 2. Ensure install root exists.
    await fs.mkdir(this.installDir, { recursive: true });

    // 3. Per-skill: compare versions, copy if needed.
    for (const entry of manifest.skills) {
      const bundleSkillDir = path.join(this.bundleDir, entry.name);
      const installSkillDir = path.join(this.installDir, entry.name);

      const installedVersion = await this.readInstalledVersion(installSkillDir);

      if (installedVersion === null) {
        await this.copySkill(bundleSkillDir, installSkillDir);
        report.installed.push(entry.name);
      } else if (compareSemver(entry.version, installedVersion) > 0) {
        // Bundle is newer → overwrite. (MVP cut: no SHA-based user-edit
        // preservation; documented limitation.)
        await this.copySkill(bundleSkillDir, installSkillDir);
        report.updated.push(entry.name);
      } else if (compareSemver(entry.version, installedVersion) === 0) {
        report.unchanged.push(entry.name);
      } else {
        // On-disk version is newer than bundle — leave it alone.
        report.preserved.push(entry.name);
      }
    }

    report.durationMs = Date.now() - start;
    return report;
  }

  /** Read version.json from an installed skill, return its version or null. */
  private async readInstalledVersion(skillDir: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(path.join(skillDir, 'version.json'), 'utf8');
      const parsed = JSON.parse(raw) as SkillVersionFile;
      return typeof parsed.version === 'string' ? parsed.version : null;
    } catch (e: any) {
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
  }

  /** Copy bundle skill dir → install location, replacing existing content. */
  private async copySkill(srcDir: string, dstDir: string): Promise<void> {
    await fs.mkdir(dstDir, { recursive: true });
    await fs.cp(srcDir, dstDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // GitHub update check + apply (v2.17.4, #138)
  //
  // Trust model: skills are *instructions to Claude*. Whoever controls
  // the GitHub repo controls the LLM workflow. The check tool is read-
  // only and surfaces "what would change" for human review. The apply
  // tool requires explicit `skills: string[]` — no "update everything"
  // shortcut. Auto-fetch at startup is intentionally NOT wired; this
  // ships in user-confirmed mode only.
  // -------------------------------------------------------------------

  /** Build the raw.githubusercontent.com base for a given source. */
  private rawBaseUrl(source: GitHubSource): string {
    return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/skills/`;
  }

  /**
   * Fetch a single text file from GitHub. Uses two endpoints:
   *
   *   - `raw.githubusercontent.com` for public repos (unauthenticated;
   *     ignores Authorization headers, no rate-limit concerns at our
   *     volume).
   *   - GitHub Contents API with `Accept: application/vnd.github.raw`
   *     when `IMAP_MCP_GITHUB_TOKEN` is set — works for private repos
   *     and forks. The token is read from env at call time so users
   *     can rotate it without restarting the server.
   *
   * Pick raw.githubusercontent.com whenever no token is set so unauth
   * public-repo users don't burn the API rate limit (60/hr unauth vs
   * effectively unlimited on raw.).
   */
  private async fetchTextFromGitHub(
    source: GitHubSource,
    pathInRepo: string,
    timeoutMs = 10_000,
  ): Promise<string> {
    const token = process.env.IMAP_MCP_GITHUB_TOKEN;

    const url = token
      ? `https://api.github.com/repos/${source.owner}/${source.repo}/contents/skills/${pathInRepo}?ref=${encodeURIComponent(source.ref)}`
      : this.rawBaseUrl(source) + pathInRepo;

    const headers: Record<string, string> = {
      'User-Agent': 'imap-mcp-pro skill-updater',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['Accept'] = 'application/vnd.github.raw';
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers });
      if (!res.ok) {
        throw new Error(`GitHub returned ${res.status} ${res.statusText} for ${url}`);
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch the version string for one skill from GitHub. Returns null on
   * any error (network, parse, missing) — caller decides how to surface.
   */
  private async fetchRemoteVersion(
    source: GitHubSource,
    skillName: string,
    timeoutMs = 10_000,
  ): Promise<{ version: string | null; error: string | null }> {
    try {
      const raw = await this.fetchTextFromGitHub(source, `${skillName}/version.json`, timeoutMs);
      const parsed = JSON.parse(raw) as SkillVersionFile;
      if (typeof parsed.version === 'string') {
        return { version: parsed.version, error: null };
      }
      return { version: null, error: 'version.json missing "version" field' };
    } catch (e: any) {
      return { version: null, error: e?.message ?? String(e) };
    }
  }

  /**
   * Check GitHub for newer skill versions without changing on-disk state.
   * Reads the bundled manifest as the source of truth for skill names,
   * compares each against installed and remote versions.
   */
  async checkForUpdates(options?: {
    source?: GitHubSource;
    timeoutMs?: number;
  }): Promise<SkillUpdateCheckReport> {
    const source = options?.source ?? defaultGitHubSource();
    const timeoutMs = options?.timeoutMs ?? 10_000;

    let manifest: BundleManifest;
    try {
      const raw = await fs.readFile(path.join(this.bundleDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(raw) as BundleManifest;
    } catch (e: any) {
      // No bundle = nothing to check
      return {
        checkedAt: new Date().toISOString(),
        source,
        baseUrl: this.rawBaseUrl(source),
        skills: [],
        summary: 'No bundled manifest found.',
        cached: false,
      };
    }

    const statuses = await Promise.all(
      manifest.skills.map(async (entry): Promise<SkillUpdateStatus> => {
        const installed = await this.readInstalledVersion(
          path.join(this.installDir, entry.name),
        );
        const remote = await this.fetchRemoteVersion(source, entry.name, timeoutMs);

        // hasUpdate compares remote against what's *on disk* (or, when nothing
        // is installed, against what would land via the bundle). This matches
        // user intuition: "does GitHub have something newer than my actual
        // installed copy?" Not "newer than the best source available."
        const baseline = installed ?? entry.version;
        const hasUpdate = remote.version !== null && compareSemver(remote.version, baseline) > 0;

        return {
          name: entry.name,
          installed,
          bundled: entry.version,
          available: remote.version,
          hasUpdate,
          fetchError: remote.error,
        };
      }),
    );

    const updates = statuses.filter(s => s.hasUpdate);
    const summary = updates.length === 0
      ? `All ${statuses.length} skill(s) up to date at ${source.owner}/${source.repo}@${source.ref}`
      : updates.map(s => `${s.name}: ${s.installed ?? '(none)'} → ${s.available} available`).join('; ');

    return {
      checkedAt: new Date().toISOString(),
      source,
      baseUrl: this.rawBaseUrl(source),
      skills: statuses,
      summary,
      cached: false,
    };
  }

  /**
   * Apply an update for the named skills. Fetches SKILL.md + version.json
   * from GitHub, writes to the install dir, preserves user edits unless
   * `force: true`. Skills not in the manifest are rejected.
   */
  async updateFromGitHub(options: {
    skills: string[];
    source?: GitHubSource;
    force?: boolean;
    timeoutMs?: number;
  }): Promise<SkillsInstallReport> {
    const start = Date.now();
    const source = options.source ?? defaultGitHubSource();
    const timeoutMs = options.timeoutMs ?? 10_000;

    const report: SkillsInstallReport = {
      installed: [],
      updated: [],
      unchanged: [],
      preserved: [],
      skipped: false,
      durationMs: 0,
    };

    if (!options.skills || options.skills.length === 0) {
      throw new Error('updateFromGitHub requires an explicit non-empty `skills` array.');
    }

    let manifest: BundleManifest;
    try {
      const raw = await fs.readFile(path.join(this.bundleDir, 'manifest.json'), 'utf8');
      manifest = JSON.parse(raw) as BundleManifest;
    } catch {
      manifest = { manifest_version: '1.0', publisher: 'imap-mcp-pro', skills: [] };
    }
    const knownSkills = new Set(manifest.skills.map(s => s.name));

    await fs.mkdir(this.installDir, { recursive: true });

    for (const skillName of options.skills) {
      if (!knownSkills.has(skillName)) {
        // Reject unknown to prevent path-injection-like behavior. The
        // bundled manifest is the allowlist.
        report.preserved.push(`${skillName} (unknown — not in bundle manifest)`);
        continue;
      }

      try {
        const [skillMd, versionJson] = await Promise.all([
          this.fetchTextFromGitHub(source, `${skillName}/SKILL.md`, timeoutMs),
          this.fetchTextFromGitHub(source, `${skillName}/version.json`, timeoutMs),
        ]);

        const remoteVersion = (() => {
          try {
            const v = JSON.parse(versionJson) as SkillVersionFile;
            return typeof v.version === 'string' ? v.version : null;
          } catch {
            return null;
          }
        })();
        if (!remoteVersion) {
          report.preserved.push(`${skillName} (remote version.json malformed)`);
          continue;
        }

        const skillDir = path.join(this.installDir, skillName);
        const installedVersion = await this.readInstalledVersion(skillDir);

        if (installedVersion && !options.force && compareSemver(installedVersion, remoteVersion) >= 0) {
          report.unchanged.push(skillName);
          continue;
        }

        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
        await fs.writeFile(path.join(skillDir, 'version.json'), versionJson, 'utf8');

        if (installedVersion) {
          report.updated.push(skillName);
        } else {
          report.installed.push(skillName);
        }
      } catch (e: any) {
        // Surface as preserved with reason — caller decides whether to retry.
        report.preserved.push(`${skillName} (fetch failed: ${e?.message ?? String(e)})`);
      }
    }

    report.durationMs = Date.now() - start;
    return report;
  }
}

// ---------------------------------------------------------------------------
// Internal: trivial semver compare (MVP — no prerelease handling)
// ---------------------------------------------------------------------------

/** Trivial semver compare. Returns negative if a<b, zero if equal, positive
 *  if a>b. No prerelease handling (MVP). Exported for unit tests. */
export function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = partsA[i] ?? 0;
    const y = partsB[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}
