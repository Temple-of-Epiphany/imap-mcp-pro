/**
 * imap_results — single tool with action discriminator
 *
 * Actions:
 *   get      Paginated retrieval of a stored result
 *   list     List the user's cached results (temp + persistent)
 *   delete   Remove a stored result (and its file/attachments)
 *   persist  Promote a temp result to persistent (clears TTL)
 *
 * Author: Temple of Epiphany
 * Date: 2026-04-18
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DatabaseService } from '../services/database-service.js';
import { ResultsService } from '../services/results-service.js';
import { withErrorHandling } from '../utils/error-handler.js';
import { withUserAuthorization } from './tool-context.js';
import { humanBytes } from '../utils/human-bytes.js';

export function resultTools(
  server: McpServer,
  db: DatabaseService,
  results: ResultsService
): void {
  server.registerTool(
    'imap_results',
    {
      description:
        'Manage cached MCP tool results (resource-handle pattern). ' +
        "Use action='get' to page through a stored result, " +
        "action='list' to see what's cached, " +
        "action='delete' to remove one, " +
        "action='persist' to keep a temp result for future sessions.",
      inputSchema: {
        action: z
          .enum(['get', 'list', 'delete', 'persist'])
          .describe('Operation to perform'),
        resultId: z
          .string()
          .optional()
          .describe('Result handle (required for get/delete/persist)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Row offset for action='get' (default 0)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .default(50)
          .describe("Page size for action='get' (default 50, max 200)"),
        includeAttachments: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include attachment metadata in action='get' response"),
        toolName: z
          .string()
          .optional()
          .describe("Filter by originating tool name in action='list'"),
        storageType: z
          .enum(['temp', 'persistent'])
          .optional()
          .describe("Filter by storage type in action='list'"),
        listLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Max rows for action='list' (default 20)"),
      },
    },
    withErrorHandling(
      withUserAuthorization(
        db,
        async (
          params: {
            action: 'get' | 'list' | 'delete' | 'persist';
            resultId?: string;
            offset?: number;
            limit?: number;
            includeAttachments?: boolean;
            toolName?: string;
            storageType?: 'temp' | 'persistent';
            listLimit?: number;
          },
          ctx
        ) => {
          const {
            action,
            resultId,
            offset = 0,
            limit = 50,
            includeAttachments = false,
            toolName,
            storageType,
            listLimit = 20,
          } = params;

          switch (action) {
            case 'get': {
              if (!resultId) throw new Error("action='get' requires resultId");
              const page = await results.getPage(ctx.userId, resultId, offset, limit);
              const env = results.getEnvelope(ctx.userId, resultId);

              const payload: any = {
                action: 'get',
                resultId: page.resultId,
                total: page.total,
                offset: page.offset,
                limit: page.limit,
                returned: page.rows.length,
                nextOffset: page.nextOffset,
                rows: page.rows,
              };
              if (env) {
                payload.toolName = env.toolName;
                payload.folder = env.folder;
                payload.storageType = env.storageType;
                payload.expiresAt = env.expiresAt;
              }
              if (includeAttachments) {
                const uids = page.rows
                  .map(r => (typeof r.uid === 'number' ? r.uid : null))
                  .filter((u): u is number => u !== null);
                const allAttachments: any[] = [];
                for (const uid of uids) {
                  const list = results.listAttachments(ctx.userId, resultId, uid);
                  for (const a of list) {
                    allAttachments.push({
                      attachmentId: a.attachment_id,
                      messageUid: a.message_uid,
                      filename: a.filename,
                      contentType: a.content_type,
                      sizeBytes: a.size_bytes,
                      sizeHuman: humanBytes(a.size_bytes),
                      checksumSha256: a.checksum_sha256,
                      skipped: !!a.skipped,
                    });
                  }
                }
                payload.attachments = allAttachments;
              }
              return {
                content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              };
            }

            case 'list': {
              const envs = results.listResults(ctx.userId, {
                limit: listLimit,
                toolName,
                storageType,
              });
              const grouped = {
                temp: envs.filter(e => e.storageType === 'temp'),
                persistent: envs.filter(e => e.storageType === 'persistent'),
              };
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        action: 'list',
                        count: envs.length,
                        ...grouped,
                      },
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            case 'delete': {
              if (!resultId) throw new Error("action='delete' requires resultId");
              await results.deleteResult(ctx.userId, resultId);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      { action: 'delete', resultId, ok: true },
                      null,
                      2
                    ),
                  },
                ],
              };
            }

            case 'persist': {
              if (!resultId) throw new Error("action='persist' requires resultId");
              const env = results.persistResult(ctx.userId, resultId);
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(
                      {
                        action: 'persist',
                        resultId,
                        storageType: env.storageType,
                        expiresAt: env.expiresAt,
                        rowCount: env.rowCount,
                        ok: true,
                      },
                      null,
                      2
                    ),
                  },
                ],
              };
            }
          }
        }
      )
    )
  );
}
