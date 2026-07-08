// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Regression guard for #279: schema.sql must be a COMPLETE snapshot of the
// current schema. Because schema.sql seeds schema_version up through the latest
// release, the migrator skips the corresponding schema_update_*.sql files on a
// fresh DB — so any table introduced only in a (seeded) migration and not
// mirrored into schema.sql is silently absent on every fresh install.
//
// This test applies schema.sql to a fresh in-memory DB (twice, to prove
// idempotency) and asserts that every table created by a migration whose
// version is seeded in schema.sql actually exists.

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

function seededSchemaVersions(schema: string): Set<string> {
  const versions = new Set<string>();
  const re = /INSERT OR IGNORE INTO schema_version[^)]*\)\s*VALUES\s*\('([^']+)'/gi;
  for (const m of schema.matchAll(re)) versions.add(m[1]);
  return versions;
}

function tablesInSql(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
}

describe('schema.sql completeness (#279)', () => {
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'migrations-manifest.json'), 'utf8'));
  const seeded = seededSchemaVersions(schema);

  it('applies cleanly and idempotently to a fresh DB', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => { db.exec(schema); db.exec(schema); }).not.toThrow();
    db.close();
  });

  it('contains every table from migrations whose version schema.sql seeds', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    const live = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name),
    );

    const missing: string[] = [];
    for (const mig of manifest.migrations) {
      // Only migrations the fresh-DB seed marks as already-applied are the risk:
      // those get skipped by the migrator, so schema.sql must carry their tables.
      if (!seeded.has(mig.to)) continue;
      const sql = fs.readFileSync(path.join(here, mig.file), 'utf8');
      for (const t of tablesInSql(sql)) {
        if (!live.has(t)) missing.push(`${t} (from ${mig.file})`);
      }
    }
    db.close();
    expect(missing, `tables missing from schema.sql: ${missing.join(', ')}`).toEqual([]);
  });

  it('has the specific tables from the #279 report', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    for (const t of ['categories', 'dns_firewall_cache', 'dns_firewall_providers']) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      expect(row, `${t} should exist in a fresh schema.sql DB`).toBeTruthy();
    }
    // Quad9 seed present exactly once (INSERT OR IGNORE, re-run safe)
    db.exec(schema);
    const n = (db.prepare('SELECT count(*) c FROM dns_firewall_providers').get() as any).c;
    expect(n).toBe(1);
    db.close();
  });
});
