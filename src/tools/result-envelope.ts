/**
 * Result Envelope Helper
 *
 * Single decision point for tools that return list-style data.
 * Implements the three-tier policy:
 *   - n <= INLINE_THRESHOLD : return rows inline (backward compatible)
 *   - n  > INLINE_THRESHOLD : store via ResultsService, return resultId envelope
 *   - explicit responseMode 'inline'|'handle'|'file' overrides
 *
 * Author: Temple of Epiphany
 * Date: 2026-04-18
 */

import { z } from 'zod';
import {
  ResultsService,
  StoredResultRowSummary,
  StoredResultFacets,
  StorageType,
} from '../services/results-service.js';
import { ContextReductionConfig as Cfg } from '../config/context-reduction.js';

export const ResponseModeSchema = z
  .enum(['auto', 'inline', 'handle', 'file'])
  .optional()
  .default('auto')
  .describe(
    'How the result should be returned. ' +
    "'auto' (default): inline if small (<=20), handle for larger, file for huge (>500). " +
    "'inline': force full payload (only safe for small results). " +
    "'handle': force resultId envelope. " +
    "'file': force file-backed handle."
  );

export const StorageTypeSchema = z
  .enum(['temp', 'persistent'])
  .optional()
  .default('temp')
  .describe(
    "Storage lifetime when a handle is created. " +
    "'temp' (default): expires after the configured TTL (~2h). " +
    "'persistent': retained until you explicitly delete via imap_results action='delete'. " +
    "Choose 'persistent' when you want to analyze the same dataset across multiple sessions."
  );

export type ResponseMode = 'auto' | 'inline' | 'handle' | 'file';

export interface MaybeStoreOpts {
  userId: string;
  accountId?: string | null;
  toolName: string;
  folder?: string | null;
  params: unknown;
  rows: StoredResultRowSummary[];
  facets?: StoredResultFacets;
  responseMode?: ResponseMode;
  storageType?: StorageType;
  results: ResultsService;
  /**
   * Extra envelope fields the tool wants to surface alongside the standard
   * response (e.g. totalFound from server-side search counts).
   */
  extra?: Record<string, unknown>;
}

export interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
}

function asMcpText(obj: unknown): McpTextResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/**
 * Decide inline vs handle vs file per the three-tier policy and emit
 * a uniform MCP response.
 */
export async function maybeStoreAsHandle(opts: MaybeStoreOpts): Promise<McpTextResult> {
  const mode: ResponseMode = opts.responseMode ?? 'auto';
  const n = opts.rows.length;

  // Decide effective mode
  let effective: 'inline' | 'handle' | 'file';
  if (mode === 'inline') {
    effective = 'inline';
  } else if (mode === 'handle') {
    effective = 'handle';
  } else if (mode === 'file') {
    effective = 'file';
  } else {
    // auto - only pay for size calculation when count alone is ambiguous
    if (n > Cfg.FILE_THRESHOLD) {
      effective = 'file';
    } else if (n > Cfg.INLINE_THRESHOLD) {
      effective = 'handle';
    } else {
      // Small row count: measure bytes to catch e.g. 5 huge rows
      const sizeBytes = JSON.stringify(opts.rows).length;
      if (sizeBytes > Cfg.INLINE_BYTE_BUDGET * 4) effective = 'file';
      else if (sizeBytes > Cfg.INLINE_BYTE_BUDGET) effective = 'handle';
      else effective = 'inline';
    }
  }

  if (effective === 'inline') {
    return asMcpText({
      ...opts.extra,
      mode: 'inline',
      count: n,
      rows: opts.rows,
    });
  }

  const stored = await opts.results.storeResult({
    userId: opts.userId,
    accountId: opts.accountId ?? null,
    toolName: opts.toolName,
    folder: opts.folder ?? null,
    params: opts.params,
    rows: opts.rows,
    facets: opts.facets,
    storageType: opts.storageType ?? 'temp',
    forceFile: effective === 'file',
  });

  const env = stored.envelope;
  return asMcpText({
    ...opts.extra,
    mode: env.storageMode === 'file' ? 'file' : 'handle',
    storageType: env.storageType,
    resultId: stored.resultId,
    count: env.rowCount,
    expiresAt: env.expiresAt,
    firstN: env.firstN,
    facets: env.facets,
    hint:
      env.storageType === 'temp'
        ? `Result stored as temp (expires ${env.expiresAt}). Use imap_results action='get' resultId='${stored.resultId}' offset=0 limit=50 to page through. To keep it for future sessions, call imap_results action='persist' resultId='${stored.resultId}'.`
        : `Persistent result. Use imap_results action='get' resultId='${stored.resultId}' to retrieve. Delete with imap_results action='delete' when done.`,
  });
}
