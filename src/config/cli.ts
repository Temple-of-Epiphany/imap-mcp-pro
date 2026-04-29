/**
 * CLI dispatcher for short-circuit flags
 *
 * Handles --print-config-schema, --validate-config, and --print-tools-manifest
 * before normal server startup. Each flag prints to stdout and exits cleanly.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-29
 * Date Updated: 2026-04-29
 * Version: 0.1.0
 *
 * Tracker: #102. Phase 2 issue: #104.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
import {
  loadConfig,
  formatResolvedConfig,
  validatePaths,
  parseCliArgs,
  ConfigError,
} from './loader.js';
import { ServerConfigSchema } from './server-config.js';

/**
 * Documented exit codes (Phase 3 will reuse these for runtime errors).
 */
export const EXIT_CODES = {
  OK: 0,
  CONFIG_ERROR: 1,
  DATABASE_ERROR: 2,
  DEPENDENCY_ERROR: 3,
  PERMISSION_ERROR: 4,
} as const;

/**
 * Inspect argv, dispatch to the appropriate short-circuit handler, and exit.
 * Returns true if the process should continue with normal startup, false if
 * a short-circuit handler ran (caller should exit).
 *
 * For --print-tools-manifest the caller is expected to handle it because it
 * needs the full tool registration pipeline (handler is a callback).
 */
export interface DispatcherOptions {
  argv?: string[];
  printToolsManifestHandler?: () => Promise<unknown>;
}

export async function dispatchCli(opts: DispatcherOptions = {}): Promise<boolean> {
  const argv = opts.argv ?? process.argv.slice(2);
  const flags = parseCliArgs(argv);

  if (flags.printSchema) {
    // The bypass for stdout silencing in index.ts only allows JSON.
    // zodToJsonSchema returns a JSON-serializable object — perfect.
    // Cast to any to short-circuit deep-instantiation type checking. Runtime
    // behavior is identical; only the type-level inference explodes on the
    // full nested ServerConfigSchema. Same root cause as the SDK 1.23+ issue
    // documented in docs/sdk_audit_2026-04-29.md.
    const schema = (zodToJsonSchema as any)(ServerConfigSchema, {
      name: 'ServerConfig',
      $refStrategy: 'none',
    });
    process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
    process.exit(EXIT_CODES.OK);
  }

  if (flags.validateOnly) {
    try {
      const resolved = loadConfig({ argv });
      const { errors } = validatePaths(resolved.config);
      // Always print the resolved summary to stderr so secrets-redacted output
      // doesn't go to stdout (which is reserved for JSON-RPC).
      process.stderr.write(formatResolvedConfig(resolved) + '\n');
      if (errors.length > 0) {
        process.stderr.write('\nPath validation errors:\n');
        for (const e of errors) process.stderr.write(`  - ${e}\n`);
        process.exit(EXIT_CODES.PERMISSION_ERROR);
      }
      process.stderr.write('\nConfiguration valid.\n');
      process.exit(EXIT_CODES.OK);
    } catch (e) {
      if (e instanceof ConfigError) {
        process.stderr.write(`${e.message}\n`);
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }
      throw e;
    }
  }

  if (flags.printToolsManifest) {
    if (!opts.printToolsManifestHandler) {
      process.stderr.write('--print-tools-manifest requires a handler (Phase 4 wires this up).\n');
      process.exit(EXIT_CODES.DEPENDENCY_ERROR);
    }
    const manifest = await opts.printToolsManifestHandler();
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    process.exit(EXIT_CODES.OK);
  }

  return true;
}
