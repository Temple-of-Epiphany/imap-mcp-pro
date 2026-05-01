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
 * Date Updated: 2026-05-01
 * Version: 1.1.0
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
// Summary
// ---------------------------------------------------------------------------

const parts = [
  `schema.sql + ${migrations.length} migration file${migrations.length === 1 ? '' : 's'}`,
];
if (manifestCopied) parts.push('migrations-manifest.json');
if (skillsCopied > 0) parts.push(`${skillsCopied} bundled skill${skillsCopied === 1 ? '' : 's'}`);

console.log(`[postbuild] copied ${parts.join(' + ')}`);
