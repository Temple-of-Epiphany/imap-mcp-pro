#!/usr/bin/env node
/**
 * Migration CLI — status/up/down for the schema_version ledger
 *
 * Commands:
 *   migrate              apply all pending migrations
 *   migrate status       show current version and pending/applied list
 *   migrate up           alias for default apply
 *   migrate down [N=1]   rollback the last N applied migrations
 *   migrate dry-run      report what would be applied without writing
 *
 * Issue #36 (auto-migrate) / #37 (release-based files).
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date: 2026-04-19
 * Version: 0.1.0
 */

import { DatabaseService } from '../services/database-service.js';

function fmt(json: unknown): string {
  return JSON.stringify(json, null, 2);
}

async function main() {
  // Parse argv after script path.
  const [, , subCmd, arg] = process.argv;
  const cmd = subCmd ?? 'up';

  // Skip auto-migrate so the CLI has clear before/after state to report.
  process.env.IMAP_MCP_SKIP_MIGRATIONS = '1';
  const db = new DatabaseService();
  const mig = db.getMigrationService();

  switch (cmd) {
    case 'status': {
      const s = mig.status();
      console.log(fmt({
        currentVersion: s.currentVersion,
        appliedCount: s.applied.length,
        pendingCount: s.pending.length,
        pending: s.pending.map(x => ({
          from: x.fromVersion,
          to: x.toVersion,
          file: x.fileName,
          hasRollback: x.rollbackFile !== null,
        })),
        applied: s.applied.map(x => ({
          from: x.fromVersion,
          to: x.toVersion,
          file: x.fileName,
        })),
      }));
      break;
    }
    case 'up':
    case undefined: {
      const r = mig.migrate({
        onStep: (s) => console.error(`[migrate] applying ${s.fromVersion} -> ${s.toVersion} (${s.fileName})`),
      });
      console.log(fmt(r));
      if (r.failed) process.exit(1);
      break;
    }
    case 'dry-run': {
      const r = mig.migrate({
        dryRun: true,
        onStep: (s) => console.error(`[migrate] would apply ${s.fromVersion} -> ${s.toVersion} (${s.fileName})`),
      });
      console.log(fmt(r));
      break;
    }
    case 'down': {
      const n = arg ? Math.max(1, parseInt(arg, 10)) : 1;
      const r = mig.rollback(n);
      console.log(fmt(r));
      if (r.failed) process.exit(1);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Usage: migrate [status|up|dry-run|down [N]]');
      process.exit(2);
  }
}

main().catch(err => {
  console.error('Migration CLI failed:', err);
  process.exit(1);
});
