/**
 * ServerConfig — Zod schema for all server configuration
 *
 * Single source of truth for every tunable. Used by the loader (multi-source
 * precedence: CLI > env > file > defaults) and consumed by the MCP server,
 * services, and the .mcpb manifest's user_config panel.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-29
 * Date Updated: 2026-04-29
 * Version: 0.1.0
 *
 * Tracker: #102. Phase 2 issue: #104.
 */

import { z } from 'zod';
import os from 'os';
import path from 'path';

const HOME = os.homedir();
const DEFAULT_DATA_DIR = path.join(HOME, '.imap-mcp');

const LogLevel = z.enum(['DEBUG', 'INFO', 'WARNING', 'ERROR']);
export type LogLevel = z.infer<typeof LogLevel>;

export const ServerConfigSchema = z.object({
  database: z.object({
    path: z.string()
      .min(1)
      .default(path.join(DEFAULT_DATA_DIR, 'data.db'))
      .describe('Absolute path to the SQLite database file. Parent directory must be writable.'),
    skipMigrations: z.boolean()
      .default(false)
      .describe('If true, skip the auto-migration on DatabaseService construction. Useful for the migrate CLI to take explicit control.'),
  }).default({}).describe('Database configuration'),

  encryption: z.object({
    masterKey: z.string()
      .nullable()
      .default(null)
      .describe('Master encryption key for credential storage. If null, derive from the OS keyring (Claude Desktop) or the on-disk key file (standard install).'),
    claudeDesktopExtension: z.boolean()
      .default(false)
      .describe('Set to true when running as a Claude Desktop extension (.mcpb). Activates keyring-based key storage paths.'),
  }).default({}).describe('Encryption configuration'),

  attachments: z.object({
    allowedDirs: z.array(z.string())
      .default([])
      .describe('Directories the server may read attachments from for path-based attachment sends. Empty list disables the feature. Each entry must be an absolute path.'),
    maxSizeBytes: z.number().int().positive()
      .default(25 * 1024 * 1024)
      .describe('Per-attachment size limit in bytes. Default 25 MiB.'),
    maxTotalSizeBytes: z.number().int().positive()
      .default(50 * 1024 * 1024)
      .describe('Aggregate attachment size limit per message in bytes. Default 50 MiB.'),
    stagingDir: z.string()
      .min(1)
      .default(path.join(DEFAULT_DATA_DIR, 'staging'))
      .describe('Directory for chunked attachment staging uploads. Created if missing.'),
    stagingTtlSeconds: z.number().int().positive()
      .default(3600)
      .describe('Staging session lifetime in seconds. Default 1 hour.'),
  }).default({}).describe('Attachment configuration'),

  smtp: z.object({
    poolMaxPerAccount: z.number().int().min(1).max(50)
      .default(3)
      .describe('Maximum concurrent SMTP connections per account.'),
    poolIdleTimeoutSeconds: z.number().int().positive()
      .default(60)
      .describe('Close idle SMTP connections after this many seconds.'),
    retryMaxAttempts: z.number().int().min(0).max(10)
      .default(3)
      .describe('Retry count for transient SMTP failures.'),
  }).default({}).describe('SMTP configuration'),

  imap: z.object({
    autoCreateSentFolder: z.boolean()
      .default(false)
      .describe('Create a Sent folder automatically if one cannot be detected. Per RFC 6154 SPECIAL-USE.'),
  }).default({}).describe('IMAP configuration'),

  contextReduction: z.object({
    inlineThreshold: z.number().int().positive()
      .default(20)
      .describe('Row count above which auto-mode promotes the response from inline to a handle envelope.'),
    fileThreshold: z.number().int().positive()
      .default(500)
      .describe('Row count above which a handle becomes file-backed instead of inline-encrypted.'),
    inlineByteBudget: z.number().int().positive()
      .default(256 * 1024)
      .describe('Inline byte budget. Auto-mode promotes to handle even with few rows if their JSON exceeds this size.'),
    inlineLimitCap: z.number().int().positive()
      .default(100)
      .describe('Maximum rows a tool may return inline.'),
    handleLimitCap: z.number().int().positive()
      .default(10000)
      .describe('Maximum rows a tool may stash in a handle.'),
    resultTtlMs: z.number().int().positive()
      .default(2 * 60 * 60 * 1000)
      .describe('Default temporary-result TTL in milliseconds. 2 hours by default.'),
    maxResultsPerUser: z.number().int().positive()
      .default(50)
      .describe('Maximum cached results per user (LRU evicted beyond this).'),
    perUserDiskQuota: z.number().int().positive()
      .default(500 * 1024 * 1024)
      .describe('Per-user disk quota for file-backed results in bytes. Default 500 MiB.'),
    cleanupIntervalMs: z.number().int().positive()
      .default(5 * 60 * 1000)
      .describe('Result cleanup sweep interval in milliseconds.'),
    workerPoolSize: z.number().int().positive().nullable()
      .default(null)
      .describe('Worker pool size for parsing/summarization. If null, derive from CPU count: min(4, max(2, cpus-1)).'),
    workerTaskTimeoutMs: z.number().int().positive()
      .default(30 * 1000)
      .describe('Per-task worker timeout in milliseconds.'),
    previewChars: z.number().int().positive()
      .default(200)
      .describe('Body preview character count in row summaries.'),
    firstNPreviewRows: z.number().int().positive()
      .default(5)
      .describe('Number of preview rows in handle envelopes.'),
    jsonlThresholdRows: z.number().int().positive()
      .default(5000)
      .describe('Switch from JSON to JSONL for file-backed results above this row count.'),
    attachmentMaxBytes: z.number().int().positive()
      .default(10 * 1024 * 1024)
      .describe('Attachment policy ceiling for the result-cache subsystem.'),
    resultsRootDir: z.string()
      .min(1)
      .default(path.join(DEFAULT_DATA_DIR, 'results'))
      .describe('Filesystem root for file-backed result storage.'),
  }).default({}).describe('Context-reduction (handle/file response) tunables. See PR #94.'),

  logging: z.object({
    level: LogLevel
      .default('INFO')
      .describe('Server log verbosity. DEBUG | INFO | WARNING | ERROR.'),
    path: z.string().nullable()
      .default(null)
      .describe('Log file destination. If null, log to stderr only (the standard MCP-stdio path that Claude Desktop captures).'),
  }).default({}).describe('Logging configuration'),

  user: z.object({
    mcpUserId: z.string()
      .min(1)
      .default('default')
      .describe('Username for tool-context resolution in multi-tenant deployments. Set by Claude Desktop env or .mcpb manifest.'),
  }).default({}).describe('User context'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Sentinel object used by the loader to know which fields originated from
 * the schema's defaults (vs. an override source). Useful for structured
 * "resolved values" logging in --validate-config.
 */
export const CONFIG_SOURCES = {
  default: 'default',
  file: 'file',
  env: 'env',
  cli: 'cli',
} as const;
export type ConfigSource = typeof CONFIG_SOURCES[keyof typeof CONFIG_SOURCES];

/**
 * Map of legacy environment variable names to their ServerConfig dotted path.
 * The loader uses this to translate process.env into the typed schema.
 *
 * This list is the canonical source of backward-compatibility — every var
 * documented in the README before this refactor MUST appear here.
 */
export const ENV_VAR_MAPPING: Record<string, string> = {
  // Database
  IMAP_MCP_DATABASE_PATH: 'database.path',
  IMAP_MCP_SKIP_MIGRATIONS: 'database.skipMigrations',

  // Encryption
  IMAP_MCP_ENCRYPTION_KEY: 'encryption.masterKey',
  CLAUDE_DESKTOP_EXTENSION: 'encryption.claudeDesktopExtension',

  // Attachments
  IMAP_MCP_ALLOWED_ATTACHMENT_DIRS: 'attachments.allowedDirs',
  IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES: 'attachments.maxSizeBytes',
  IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES: 'attachments.maxTotalSizeBytes',
  IMAP_MCP_ATTACHMENT_STAGING_DIR: 'attachments.stagingDir',
  IMAP_MCP_STAGING_TTL_SECONDS: 'attachments.stagingTtlSeconds',

  // SMTP
  IMAP_MCP_SMTP_POOL_MAX_PER_ACCOUNT: 'smtp.poolMaxPerAccount',
  IMAP_MCP_SMTP_POOL_IDLE_TIMEOUT_SECONDS: 'smtp.poolIdleTimeoutSeconds',
  IMAP_MCP_SMTP_RETRY_MAX_ATTEMPTS: 'smtp.retryMaxAttempts',

  // IMAP
  IMAP_MCP_AUTO_CREATE_SENT_FOLDER: 'imap.autoCreateSentFolder',

  // Context reduction (existing names preserved verbatim)
  IMAP_MCP_INLINE_THRESHOLD: 'contextReduction.inlineThreshold',
  IMAP_MCP_FILE_THRESHOLD: 'contextReduction.fileThreshold',
  IMAP_MCP_INLINE_BYTE_BUDGET: 'contextReduction.inlineByteBudget',
  IMAP_MCP_INLINE_LIMIT_CAP: 'contextReduction.inlineLimitCap',
  IMAP_MCP_HANDLE_LIMIT_CAP: 'contextReduction.handleLimitCap',
  IMAP_MCP_RESULT_TTL_MS: 'contextReduction.resultTtlMs',
  IMAP_MCP_MAX_RESULTS_PER_USER: 'contextReduction.maxResultsPerUser',
  IMAP_MCP_DISK_QUOTA: 'contextReduction.perUserDiskQuota',
  IMAP_MCP_CLEANUP_INTERVAL_MS: 'contextReduction.cleanupIntervalMs',
  IMAP_MCP_WORKERS: 'contextReduction.workerPoolSize',
  IMAP_MCP_WORKER_TIMEOUT: 'contextReduction.workerTaskTimeoutMs',
  IMAP_MCP_PREVIEW_CHARS: 'contextReduction.previewChars',
  IMAP_MCP_FIRST_N_PREVIEW: 'contextReduction.firstNPreviewRows',
  IMAP_MCP_JSONL_THRESHOLD: 'contextReduction.jsonlThresholdRows',
  IMAP_MCP_ATTACHMENT_MAX_BYTES: 'contextReduction.attachmentMaxBytes',
  IMAP_MCP_RESULTS_DIR: 'contextReduction.resultsRootDir',

  // Logging
  IMAP_MCP_LOG_LEVEL: 'logging.level',
  IMAP_MCP_LOG_PATH: 'logging.path',

  // User context
  MCP_USER_ID: 'user.mcpUserId',
};

/**
 * Fields whose values must be redacted in --validate-config output.
 * Dotted paths into ServerConfig.
 */
export const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'encryption.masterKey',
]);
