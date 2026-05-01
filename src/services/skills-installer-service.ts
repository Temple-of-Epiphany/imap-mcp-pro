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
}

// ---------------------------------------------------------------------------
// Internal: trivial semver compare (MVP — no prerelease handling)
// ---------------------------------------------------------------------------

function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = partsA[i] ?? 0;
    const y = partsB[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}
