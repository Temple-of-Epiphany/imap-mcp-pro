/**
 * cache-tools.ts — MCP tools backed by MessageCacheService.
 *
 * v2.17.0 MVP — Issue #124. Two new tools:
 *   - imap_sync_folder_cache : populate local cache for one folder
 *   - imap_search_cache      : SQL-backed search; modes by_domain, by_address,
 *                              group_by_sender. Cache miss returns an explicit
 *                              structured error — no silent IMAP fallback.
 *
 * Existing read tools (imap_search_emails, imap_get_email) are NOT rewritten
 * to consult the cache transparently in v2.17.0. The skill orchestrates the
 * order: sync first, then search.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Date Updated: 2026-04-30
 * Version: 0.1.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import {
  MessageCacheService,
  CacheMissError,
} from '../services/message-cache-service.js';

const SearchModeSchema = z.enum(['by_domain', 'by_address', 'group_by_sender', 'fulltext']);

/**
 * Convert a "since" string ("90d", "24h", ISO date) to a unix-ms lower bound.
 * Returns undefined when input is undefined/empty.
 */
function parseSince(since: string | undefined): number | undefined {
  if (!since) return undefined;
  const m = /^(\d+)\s*([dhm])$/i.exec(since.trim());
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const ms = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
    return Date.now() - n * ms;
  }
  // Fall through: try ISO date parse.
  const t = Date.parse(since);
  return Number.isNaN(t) ? undefined : t;
}

export function cacheTools(
  server: McpServer,
  cache: MessageCacheService,
): void {
  // -------------------------------------------------------------------
  // imap_sync_folder_cache — explicit cache populate for one folder.
  // -------------------------------------------------------------------
  server.registerTool('imap_sync_folder_cache', {
    description:
      'Populate the local message header cache for one folder. Idempotent: ' +
      'subsequent calls only fetch new UIDs since the last sync. Returns ' +
      'row counts + duration. UIDVALIDITY change triggers a full resync. ' +
      'Required before imap_search_cache will return results.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().describe('Folder name (e.g. "INBOX")'),
      fullResync: z.boolean().optional()
        .describe('Force full resync (drops existing rows). Default false.'),
    },
  }, withErrorHandling(async ({ accountId, folder, fullResync }) => {
    const report = await cache.syncFolder(accountId, folder, { fullResync });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(report, null, 2),
      }],
    };
  }));

  // -------------------------------------------------------------------
  // imap_search_cache — SQL-backed search; cache miss is explicit.
  // -------------------------------------------------------------------
  server.registerTool('imap_search_cache', {
    description:
      'Fast SQL-backed search against the local header cache. ' +
      'Modes: by_domain (rows where from_domain matches), by_address (exact ' +
      'from_address match), group_by_sender (top-N senders by message count), ' +
      'fulltext (FTS5 ranked search over subject + sender name/address — for ' +
      'partial-recall queries; no message bodies are searched). ' +
      'Returns explicit cache_miss error if the folder has not been synced — ' +
      'call imap_sync_folder_cache first.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().describe('Folder name'),
      mode: SearchModeSchema.describe(
        'by_domain: rows for one domain. ' +
        'by_address: rows for one exact address. ' +
        'group_by_sender: top-N senders by message count. ' +
        'fulltext: FTS5 ranked search over subject + sender (value = query text).'
      ),
      value: z.string().optional()
        .describe('Domain (by_domain), address (by_address), or query text (fulltext) — required for those modes'),
      since: z.string().optional()
        .describe('Lower bound: relative ("90d", "24h") or ISO date'),
      limit: z.number().int().positive().optional()
        .describe('Max rows. Default 50, hard cap 1000.'),
    },
  }, withErrorHandling(async ({ accountId, folder, mode, value, since, limit }) => {
    const opts = {
      since: parseSince(since),
      limit: Math.min(limit ?? 50, 1000),
    };

    try {
      let payload: unknown;
      switch (mode) {
        case 'by_domain':
          if (!value) throw new Error('by_domain mode requires value (domain)');
          payload = await cache.searchByFromDomain(accountId, folder, value, opts);
          break;
        case 'by_address':
          if (!value) throw new Error('by_address mode requires value (address)');
          payload = await cache.searchByFromAddress(accountId, folder, value, opts);
          break;
        case 'group_by_sender':
          payload = await cache.groupBySender(accountId, folder, opts);
          break;
        case 'fulltext':
          if (!value) throw new Error('fulltext mode requires value (the search query)');
          payload = await cache.searchFullText(accountId, folder, value, opts);
          break;
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ mode, results: payload }, null, 2),
        }],
      };
    } catch (e) {
      // Cache miss is structured, not a generic error — the skill needs to
      // recognize this and call imap_sync_folder_cache first.
      if (e instanceof CacheMissError) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'cache_miss',
              accountId: e.accountId,
              folder: e.folder,
              hint: 'Call imap_sync_folder_cache for this folder before retrying.',
            }, null, 2),
          }],
          isError: true,
        };
      }
      throw e;
    }
  }));
}
