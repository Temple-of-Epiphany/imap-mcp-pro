#!/usr/bin/env node
/**
 * postbuild.mjs — copy schema artifacts from src/database into dist/database
 * after `tsc` runs. Cross-platform replacement for the previous
 * `mkdir -p && cp` shell chain that broke on Windows cmd.exe (issue #122).
 *
 * Files copied:
 *   - schema.sql                       (required; hard error if missing)
 *   - schema_update_*.sql              (versioned migrations)
 *   - schema_update_*.down.sql         (rollback companions)
 *   - migrations-manifest.json         (optional; non-fatal if absent)
 *
 * NOT copied:
 *   - migrations/ subdirectory         (legacy SQL not loaded by src/)
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Version: 1.0.0
 */

import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'src/database';
const DST = 'dist/database';

await mkdir(DST, { recursive: true });

// Required: base schema
await copyFile(join(SRC, 'schema.sql'), join(DST, 'schema.sql'));

// All schema_update_*.sql files (forward + .down.sql rollbacks)
const entries = await readdir(SRC);
const migrations = entries.filter((f) => /^schema_update_.*\.sql$/i.test(f));
for (const f of migrations) {
  await copyFile(join(SRC, f), join(DST, f));
}

// Optional: manifest
let manifestCopied = false;
try {
  await copyFile(
    join(SRC, 'migrations-manifest.json'),
    join(DST, 'migrations-manifest.json'),
  );
  manifestCopied = true;
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

console.log(
  `[postbuild] copied schema.sql + ${migrations.length} migration file${migrations.length === 1 ? '' : 's'}` +
    (manifestCopied ? ' + migrations-manifest.json' : ''),
);
