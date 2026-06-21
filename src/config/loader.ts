/**
 * Config loader — multi-source precedence (CLI > env > file > defaults)
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-29
 * Date Updated: 2026-04-29
 * Version: 0.1.0
 *
 * Tracker: #102. Phase 2 issue: #104.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import toml from '@iarna/toml';
import { z } from 'zod';
import {
  ServerConfig,
  ServerConfigSchema,
  ENV_VAR_MAPPING,
  SENSITIVE_FIELDS,
} from './server-config.js';

export interface LoaderOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  /** Override config file path. Falls back to env IMAP_MCP_CONFIG_PATH or none. */
  configPath?: string;
  /**
   * If true and validation fails, throw a ConfigError with all field errors.
   * Otherwise the underlying ZodError is rethrown.
   */
  strict?: boolean;
}

export interface ResolvedConfig {
  config: ServerConfig;
  /** Source of each leaf value, keyed by dotted path. */
  sources: Record<string, 'default' | 'file' | 'env' | 'cli'>;
  /** Path of the config file that was loaded, if any. */
  configFilePath: string | null;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CLI_FLAG_MAP: Record<string, string> = {
  '--database-path': 'database.path',
  '--log-level': 'logging.level',
  '--log-path': 'logging.path',
  '--mcp-user-id': 'user.mcpUserId',
};

/** Path segments that could pollute Object.prototype if used as keys. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Set a value at a dotted path in a nested object, creating intermediate
 * objects as needed.
 *
 * Prototype-pollution guard: refuse any segment named `__proto__`,
 * `constructor`, or `prototype`. Dotted paths today come from a fixed internal
 * ENV_VAR_MAPPING (not user input), so this is defense-in-depth — it keeps the
 * setter safe if it's ever driven by external data.
 */
function setPath(obj: any, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  if (parts.some((k) => UNSAFE_KEYS.has(k))) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj: any, dotted: string): unknown {
  const parts = dotted.split('.');
  let cur = obj;
  for (const k of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * Coerce a raw string env value to the most specific JS type it represents.
 * Best-effort; final validation happens in Zod.
 *
 * Strategy: try JSON.parse first (handles numbers, booleans, null, arrays,
 * objects), fall back to string. Comma-separated lists get explicit handling
 * because env vars don't carry shell array syntax.
 */
function coerceEnvValue(dottedPath: string, raw: string): unknown {
  if (raw === '') return undefined;

  // Comma-separated list (env vars can't natively express arrays).
  if (dottedPath === 'attachments.allowedDirs') {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  // Try JSON first — handles numbers, booleans, null cleanly.
  try {
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    // Not JSON. Common boolean spellings.
    if (/^(true|yes|on)$/i.test(raw)) return true;
    if (/^(false|no|off)$/i.test(raw)) return false;
    // Bare string (most env values, including enum strings like "DEBUG").
    return raw;
  }
}

function readConfigFile(filePath: string): Record<string, any> {
  const ext = path.extname(filePath).toLowerCase();
  const text = fs.readFileSync(filePath, 'utf8');
  if (ext === '.yaml' || ext === '.yml') {
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, any>;
    throw new ConfigError(`Config file at ${filePath} did not parse to an object`, []);
  }
  if (ext === '.toml') {
    return toml.parse(text) as Record<string, any>;
  }
  if (ext === '.json') {
    return JSON.parse(text);
  }
  throw new ConfigError(
    `Unrecognized config file extension '${ext}'. Use .yaml, .yml, .toml, or .json.`,
    []
  );
}

/**
 * Parse our recognized CLI flags out of argv. Returns the parsed flags as a
 * sparse partial config plus side-effect flags (printSchema, validateOnly).
 *
 * We do NOT use commander here because we want zero-touch on unknown flags
 * (the SDK transports may pass their own args through).
 */
export interface CliFlags {
  configPath: string | null;
  printSchema: boolean;
  printToolsManifest: boolean;
  validateOnly: boolean;
  overrides: Record<string, unknown>;
  positional: string[];
}

export function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    configPath: null,
    printSchema: false,
    printToolsManifest: false,
    validateOnly: false,
    overrides: {},
    positional: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') {
      flags.configPath = argv[++i] ?? null;
      continue;
    }
    if (a === '--print-config-schema') {
      flags.printSchema = true;
      continue;
    }
    if (a === '--print-tools-manifest') {
      flags.printToolsManifest = true;
      continue;
    }
    if (a === '--validate-config') {
      flags.validateOnly = true;
      continue;
    }
    if (CLI_FLAG_MAP[a]) {
      const dotted = CLI_FLAG_MAP[a];
      const raw = argv[++i];
      if (raw == null) continue;
      flags.overrides[dotted] = coerceEnvValue(dotted, raw);
      continue;
    }
    if (a.startsWith('--')) {
      // Unknown flag — keep going; SDK or test runners may inject flags.
      continue;
    }
    flags.positional.push(a);
  }
  return flags;
}

/**
 * Build a partial config from process.env using ENV_VAR_MAPPING.
 */
function envOverrides(env: NodeJS.ProcessEnv): {
  partial: Record<string, any>;
  pathsSet: string[];
} {
  const partial: Record<string, any> = {};
  const pathsSet: string[] = [];
  for (const [varName, dottedPath] of Object.entries(ENV_VAR_MAPPING)) {
    const raw = env[varName];
    if (raw == null) continue;
    const coerced = coerceEnvValue(dottedPath, raw);
    if (coerced === undefined) continue;
    setPath(partial, dottedPath, coerced);
    pathsSet.push(dottedPath);
  }
  return { partial, pathsSet };
}

/**
 * Deep-merge `src` into `dest`. Arrays in `src` replace arrays in `dest`.
 * Mutates and returns `dest`.
 */
function deepMerge(dest: any, src: any): any {
  if (src == null || typeof src !== 'object') return dest;
  for (const key of Object.keys(src)) {
    const sv = src[key];
    if (Array.isArray(sv)) {
      dest[key] = sv;
    } else if (sv !== null && typeof sv === 'object') {
      if (typeof dest[key] !== 'object' || dest[key] === null) dest[key] = {};
      deepMerge(dest[key], sv);
    } else {
      dest[key] = sv;
    }
  }
  return dest;
}

/**
 * Collect all leaf paths in a (possibly nested) object.
 */
function collectLeafPaths(obj: any, prefix = ''): string[] {
  const out: string[] = [];
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const full = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...collectLeafPaths(v, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Main entry point. Returns ResolvedConfig with the validated config and
 * provenance for each field.
 */
export function loadConfig(opts: LoaderOptions = {}): ResolvedConfig {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;

  const cliFlags = parseCliArgs(argv);
  const configPath = opts.configPath ?? cliFlags.configPath ?? env.IMAP_MCP_CONFIG_PATH ?? null;

  // 1. Defaults — parse empty object through schema to get all defaults applied.
  const defaults = ServerConfigSchema.parse({});

  // 2. File overrides
  let fileOverrides: Record<string, any> = {};
  let configFilePath: string | null = null;
  if (configPath) {
    if (!fs.existsSync(configPath)) {
      throw new ConfigError(`Config file not found: ${configPath}`, []);
    }
    fileOverrides = readConfigFile(configPath);
    configFilePath = path.resolve(configPath);
  }

  // 3. Env overrides
  const envResult = envOverrides(env);
  const envSources = new Set(envResult.pathsSet);

  // 4. CLI overrides — flat dotted-path overrides
  const cliOverrides: Record<string, any> = {};
  for (const [dotted, value] of Object.entries(cliFlags.overrides)) {
    setPath(cliOverrides, dotted, value);
  }
  const cliSources = new Set(Object.keys(cliFlags.overrides));

  // 5. Merge: defaults <- file <- env <- cli
  const merged: any = deepMerge({}, defaults);
  const fileLeafPaths = collectLeafPaths(fileOverrides);
  deepMerge(merged, fileOverrides);
  deepMerge(merged, envResult.partial);
  deepMerge(merged, cliOverrides);

  // 6. Validate
  let validated: ServerConfig;
  try {
    validated = ServerConfigSchema.parse(merged);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const issues = e.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      throw new ConfigError(
        `Configuration validation failed:\n` +
          issues.map(i => `  - ${i.path}: ${i.message}`).join('\n'),
        issues
      );
    }
    throw e;
  }

  // 7. Provenance map
  const sources: Record<string, 'default' | 'file' | 'env' | 'cli'> = {};
  const allLeaves = collectLeafPaths(validated as any);
  for (const p of allLeaves) {
    if (cliSources.has(p)) sources[p] = 'cli';
    else if (envSources.has(p)) sources[p] = 'env';
    else if (fileLeafPaths.includes(p)) sources[p] = 'file';
    else sources[p] = 'default';
  }

  return { config: validated, sources, configFilePath };
}

/**
 * Build a printable summary of resolved config with secrets redacted.
 */
export function formatResolvedConfig(resolved: ResolvedConfig): string {
  const { config, sources, configFilePath } = resolved;
  const allLeaves = collectLeafPaths(config as any);
  const lines: string[] = [];
  lines.push('IMAP MCP Pro — resolved configuration');
  lines.push('─'.repeat(60));
  if (configFilePath) lines.push(`Config file: ${configFilePath}`);
  lines.push('');
  for (const p of allLeaves) {
    const value = getPath(config, p);
    const display = SENSITIVE_FIELDS.has(p) && value != null ? '<redacted>' : JSON.stringify(value);
    const source = sources[p] ?? 'default';
    lines.push(`  ${p.padEnd(48)} = ${display}  [${source}]`);
  }
  return lines.join('\n');
}

/**
 * Validate file/dir paths after schema validation. These checks need IO so
 * they live outside the Zod schema to keep schema purity.
 */
export function validatePaths(config: ServerConfig): { errors: string[] } {
  const errors: string[] = [];

  // Database parent dir must exist
  const dbDir = path.dirname(config.database.path);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    fs.accessSync(dbDir, fs.constants.W_OK);
  } catch (e: any) {
    errors.push(`database.path parent directory not writable: ${dbDir} (${e.message})`);
  }

  // Allowed attachment dirs must exist + readable + absolute
  for (const d of config.attachments.allowedDirs) {
    if (!path.isAbsolute(d)) {
      errors.push(`attachments.allowedDirs entry must be absolute: ${d}`);
      continue;
    }
    try {
      fs.accessSync(d, fs.constants.R_OK);
    } catch (e: any) {
      errors.push(`attachments.allowedDirs entry not readable: ${d} (${e.message})`);
    }
  }

  // Staging dir — create if missing
  try {
    if (!fs.existsSync(config.attachments.stagingDir)) {
      fs.mkdirSync(config.attachments.stagingDir, { recursive: true });
    }
    fs.accessSync(config.attachments.stagingDir, fs.constants.W_OK);
  } catch (e: any) {
    errors.push(
      `attachments.stagingDir not writable: ${config.attachments.stagingDir} (${e.message})`
    );
  }

  // Results root
  try {
    if (!fs.existsSync(config.contextReduction.resultsRootDir)) {
      fs.mkdirSync(config.contextReduction.resultsRootDir, { recursive: true });
    }
    fs.accessSync(config.contextReduction.resultsRootDir, fs.constants.W_OK);
  } catch (e: any) {
    errors.push(
      `contextReduction.resultsRootDir not writable: ${config.contextReduction.resultsRootDir} (${e.message})`
    );
  }

  return { errors };
}
