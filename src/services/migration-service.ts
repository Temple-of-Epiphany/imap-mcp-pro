/**
 * Migration Service
 *
 * Applies versioned schema migrations to the SQLite database.
 *
 * Discovery: scans `src/database/` (or the provided directory) for files
 * matching `schema_update_<from>_TO_<to>.sql`. Each file is one migration
 * step; ordering is determined by the semver `<to>` version.
 *
 * Idempotency: `schema_version` is the ledger. A migration is considered
 * applied when a row with its `to` version exists. Because each step
 * runs inside a transaction that ends with an INSERT INTO schema_version,
 * a crash mid-migration rolls the whole step back — no half-applied state.
 *
 * Rollback: optional `.down.sql` alongside each migration
 * (e.g. `schema_update_1.6.0_TO_1.7.0.down.sql`). If present, rollback
 * runs it inside a transaction that ends with DELETE FROM schema_version.
 *
 * Related: Issue #36 (migration system), Issue #37 (release-based files).
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date: 2026-04-19
 * Version: 0.1.0
 */

import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';

/** Run `body` inside a SQLite transaction. node:sqlite has no built-in
 * transaction wrapper (better-sqlite3 had `db.transaction(fn)`), so we
 * roll our own: BEGIN -> body() -> COMMIT, or ROLLBACK on throw. */
function runInTransaction(db: DatabaseSync, body: () => void): void {
  db.exec('BEGIN');
  try {
    body();
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore — original error wins */ }
    throw e;
  }
}

export interface MigrationStep {
  file: string;          // Absolute path to the .sql file
  fileName: string;      // Basename (for logging)
  fromVersion: string;   // Parsed from filename
  toVersion: string;     // Parsed from filename
  rollbackFile: string | null; // Absolute path to .down.sql if one exists
}

export interface MigrationStatus {
  currentVersion: string | null;
  appliedVersions: string[];
  pending: MigrationStep[];
  applied: MigrationStep[];
}

export interface MigrationResult {
  applied: Array<{ fromVersion: string; toVersion: string; file: string }>;
  skipped: Array<{ toVersion: string; reason: string }>;
  failed: { toVersion: string; file: string; error: string } | null;
}

// Matches both schema_update_1.6.0_TO_1.7.0.sql and
// schema_update_1.6.0_to_1.7.0.sql (case-insensitive TO separator).
const FILENAME_RE = /^schema_update_(\d+\.\d+\.\d+)_TO_(\d+\.\d+\.\d+)\.sql$/i;
const ROLLBACK_RE = /^schema_update_(\d+\.\d+\.\d+)_TO_(\d+\.\d+\.\d+)\.down\.sql$/i;

function compareSemver(a: string, b: string): number {
  const av = a.split('.').map(Number);
  const bv = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (av[i] ?? 0) - (bv[i] ?? 0);
  }
  return 0;
}

export class MigrationService {
  constructor(
    private db: DatabaseSync,
    private migrationsDir: string
  ) {}

  /**
   * Scan the migrations directory and return all migration steps ordered
   * by their `to` version ascending.
   */
  discover(): MigrationStep[] {
    if (!fs.existsSync(this.migrationsDir)) return [];
    const entries = fs.readdirSync(this.migrationsDir);
    const steps: MigrationStep[] = [];
    for (const entry of entries) {
      // Skip rollback files here; we'll pair them up below.
      if (ROLLBACK_RE.test(entry)) continue;
      const m = FILENAME_RE.exec(entry);
      if (!m) continue;
      const fromVersion = m[1];
      const toVersion = m[2];
      const file = path.join(this.migrationsDir, entry);
      const rollbackName = entry.replace(/\.sql$/i, '.down.sql');
      const rollbackPath = path.join(this.migrationsDir, rollbackName);
      steps.push({
        file,
        fileName: entry,
        fromVersion,
        toVersion,
        rollbackFile: fs.existsSync(rollbackPath) ? rollbackPath : null,
      });
    }
    steps.sort((a, b) => compareSemver(a.toVersion, b.toVersion));
    return steps;
  }

