// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Admin / lifecycle tools — runtime state reset without a full restart (#84).
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ImapService } from '../services/imap-service.js';
import { SmtpService } from '../services/smtp-service.js';
import { withErrorHandling } from '../utils/error-handler.js';

export function adminTools(
  server: McpServer,
  imapService: ImapService,
  smtpService: SmtpService
): void {
  // Reset runtime state without restarting Claude Desktop (#84).
  //
  // Scope is deliberately limited to what is SAFE to reset on a live stdio
  // session: pooled connections and the in-memory capabilities cache.
  // Configuration, environment variables, and the tool registry are fixed for
  // the process lifetime — reloading them is not safely possible mid-session,
  // so those still require a full restart. The database and stored data are
  // never touched.
  server.registerTool('imap_server_reload', {
    description:
      'Reset the server\'s runtime state without restarting Claude Desktop: close pooled IMAP and SMTP ' +
      'connections and clear the in-memory IMAP capabilities cache. Connections reconnect lazily on the next ' +
      'operation — useful after changing account settings on the server, or when connections have gone stale. ' +
      'NOTE: this does NOT reload configuration, environment variables, or the tool list, and never touches the ' +
      'database or stored data; picking up config/env changes or a server upgrade still requires a full restart.',
    inputSchema: {
      disconnectImap: z.boolean().optional().default(true).describe('Close all pooled IMAP connections (default true)'),
      disconnectSmtp: z.boolean().optional().default(true).describe('Close all pooled SMTP connections (default true)'),
      clearCapabilitiesCache: z.boolean().optional().default(true).describe('Clear the cached IMAP server capabilities (default true)'),
    }
  }, withErrorHandling(async ({ disconnectImap, disconnectSmtp, clearCapabilitiesCache }) => {
    const reset = { imapConnectionsClosed: 0, smtpConnectionsClosed: 0, capabilitiesCacheCleared: 0 };
    const actions: string[] = [];

    if (disconnectImap !== false) {
      reset.imapConnectionsClosed = await imapService.disconnectAll();
      actions.push('imap-pool');
    }
    if (disconnectSmtp !== false) {
      reset.smtpConnectionsClosed = smtpService.getPoolStats().configured;
      smtpService.disconnectAll();
      actions.push('smtp-pool');
    }
    if (clearCapabilitiesCache !== false) {
      reset.capabilitiesCacheCleared = imapService.clearCapabilitiesCache();
      actions.push('capabilities-cache');
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          reset,
          actions,
          note: 'Configuration, environment variables, and tools are NOT reloaded; a full restart is still required to pick those up. Stored data and the database are untouched.',
        }, null, 2)
      }]
    };
  }));
}
