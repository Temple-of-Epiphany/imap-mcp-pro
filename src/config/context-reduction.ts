/**
 * Context Reduction Config
 *
 * Tunables for the result-cache, worker-pool, and file-export subsystems
 * that keep MCP tool responses small.
 *
 * Author: Temple of Epiphany
 * Date: 2026-04-18
 */

import os from 'os';
import path from 'path';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const cpuWorkers = Math.min(4, Math.max(2, (os.cpus()?.length ?? 2) - 1));

export const ContextReductionConfig = Object.freeze({
  // Storage thresholds
  INLINE_THRESHOLD:        intEnv('IMAP_MCP_INLINE_THRESHOLD', 20),
  FILE_THRESHOLD:          intEnv('IMAP_MCP_FILE_THRESHOLD', 500),
  INLINE_BYTE_BUDGET:      intEnv('IMAP_MCP_INLINE_BYTE_BUDGET', 256 * 1024),

  // Per-call caps
  INLINE_LIMIT_CAP:        intEnv('IMAP_MCP_INLINE_LIMIT_CAP', 100),      // max rows a tool may return inline
  HANDLE_LIMIT_CAP:        intEnv('IMAP_MCP_HANDLE_LIMIT_CAP', 10_000),   // max rows a tool may stash in a handle

  // TTL / quotas
  RESULT_TTL_MS:           intEnv('IMAP_MCP_RESULT_TTL_MS', 2 * 60 * 60 * 1000), // 2h
  MAX_RESULTS_PER_USER:    intEnv('IMAP_MCP_MAX_RESULTS_PER_USER', 50),
  PER_USER_DISK_QUOTA:     intEnv('IMAP_MCP_DISK_QUOTA', 500 * 1024 * 1024),    // 500 MB
  CLEANUP_INTERVAL_MS:     intEnv('IMAP_MCP_CLEANUP_INTERVAL_MS', 5 * 60 * 1000),

  // Attachment policy
  ATTACHMENT_MAX_BYTES:    intEnv('IMAP_MCP_ATTACHMENT_MAX_BYTES', 10 * 1024 * 1024), // 10 MB

  // Worker pool
  WORKER_POOL_SIZE:        intEnv('IMAP_MCP_WORKERS', cpuWorkers),
  WORKER_TASK_TIMEOUT_MS:  intEnv('IMAP_MCP_WORKER_TIMEOUT', 30_000),

  // Summarization
  PREVIEW_CHARS:           intEnv('IMAP_MCP_PREVIEW_CHARS', 200),
  FIRST_N_PREVIEW_ROWS:    intEnv('IMAP_MCP_FIRST_N_PREVIEW', 5),

  // File-export format switch
  JSONL_THRESHOLD_ROWS:    intEnv('IMAP_MCP_JSONL_THRESHOLD', 5000),

  // Filesystem
  RESULTS_ROOT_DIR:        process.env.IMAP_MCP_RESULTS_DIR
                              || path.join(os.homedir(), '.imap-mcp', 'results'),
});

export type ContextReductionConfigType = typeof ContextReductionConfig;