  /**
   * Read the `schema_version` table and return status. Safe to call on a
   * brand-new DB where the table may not yet exist.
   */
  status(): MigrationStatus {
    let applied: string[] = [];
    try {
      const rows = this.db
        .prepare('SELECT version FROM schema_version ORDER BY applied_at ASC')
        .all() as Array<{ version: string }>;
      applied = rows.map(r => r.version);
    } catch {
      // schema_version not yet present on a fresh DB — treat as empty.
      applied = [];
    }

    const steps = this.discover();
    const appliedSet = new Set(applied);
    const pending = steps.filter(s => !appliedSet.has(s.toVersion));
    const applyList = steps.filter(s => appliedSet.has(s.toVersion));
    // Current version is the highest applied semver; prefer ledger over steps
    // so that bootstrap-only versions (inserted by schema.sql) still count.
    const currentVersion =
      applied.length === 0
        ? null
        : applied
            .slice()
            .sort((a, b) => compareSemver(b, a))[0];

    return {
      currentVersion,
      appliedVersions: applied,
      pending,
      applied: applyList,
    };
  }

  /**
   * Apply all pending migrations in order. Each step runs in its own
   * transaction so a failure aborts only that step; earlier steps stay
   * committed.
   */
  migrate(opts: { dryRun?: boolean; onStep?: (s: MigrationStep) => void } = {}): MigrationResult {
    const s = this.status();
    const result: MigrationResult = { applied: [], skipped: [], failed: null };

    for (const step of s.pending) {
      opts.onStep?.(step);
      if (opts.dryRun) {
        result.skipped.push({ toVersion: step.toVersion, reason: 'dry-run' });
        continue;
      }

      const sql = fs.readFileSync(step.file, 'utf-8');
      try {
        runInTransaction(this.db, () => {
          this.db.exec(sql);
          this.db
            .prepare(
              `INSERT OR IGNORE INTO schema_version (version, description)
               VALUES (?, ?)`
            )
            .run(
              step.toVersion,
              `Auto-applied from ${step.fileName}`
            );
        });
        result.applied.push({
          fromVersion: step.fromVersion,
          toVersion: step.toVersion,
          file: step.fileName,
        });
      } catch (e: any) {
        result.failed = {
          toVersion: step.toVersion,
          file: step.fileName,
          error: e?.message ?? String(e),
        };
        // Stop on first failure; don't apply later steps on a broken base.
        return result;
      }
    }

    return result;
  }

  /**
   * Rollback the last N applied migrations that have a matching .down.sql.
   * Migrations without a rollback file are skipped with a reason.
   */
  rollback(count: number = 1, opts: { dryRun?: boolean } = {}): {
    rolledBack: Array<{ toVersion: string; file: string }>;
    skipped: Array<{ toVersion: string; reason: string }>;
    failed: { toVersion: string; file: string; error: string } | null;
  } {
    const out: {
      rolledBack: Array<{ toVersion: string; file: string }>;
      skipped: Array<{ toVersion: string; reason: string }>;
      failed: { toVersion: string; file: string; error: string } | null;
    } = { rolledBack: [], skipped: [], failed: null };

    const s = this.status();
    // Rollback in reverse application order.
    const targets = s.applied.slice().reverse().slice(0, count);

    for (const step of targets) {
      if (!step.rollbackFile) {
        out.skipped.push({
          toVersion: step.toVersion,
          reason: 'no .down.sql file found',
        });
        continue;
      }
      if (opts.dryRun) {
        out.skipped.push({ toVersion: step.toVersion, reason: 'dry-run' });
        continue;
      }
      const sql = fs.readFileSync(step.rollbackFile, 'utf-8');
      try {
        runInTransaction(this.db, () => {
          this.db.exec(sql);
          this.db
            .prepare('DELETE FROM schema_version WHERE version = ?')
            .run(step.toVersion);
        });
        out.rolledBack.push({
          toVersion: step.toVersion,
          file: path.basename(step.rollbackFile),
        });
      } catch (e: any) {
        out.failed = {
          toVersion: step.toVersion,
          file: path.basename(step.rollbackFile),
          error: e?.message ?? String(e),
        };
        return out;
      }
    }

    return out;
  }
}
