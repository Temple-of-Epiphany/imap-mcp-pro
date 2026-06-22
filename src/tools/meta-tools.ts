import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../utils/package-info.js';
import { WebUIManager } from '../services/web-ui-manager.js';
import open from 'open';

/**
 * Meta tools for service discovery and information
 * These tools allow Claude to query the service itself for capabilities and version info
 */
export function metaTools(server: McpServer, webUIManager?: WebUIManager): void {
  // About tool - returns comprehensive service information
  server.registerTool('imap_about', {
    description: 'Get comprehensive information about the IMAP MCP Pro service including version, features, and capabilities',
    inputSchema: {}
  }, withErrorHandling(async () => {
    const about = {
      service: {
        name: 'IMAP MCP Pro',
        description: 'Enterprise-grade IMAP MCP server with Level 1-3 reliability features, circuit breaker, metrics, bulk operations, and SQLite3 database with AES-256-GCM encryption for commercial and large-scale deployments',
        version: PACKAGE_VERSION,
        packageName: PACKAGE_NAME
      },
      license: {
        model: 'PolyForm Noncommercial 1.0.0 (commercial license available)',
        nonCommercial: 'FREE for personal, educational, and non-profit use',
        commercial: 'PAID license required for business use',
        contact: 'colin.bitterfield@templeofepiphany.com'
      },
      repository: {
        url: 'https://github.com/Temple-of-Epiphany/imap-mcp-pro',
        issues: 'https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues',
        documentation: 'https://github.com/Temple-of-Epiphany/imap-mcp-pro#readme'
      },
      features: {
        reliability: [
          'Level 1: Enhanced keepalive (RFC 2177 compliant)',
          'Level 2: Automatic reconnection with exponential backoff',
          'Level 2: Retry logic with configurable attempts',
          'Level 2: Periodic health checks (NOOP every 29 minutes)',
          'Level 3: Circuit breaker pattern for failure prevention',
          'Level 3: Operation queue for outage recovery',
          'Level 3: Graceful degradation with read-only mode'
        ],
        operations: [
          'Single and bulk email operations',
          'Email search with multiple criteria',
          'Email content retrieval (headers, body, full)',
          'Mark emails (read/unread/flagged/unflagged)',
          'Copy and move emails between folders',
          'Delete emails (with optional expunge)',
          'SMTP email sending (send, reply, forward with attachments)',
          'SMTP authentication (automatic credential handling)',
          'SMTP TLS/SSL support (port 465, 587, 25)',
          'Folder management (list, status, unread counts, create, delete, rename)'
        ],
        spamFiltering: [
          'UserCheck spam detection API integration',
          'UserCheck DNS firewall for domain reputation',
          'Bulk spam checking for multiple emails',
          'Per-folder spam scanning',
          'Per-account spam analysis',
          'Domain confidence scoring',
          'Message domain extraction and analysis',
          'Spam cache for performance optimization'
        ],
        subscriptionManagement: [
          'Automatic unsubscribe link extraction',
          'List-Unsubscribe header support (RFC 2369)',
          'One-click unsubscribe execution',
          'Subscription tracking and categorization',
          'Newsletter sender identification',
          'Subscription summary and statistics',
          'Bulk unsubscribe candidate identification',
          'Custom notes and category tagging'
        ],
        monitoring: [
          'Per-connection metrics (operations, success rate, latency, uptime)',
          'Per-operation metrics (count, latency stats, success rate)',
          'Circuit breaker state tracking',
          'Connection state machine monitoring'
        ],
        security: [
          'SQLite3 database with AES-256-GCM encryption at rest',
          'Unique IV per encrypted field with integrity protection',
          'Secure encryption key storage with 0o600 permissions',
          'Multi-tenant user management with role-based access control',
          'Account sharing with granular permissions (MSP support)',
          'TLS/SSL support for IMAP and SMTP'
        ],
        database: [
          'SQLite3 with better-sqlite3 for robust persistence',
          'Encrypted account credentials (IMAP and SMTP)',
          'Multi-tenant architecture for MSP deployments',
          'User management with organizations and roles',
          'Account sharing across users',
          'Transactional integrity for multi-row operations'
        ]
      },
      capabilities: {
        totalTools: 72,
        toolCategories: [
          'User Management (9 tools)',
          'Account Management (5 tools)',
          'Email Operations (18 tools)',
          'Folder Operations (6 tools)',
          'Spam Detection - UserCheck integration',
          'Subscription Management (8 tools) - Unsubscribe automation',
          'DNS Firewall (3 tools) - Domain reputation checking',
          'RFC 9051 Compliance (7 tools) - Keywords, APPEND, SUBSCRIBE',
          'Metrics & Monitoring (3 tools)',
          'Meta/Discovery (2 tools)'
        ],
        bulkOperations: true,
        circuitBreaker: true,
        metrics: true,
        smtp: true,
        spamFiltering: true,
        subscriptionManagement: true,
        dnsFirewall: true
      },
      attribution: {
        organization: 'Temple of Epiphany',
        maintainer: 'Colin Bitterfield (colin.bitterfield@templeofepiphany.com)',
        contributors: [
          'Colin Bitterfield',
          'Michael Nikolaus (original author)'
        ],
        basedOn: 'Original IMAP MCP Server by Michael Nikolaus (MIT License)'
      },
      usage:
        'Use the `service.version` field to gate feature availability when authoring agents or ' +
        'skills. Recent feature gates worth checking: imap_get_outbox_dir requires v2.17.13+ ' +
        '(working call requires v2.17.14+ which fixed the dispatch hang), imap_open_web_ui ' +
        'requires v2.17.10+, the per-form attachment hardening matrix (allow-list / dotfile / ' +
        'size / basename) is complete as of v2.17.11, and the env-resolver heal for Claude ' +
        'Desktop placeholder leakage is v2.17.14+. Use imap_list_tools for a categorized index ' +
        'of every tool surface; imap_list_users + imap_list_accounts for the data the active ' +
        'session can act on.'
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(about, null, 2)
      }]
    };
  }));

  // List tools - returns detailed manifest of all available tools
  server.registerTool('imap_list_tools', {
    description: 'List all available MCP tools with descriptions and parameters',
    inputSchema: {
      category: z.enum(['all', 'user', 'account', 'email', 'bulk', 'folder', 'sending', 'metrics', 'meta'])
        .optional()
        .default('all')
        .describe('Filter tools by category (default: all)')
    }
  }, withErrorHandling(async ({ category }) => {
    const allTools = [
      // User Management Tools (9) - NEW in v2.6.0
      {
        category: 'user',
        name: 'imap_create_user',
        description: 'Create a new user in the database',
        parameters: ['username', 'email', 'organization', 'role']
      },
      {
        category: 'user',
        name: 'imap_list_users',
        description: 'List all users in the database',
        parameters: []
      },
      {
        category: 'user',
        name: 'imap_get_user',
        description: 'Get user details by username',
        parameters: ['username']
      },
      {
        category: 'user',
        name: 'imap_db_add_account',
        description: 'Add IMAP account to database with encryption',
        parameters: ['userId', 'name', 'host', 'port', 'username', 'password', 'tls', 'smtpHost', 'smtpPort']
      },
      {
        category: 'user',
        name: 'imap_db_list_accounts',
        description: 'List accounts for a user from database',
        parameters: ['userId']
      },
      {
        category: 'user',
        name: 'imap_db_get_account',
        description: 'Get decrypted account details from database',
        parameters: ['accountId']
      },
      {
        category: 'user',
        name: 'imap_db_remove_account',
        description: 'Remove account from database',
        parameters: ['accountId']
      },
      {
        category: 'user',
        name: 'imap_share_account',
        description: 'Share account with another user (MSP feature)',
        parameters: ['accountId', 'targetUserId', 'role']
      },
      {
        category: 'user',
        name: 'imap_unshare_account',
        description: 'Revoke account access from user',
        parameters: ['accountId', 'targetUserId']
      },

      // Account Management Tools (5)
      {
        category: 'account',
        name: 'imap_add_account',
        description: 'Add a new IMAP account configuration',
        parameters: ['name', 'host', 'port', 'user', 'password', 'tls']
      },
      {
        category: 'account',
        name: 'imap_remove_account',
        description: 'Remove an IMAP account by ID',
        parameters: ['accountId']
      },
      {
        category: 'account',
        name: 'imap_list_accounts',
        description: 'List all configured IMAP accounts',
        parameters: []
      },
      {
        category: 'account',
        name: 'imap_connect',
        description: 'Connect to an IMAP account',
        parameters: ['accountId']
      },
      {
        category: 'account',
        name: 'imap_disconnect',
        description: 'Disconnect from an IMAP account',
        parameters: ['accountId']
      },

      // Email Operations (9)
      {
        category: 'email',
        name: 'imap_search_emails',
        description: 'Search for emails in a folder with multiple criteria',
        parameters: ['accountId', 'folder', 'from', 'to', 'subject', 'body', 'since', 'before', 'seen', 'flagged', 'limit']
      },
      {
        category: 'email',
        name: 'imap_get_email',
        description: 'Get the full content of an email',
        parameters: ['accountId', 'folder', 'uid']
      },
      {
        category: 'email',
        name: 'imap_mark_as_read',
        description: 'Mark an email as read',
        parameters: ['accountId', 'folder', 'uid']
      },
      {
        category: 'email',
        name: 'imap_mark_as_unread',
        description: 'Mark an email as unread',
        parameters: ['accountId', 'folder', 'uid']
      },
      {
        category: 'email',
        name: 'imap_delete_email',
        description: 'Delete an email (mark as deleted and optionally expunge)',
        parameters: ['accountId', 'folder', 'uid']
      },
      {
        category: 'email',
        name: 'imap_copy_email',
        description: 'Copy an email to another folder',
        parameters: ['accountId', 'sourceFolder', 'uid', 'targetFolder']
      },
      {
        category: 'email',
        name: 'imap_move_email',
        description: 'Move an email to another folder (copy + mark deleted)',
        parameters: ['accountId', 'sourceFolder', 'uid', 'targetFolder']
      },
      {
        category: 'email',
        name: 'imap_flag_email',
        description: 'Flag an email as important',
        parameters: ['accountId', 'folder', 'uid']
      },
      {
        category: 'email',
        name: 'imap_unflag_email',
        description: 'Remove flag from an email',
        parameters: ['accountId', 'folder', 'uid']
      },

      // Bulk Operations (4)
      {
        category: 'bulk',
        name: 'imap_bulk_delete_emails',
        description: 'Delete multiple emails efficiently',
        parameters: ['accountId', 'folder', 'uids', 'expunge']
      },
      {
        category: 'bulk',
        name: 'imap_bulk_get_emails',
        description: 'Fetch multiple emails (headers/body/full modes)',
        parameters: ['accountId', 'folder', 'uids', 'mode']
      },
      {
        category: 'bulk',
        name: 'imap_bulk_mark_emails',
        description: 'Mark multiple emails as read/unread/flagged/unflagged',
        parameters: ['accountId', 'folder', 'uids', 'action']
      },
      {
        category: 'bulk',
        name: 'imap_bulk_copy_emails',
        description: 'Copy multiple emails to another folder',
        parameters: ['accountId', 'sourceFolder', 'uids', 'targetFolder']
      },
      {
        category: 'bulk',
        name: 'imap_bulk_move_emails',
        description: 'Move multiple emails to another folder',
        parameters: ['accountId', 'sourceFolder', 'uids', 'targetFolder']
      },

      // Folder Operations (6)
      {
        category: 'folder',
        name: 'imap_list_folders',
        description: 'List all folders in an IMAP account',
        parameters: ['accountId']
      },
      {
        category: 'folder',
        name: 'imap_folder_status',
        description: 'Get folder statistics (total, new, unseen messages)',
        parameters: ['accountId', 'folder']
      },
      {
        category: 'folder',
        name: 'imap_get_unread_count',
        description: 'Count unread emails across folders',
        parameters: ['accountId', 'folders']
      },
      {
        category: 'folder',
        name: 'imap_create_folder',
        description: 'Create a new folder/mailbox in an IMAP account',
        parameters: ['accountId', 'folderName']
      },
      {
        category: 'folder',
        name: 'imap_delete_folder',
        description: 'Delete a folder/mailbox from an IMAP account',
        parameters: ['accountId', 'folderName']
      },
      {
        category: 'folder',
        name: 'imap_rename_folder',
        description: 'Rename a folder/mailbox in an IMAP account',
        parameters: ['accountId', 'oldName', 'newName']
      },

      // Email Sending (2)
      {
        category: 'sending',
        name: 'imap_send_email',
        description: 'Send an email via SMTP',
        parameters: ['accountId', 'to', 'subject', 'body', 'cc', 'bcc', 'attachments']
      },
      {
        category: 'sending',
        name: 'imap_reply_to_email',
        description: 'Reply to an existing email',
        parameters: ['accountId', 'folder', 'uid', 'body', 'replyAll']
      },

      // Metrics & Monitoring (3)
      {
        category: 'metrics',
        name: 'imap_get_metrics',
        description: 'Get connection health metrics (operations, success rate, latency, uptime)',
        parameters: ['accountId']
      },
      {
        category: 'metrics',
        name: 'imap_get_operation_metrics',
        description: 'Get per-operation statistics',
        parameters: ['accountId', 'operation']
      },
      {
        category: 'metrics',
        name: 'imap_reset_metrics',
        description: 'Reset metric tracking for an account',
        parameters: ['accountId']
      },

      // Meta/Discovery Tools (2)
      {
        category: 'meta',
        name: 'imap_about',
        description: 'Get comprehensive information about the IMAP MCP Pro service',
        parameters: []
      },
      {
        category: 'meta',
        name: 'imap_list_tools',
        description: 'List all available MCP tools with descriptions',
        parameters: ['category']
      }
    ];

    // Filter by category if specified
    const filteredTools = category === 'all'
      ? allTools
      : allTools.filter(tool => tool.category === category);

    const response = {
      totalTools: allTools.length,
      filteredCount: filteredTools.length,
      category: category,
      tools: filteredTools.map(tool => ({
        name: tool.name,
        category: tool.category,
        description: tool.description,
        parameters: tool.parameters
      })),
      usage:
        'Each `tool.name` is a valid MCP tool name callable on this server. Pass a `category` ' +
        'argument to scope the listing (one of: user, account, email, bulk, folder, sending, ' +
        'metrics, meta). For full per-tool input schemas, the schema lives on the registered ' +
        'tool itself (visible via the MCP tools/list method); this tool returns a hand-curated ' +
        'parameter summary only. Common workflow chains: ' +
        '(a) imap_list_users -> imap_list_accounts -> imap_search_emails / imap_send_email; ' +
        '(b) imap_list_providers -> imap_add_account_with_provider -> imap_test_account; ' +
        '(c) imap_get_outbox_dir -> Write file -> imap_send_email(attachmentPaths). For server ' +
        'self-information call imap_about; for the embedded Web UI URL call imap_open_web_ui.'
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }]
    };
  }));

  // imap_help — categorized capability overview + copy-paste workflow recipes
  // (#39). Discovery aid that points at imap_list_tools / TOOL_CATALOG.md for
  // the exhaustive list rather than duplicating it.
  const HELP: Record<string, string> = {
    overview: [
      '# IMAP MCP Pro — Help',
      '',
      'Comprehensive IMAP + SMTP email automation for Claude. 100+ tools across accounts, search/read, sending, folders, bulk operations, mailbox cleanup, subscriptions, and spam/DNS security.',
      '',
      'Pick a topic with `imap_help { category }`:',
      '- `getting-started` — add an account and verify it',
      '- `reading` — search, read, and triage mail',
      '- `sending` — send / reply / forward (with attachments)',
      '- `organizing` — folders, flags, priority, move/copy',
      '- `cleanup` — find large mail, quota, export, bulk delete',
      '- `subscriptions` — find and act on unsubscribe links',
      '- `security` — spam (UserCheck) + DNS firewall (Quad9)',
      '- `bulk` — high-volume operations without blowing the token budget',
      '- `workflows` — end-to-end recipes',
      '- `admin` — reset/reload, metrics, diagnostics',
      '',
      'Discover every tool: call `imap_list_tools`, or see the generated `docs/TOOL_CATALOG.md`.',
    ].join('\n'),

    'getting-started': [
      '# Getting started',
      '',
      '1. Add an account (auto-detects server settings for common providers):',
      '   `imap_add_account_auto { email, password }` — or `imap_add_account` for manual host/port.',
      '2. List accounts: `imap_list_accounts` (note the `accountId`).',
      '3. Verify connectivity: `imap_test_account { accountId }` (IMAP) and `imap_test_smtp { accountId }` (SMTP, also reports the server SIZE limit).',
      '4. List folders: `imap_list_folders { accountId }`.',
      '',
      'Credentials are encrypted at rest (AES-256-GCM, file-based key). Multi-account and multi-user (MSP) supported.',
    ].join('\n'),

    reading: [
      '# Reading & triage',
      '',
      '- Search: `imap_search_emails { accountId, folder, from?, subject?, since?, unreadOnly? }`.',
      '- Read one: `imap_get_email { accountId, folder, uid }`.',
      '- Latest N: `imap_get_latest_emails { accountId, folder, limit }`.',
      '- Mark: `imap_mark_as_read` / `imap_mark_as_unread`.',
      '- Unread count: `imap_get_unread_count { accountId, folder }`.',
      '',
      'For thousands of messages use the bulk tools (see `imap_help { category: "bulk" }`).',
    ].join('\n'),

    sending: [
      '# Sending',
      '',
      '- Send: `imap_send_email { accountId, to, subject, text?, html?, attachments? }`.',
      '- Reply: `imap_reply_to_email { accountId, folder, uid, ... }`. Forward: `imap_forward_email { ... }`.',
      '- A copy is placed in the Sent folder automatically (Bcc preserved).',
      '- Oversized sends fail fast against the server SIZE limit (RFC 1870) — check it with `imap_test_smtp`.',
    ].join('\n'),

    organizing: [
      '# Organizing',
      '',
      '- Folders: `imap_create_folder` / `imap_rename_folder` / `imap_delete_folder`, `imap_folder_status`.',
      '- Move / copy: `imap_move_email` / `imap_copy_email` (and `imap_bulk_move_emails` / `imap_bulk_copy_emails`).',
      '- Flags: read/unread/flagged/answered via `imap_mark_as_read` and `imap_bulk_mark_emails`.',
      '- Priority: `imap_set_email_priority { ..., priority: high|normal|low }` / `imap_get_email_priority`.',
      '- Keywords: `imap_add_keyword` / `imap_remove_keyword`; categories via `imap_apply_categories`.',
    ].join('\n'),

    cleanup: [
      '# Mailbox cleanup (reclaim space)',
      '',
      '1. Find the big stuff: `imap_get_email_sizes { accountId, folder, minSizeBytes? }` (one folder) or',
      '   `imap_get_largest_emails { accountId, folders?, topN? }` (across folders).',
      '2. Check quota: `imap_get_quota { accountId }`.',
      '3. Save anything worth keeping: `imap_export_email` / `imap_export_folder` (.eml) or `imap_extract_attachments`.',
      '4. Delete/move in bulk using the returned UIDs: `imap_bulk_delete_emails` or `imap_bulk_move_emails` (to Trash).',
    ].join('\n'),

    subscriptions: [
      '# Subscriptions / unsubscribe',
      '',
      '- Bulk-read links (no DB write): `imap_get_unsubscribe_links_for { accountId, folder, uids }`.',
      '- Scan + store a folder: `imap_extract_unsubscribe_links { userId, accountId, folder, maxDurationMs?, afterUid? }` — header-first and time-budgeted; on a large folder it returns `truncated` + `nextUid` to resume.',
      '- Review candidates: `imap_list_unsubscribe_candidates`. Act: `imap_execute_unsubscribe`.',
    ].join('\n'),

    security: [
      '# Spam & DNS security',
      '',
      '- Spam (UserCheck): `imap_check_email_spam`, `imap_check_folder_spam`, `imap_scan_account_spam`. Set the API key with `imap_add_usercheck_key`.',
      '- DNS firewall (Quad9): `imap_check_domain_dns_firewall { domain }`, `imap_scan_message_domains`.',
      '- Verify Quad9 blocking is active: `imap_test_quad9_dns`.',
    ].join('\n'),

    bulk: [
      '# Bulk operations',
      '',
      'Bulk tools auto-chunk and use a three-tier response (inline / handle / file-backed) so large results never blow the token budget. Retrieve handle/file results with `imap_results`.',
      '',
      '- `imap_bulk_get_emails` / `_chunked`, `imap_bulk_mark_emails` / `_chunked`,',
      '  `imap_bulk_move_emails`, `imap_bulk_copy_emails`, `imap_bulk_delete_emails` / `_chunked`.',
      '- Local header cache for fast repeat reads + sender grouping: `imap_sync_folder_cache` then `imap_search_cache`.',
    ].join('\n'),

    workflows: [
      '# Workflows (recipes)',
      '',
      '## Clear space fast',
      '`imap_get_largest_emails { accountId, folders: ["INBOX","[Gmail]/All Mail"], topN: 50 }` → review →',
      '`imap_export_folder` the keepers → `imap_bulk_move_emails` the rest to Trash → `imap_get_quota` to confirm.',
      '',
      '## Unsubscribe sweep',
      '`imap_extract_unsubscribe_links { userId, accountId, folder: "INBOX", olderThan: 30 }` (resume with `afterUid` if `truncated`) →',
      '`imap_list_unsubscribe_candidates` → `imap_execute_unsubscribe`.',
      '',
      '## Triage unread',
      '`imap_search_emails { accountId, folder: "INBOX", unreadOnly: true }` → `imap_check_emails_spam_bulk` →',
      '`imap_bulk_move_emails` spam to Junk, `imap_set_email_priority` the rest.',
    ].join('\n'),

    admin: [
      '# Admin & diagnostics',
      '',
      '- Reset runtime state without restarting Claude Desktop: `imap_server_reload` (closes pooled connections, clears the capabilities cache). Config/env changes still need a full restart.',
      '- Metrics: `imap_get_metrics`, `imap_get_operation_metrics`, `imap_get_smtp_metrics`. Circuit breaker: `imap_get_circuit_breaker` / `imap_reset_circuit_breaker`.',
      '- Capabilities: `imap_get_capabilities`. Sent-folder check: `imap_test_sent_folder`.',
    ].join('\n'),
  };

  server.registerTool('imap_help', {
    description:
      'Show IMAP MCP Pro capabilities and copy-paste workflow recipes, by category. Start with no argument (or ' +
      'category="overview") for the topic list. Categories: overview, getting-started, reading, sending, ' +
      'organizing, cleanup, subscriptions, security, bulk, workflows, admin. For the exhaustive tool list use ' +
      'imap_list_tools.',
    inputSchema: {
      category: z.enum([
        'overview', 'getting-started', 'reading', 'sending', 'organizing',
        'cleanup', 'subscriptions', 'security', 'bulk', 'workflows', 'admin',
      ]).optional().default('overview').describe('Help topic (default: overview)'),
    }
  }, withErrorHandling(async ({ category }) => {
    const key = category ?? 'overview';
    return {
      content: [{ type: 'text', text: HELP[key] ?? HELP.overview }]
    };
  }));

  // imap_open_web_ui — return the live URL of the embedded Web UI and
  // optionally open it in the user's default browser. The Web UI is
  // already running (auto-started in post-handshake per #150); this tool
  // surfaces the URL because the actual port may have moved off the
  // configured default if there was a collision.
  if (webUIManager) {
    server.registerTool('imap_open_web_ui', {
      description:
        'Return the URL of the embedded Web UI (account management, DNS firewall, ' +
        'categories, Claude Desktop auto-setup) and optionally open it in the default browser. ' +
        'The Web UI auto-starts when the MCP server boots; the actual port may differ from the ' +
        'configured default if there was a collision (probes the configured port then ' +
        'increments by 100 up to 10 attempts). Use this tool when the user asks to "open the ' +
        'web UI" or "show the dashboard".',
      inputSchema: {
        openInBrowser: z.boolean().optional().default(false).describe(
          'When true, open the URL in the user default browser. When false (default), only return the URL.'
        ),
      },
    }, withErrorHandling(async ({ openInBrowser }) => {
      if (!webUIManager.isRunning()) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              result: 'web_ui_not_running',
              hint: 'The embedded Web UI failed to start at MCP server boot. ' +
                'Check the server log for [startup] component=web-ui error messages, ' +
                'or set IMAP_MCP_WEB_UI_PORT to a different starting port if 4500–5400 are all taken.',
            }, null, 2)
          }]
        };
      }
      const url = webUIManager.getUrl()!;
      const port = webUIManager.getPort()!;
      if (openInBrowser) {
        try { await open(url); }
        catch { /* best-effort — return URL even if the open command fails */ }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            url,
            port,
            openedInBrowser: openInBrowser ?? false,
          }, null, 2)
        }]
      };
    }));
  }
}
