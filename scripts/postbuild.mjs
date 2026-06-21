#!/usr/bin/env node
/**
 * postbuild.mjs — stage runtime artifacts from source dirs into dist/ after
 * `tsc` runs. Cross-platform replacement for the previous `mkdir -p && cp`
 * shell chain that broke on Windows cmd.exe (issue #122).
 *
 * What gets copied:
 *
 *   src/database/                  → dist/database/
 *     schema.sql                   (required; hard error if missing)
 *     schema_update_*.sql          (versioned migrations + .down rollbacks)
 *     migrations-manifest.json     (optional; non-fatal if absent)
 *
 *   skills/                        → dist/skills/   (v2.17.0 MVP, issue #124)
 *     manifest.json                (skill bundle manifest)
 *     <skill-name>/SKILL.md        (skill content)
 *     <skill-name>/version.json    (per-skill version metadata)
 *
 * Excluded:
 *   src/database/migrations/       (legacy SQL not loaded by src/)
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Date Updated: 2026-06-21
 * Version: 1.2.0
 *
 * Changelog:
 *   1.2.0 (2026-06-21) — regenerate docs/TOOL_CATALOG.md from the built server (#201).
 *   1.1.0 (2026-05-01) — bundle skills + web UI assets into dist/.
 */

import { mkdir, copyFile, readdir, cp, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Schema migrations: src/database -> dist/database
// ---------------------------------------------------------------------------

const SCHEMA_SRC = 'src/database';
const SCHEMA_DST = 'dist/database';

await mkdir(SCHEMA_DST, { recursive: true });

// Required: base schema
await copyFile(join(SCHEMA_SRC, 'schema.sql'), join(SCHEMA_DST, 'schema.sql'));

// All schema_update_*.sql files (forward + .down.sql rollbacks)
const schemaEntries = await readdir(SCHEMA_SRC);
const migrations = schemaEntries.filter((f) => /^schema_update_.*\.sql$/i.test(f));
for (const f of migrations) {
  await copyFile(join(SCHEMA_SRC, f), join(SCHEMA_DST, f));
}

// Optional: manifest
let manifestCopied = false;
try {
  await copyFile(
    join(SCHEMA_SRC, 'migrations-manifest.json'),
    join(SCHEMA_DST, 'migrations-manifest.json'),
  );
  manifestCopied = true;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

// ---------------------------------------------------------------------------
// Skills bundle: skills/ -> dist/skills (only if skills/ exists at repo root)
// ---------------------------------------------------------------------------

let skillsCopied = 0;
try {
  await stat('skills');
  await cp('skills', 'dist/skills', { recursive: true });
  const skillDirs = await readdir('dist/skills', { withFileTypes: true });
  skillsCopied = skillDirs.filter((d) => d.isDirectory()).length;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  // No skills/ directory at repo root — nothing to bundle.
}

// ---------------------------------------------------------------------------
// Web UI assets: public/ -> dist/public (v2.17.10, #150)
// ---------------------------------------------------------------------------
//
// The embedded WebUIServer (src/web/server.ts) probes two static-asset
// candidates: ../../public (dev: src/web/../../public) and ../public
// (prod: dist/web/../public = dist/public). Without this stage the prod
// path 404s every request. dxt/build.mjs copies dist/ into the .mcpb
// recursively, so dist/public/ flows through into the extension bundle
// for free.

let publicAssetCount = 0;
try {
  await stat('public');
  await cp('public', 'dist/public', { recursive: true });
  const publicEntries = await readdir('dist/public', { recursive: true });
  publicAssetCount = publicEntries.length;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  // No public/ at repo root — Web UI is intentionally absent.
}

// ---------------------------------------------------------------------------
// Tool catalog: regenerate docs/TOOL_CATALOG.md from the just-built server (#201)
// ---------------------------------------------------------------------------
//
// Keeps the documented tool catalog in lockstep with the registered tools.
// gen-tool-catalog.mjs spawns the built server (pointed at a throwaway DB) to
// read the live manifest. Non-fatal: a docs hiccup must never fail the build.

let catalogGenerated = false;
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', ['scripts/gen-tool-catalog.mjs'], { stdio: 'ignore' });
  catalogGenerated = true;
} catch (e) {
  console.warn(`[postbuild] tool catalog generation skipped: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const parts = [
  `schema.sql + ${migrations.length} migration file${migrations.length === 1 ? '' : 's'}`,
];
if (manifestCopied) parts.push('migrations-manifest.json');
if (skillsCopied > 0) parts.push(`${skillsCopied} bundled skill${skillsCopied === 1 ? '' : 's'}`);
if (publicAssetCount > 0) parts.push(`${publicAssetCount} web UI asset${publicAssetCount === 1 ? '' : 's'}`);
if (catalogGenerated) parts.push('docs/TOOL_CATALOG.md');

console.log(`[postbuild] copied ${parts.join(' + ')}`);
