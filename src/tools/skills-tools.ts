/**
 * skills-tools.ts — MCP tools for checking + applying skill updates from
 * the public claude-skills-library GitHub repo.
 *
 * v2.17.4 (#138). Two tools, intentionally split:
 *
 *   - imap_check_skill_updates : read-only — surfaces "what's available"
 *   - imap_update_skills       : write — applies updates for explicitly
 *                                named skills (no "update everything"
 *                                shortcut)
 *
 * Trust model: skills are instructions to Claude. Whoever controls the
 * source repo controls the LLM workflow. Updates are user-confirmed:
 * `imap_update_skills` requires the caller to pass an explicit `skills`
 * array. There is no automatic background fetch.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-02
 * Version: 0.1.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { sanitizeText } from '../utils/sanitize-content.js';
import {
  SkillsInstallerService,
  defaultGitHubSource,
} from '../services/skills-installer-service.js';

export function skillsTools(
  server: McpServer,
  installer: SkillsInstallerService,
): void {
  // -------------------------------------------------------------------
  // imap_check_skill_updates — read-only check, surfaces availability.
  // -------------------------------------------------------------------
  server.registerTool('imap_check_skill_updates', {
    description:
      'Check public GitHub for newer skill versions without changing anything ' +
      'on disk. Compares each skill in the bundled manifest against the ' +
      'latest version.json on GitHub. Returns a per-skill status with ' +
      'installed/bundled/available versions and a hasUpdate flag. Skills are ' +
      'instructions to the LLM — review the diff before applying via ' +
      'imap_update_skills.',
    inputSchema: {
      ref: z.string().optional()
        .describe('GitHub ref to check against (branch, tag, or commit SHA). Default: "main".'),
      timeoutMs: z.number().int().positive().optional()
        .describe('Network timeout per file in milliseconds. Default: 10000.'),
    },
  }, withErrorHandling(async ({ ref, timeoutMs }) => {
    const source = ref ? { ...defaultGitHubSource(), ref } : defaultGitHubSource();
    const report = await installer.checkForUpdates({ source, timeoutMs });

    // v2.17.7 (#145): minimize the response shape to reduce content
    // surface area. Same defensive principle as v2.17.6 — bounded,
    // sanitized strings for every field that's user-visible. Drop
    // baseUrl (informational; can be reconstructed from `source`),
    // cap fetchError to 200 chars, sanitize summary text.
    const minimal = {
      checkedAt: report.checkedAt,
      source: report.source,
      skills: report.skills.map(s => ({
        name: s.name,
        installed: s.installed,
        bundled: s.bundled,
        available: s.available,
        hasUpdate: s.hasUpdate,
        fetchError: sanitizeText(s.fetchError, 200),
      })),
      summary: sanitizeText(report.summary, 300) ?? '',
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(minimal, null, 2),
      }],
    };
  }));

  // -------------------------------------------------------------------
  // imap_update_skills — apply updates for explicitly named skills.
  // -------------------------------------------------------------------
  server.registerTool('imap_update_skills', {
    description:
      'Apply skill updates from public GitHub for explicitly named skills. ' +
      'Fetches SKILL.md + version.json from raw.githubusercontent.com, writes ' +
      'to ~/.claude/skills/imap-mcp-pro/<name>/, preserves files when the ' +
      'on-disk version is already at or ahead of remote unless force=true. ' +
      'Skills not present in the bundled manifest are rejected (the manifest ' +
      'is the allowlist). Always pair with imap_check_skill_updates first to ' +
      'see what would change.',
    inputSchema: {
      skills: z.array(z.string()).min(1)
        .describe('Skill names to update (must be in the bundled manifest). Required and non-empty.'),
      ref: z.string().optional()
        .describe('GitHub ref (branch, tag, or commit SHA). Default: "main".'),
      force: z.boolean().optional()
        .describe('If true, overwrite even when on-disk version >= remote. Default: false.'),
      timeoutMs: z.number().int().positive().optional()
        .describe('Network timeout per file in milliseconds. Default: 10000.'),
    },
  }, withErrorHandling(async ({ skills, ref, force, timeoutMs }) => {
    const source = ref ? { ...defaultGitHubSource(), ref } : defaultGitHubSource();
    const report = await installer.updateFromGitHub({
      skills,
      source,
      force,
      timeoutMs,
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(report, null, 2),
      }],
    };
  }));
}
