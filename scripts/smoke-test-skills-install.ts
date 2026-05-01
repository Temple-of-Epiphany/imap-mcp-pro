#!/usr/bin/env tsx
/**
 * smoke-test-skills-install.ts — exercise SkillsInstallerService end-to-end.
 *
 * Verifies that the installer:
 *   1. Reads the bundle manifest from dist/skills/manifest.json
 *   2. Copies each skill to ~/.claude/skills/imap-mcp-pro/<name>/
 *   3. Skips on second run (versions match)
 *   4. Re-overwrites when version on disk is older than bundled
 *   5. Honors IMAP_MCP_SKIP_SKILLS_INSTALL=1
 *
 * Usage:
 *   npm run build && npx tsx scripts/smoke-test-skills-install.ts
 *
 * Author: Colin Bitterfield
 * Date: 2026-05-01
 * Version: 0.1.0
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillsInstallerService } from '../src/services/skills-installer-service.js';

const bundleDir = path.resolve('dist/skills');
const installDir = path.join(os.homedir(), '.claude', 'skills', 'imap-mcp-pro');

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; }
  catch { return false; }
}

async function readVersion(p: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(p, 'version.json'), 'utf8');
    return JSON.parse(raw).version ?? null;
  } catch { return null; }
}

async function clean() {
  if (await exists(installDir)) {
    await fs.rm(installDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`\n=== SkillsInstallerService smoke test ===`);
  console.log(`Bundle:  ${bundleDir}`);
  console.log(`Install: ${installDir}\n`);

  // Sanity check: bundle exists
  if (!await exists(path.join(bundleDir, 'manifest.json'))) {
    console.error('FATAL: dist/skills/manifest.json not found. Run npm run build first.');
    process.exit(2);
  }

  // ---- Test 1: Fresh install ----
  console.log('[1] Fresh install (no existing skills)');
  await clean();
  const installer = new SkillsInstallerService(bundleDir);
  const r1 = await installer.install();
  console.log(`    installed: ${JSON.stringify(r1.installed)}, updated: ${JSON.stringify(r1.updated)}, skipped: ${r1.skipped}, durationMs: ${r1.durationMs}`);
  const skillMd = path.join(installDir, 'unsubscribe-cleanup', 'SKILL.md');
  const skillVer = path.join(installDir, 'unsubscribe-cleanup', 'version.json');
  const t1ok = await exists(skillMd) && await exists(skillVer) && r1.installed.includes('unsubscribe-cleanup');
  console.log(`    files exist + reported as installed: ${t1ok ? '✓' : '✗'}`);

  // ---- Test 2: Idempotent re-install (no-op) ----
  console.log('\n[2] Re-install (versions match, expect unchanged)');
  const r2 = await installer.install();
  console.log(`    installed: ${JSON.stringify(r2.installed)}, updated: ${JSON.stringify(r2.updated)}, unchanged: ${r2.unchanged.length}, durationMs: ${r2.durationMs}`);
  const t2ok = r2.installed.length === 0 && r2.updated.length === 0 && r2.unchanged.includes('unsubscribe-cleanup');
  console.log(`    no-op + reports unchanged: ${t2ok ? '✓' : '✗'}`);

  // ---- Test 3: Older on-disk version triggers update ----
  console.log('\n[3] Older on-disk version triggers update');
  await fs.writeFile(skillVer, JSON.stringify({ name: 'unsubscribe-cleanup', version: '0.0.1' }, null, 2));
  const r3 = await installer.install();
  console.log(`    installed: ${JSON.stringify(r3.installed)}, updated: ${JSON.stringify(r3.updated)}, durationMs: ${r3.durationMs}`);
  const restoredVersion = await readVersion(path.join(installDir, 'unsubscribe-cleanup'));
  const t3ok = r3.updated.includes('unsubscribe-cleanup') && restoredVersion === '0.1.0';
  console.log(`    updated + version restored to bundled (${restoredVersion}): ${t3ok ? '✓' : '✗'}`);

  // ---- Test 4: Newer on-disk version preserved ----
  console.log('\n[4] Newer on-disk version preserved');
  await fs.writeFile(skillVer, JSON.stringify({ name: 'unsubscribe-cleanup', version: '99.0.0' }, null, 2));
  const r4 = await installer.install();
  console.log(`    installed: ${JSON.stringify(r4.installed)}, updated: ${JSON.stringify(r4.updated)}, preserved: ${JSON.stringify(r4.preserved)}, durationMs: ${r4.durationMs}`);
  const stillNew = await readVersion(path.join(installDir, 'unsubscribe-cleanup'));
  const t4ok = r4.preserved.includes('unsubscribe-cleanup') && stillNew === '99.0.0';
  console.log(`    preserved + on-disk version untouched (${stillNew}): ${t4ok ? '✓' : '✗'}`);

  // ---- Test 5: IMAP_MCP_SKIP_SKILLS_INSTALL=1 ----
  console.log('\n[5] IMAP_MCP_SKIP_SKILLS_INSTALL=1 short-circuits');
  process.env.IMAP_MCP_SKIP_SKILLS_INSTALL = '1';
  const r5 = await installer.install();
  delete process.env.IMAP_MCP_SKIP_SKILLS_INSTALL;
  const t5ok = r5.skipped === true && r5.installed.length === 0 && r5.durationMs < 5;
  console.log(`    skipped: ${r5.skipped}, durationMs: ${r5.durationMs} → ${t5ok ? '✓' : '✗'}`);

  // ---- Cleanup: restore proper version on disk ----
  await clean();
  await installer.install();
  console.log(`\nCleaned + reinstalled at proper version.`);

  // ---- Summary ----
  const all = [t1ok, t2ok, t3ok, t4ok, t5ok];
  const passed = all.filter(Boolean).length;
  console.log(`\n=== ${passed}/${all.length} pass ===`);
  process.exit(passed === all.length ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
