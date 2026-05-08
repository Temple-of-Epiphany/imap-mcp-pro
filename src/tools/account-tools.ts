import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DatabaseService } from '../services/database-service.js';
import { ImapService } from '../services/imap-service.js';
import { z } from 'zod';
import { withErrorHandling, AccountNotFoundError, validateOneOf } from '../utils/error-handler.js';
import { withUserAuthorization } from './tool-context.js';
import { emailProviders, getProviderById, getProviderByEmail } from '../providers/email-providers.js';

export function accountTools(
  server: McpServer,
  db: DatabaseService,
  imapService: ImapService
): void {
  // Add account tool with SMTP support
  server.registerTool('imap_add_account', {
    description: 'Add a new IMAP account with optional SMTP configuration for current user (from MCP_USER_ID environment variable)',
    inputSchema: {
      name: z.string().describe('Friendly name for the account'),
      host: z.string().describe('IMAP server hostname'),
      port: z.number().default(993).describe('IMAP server port (default: 993)'),
      user: z.string().describe('Username for authentication'),
      password: z.string().describe('Password for authentication'),
      tls: z.boolean().default(true).describe('Use TLS/SSL (default: true)'),
      // SMTP Configuration (optional)
      smtpHost: z.string().optional().describe('SMTP server hostname (optional, for sending emails)'),
      smtpPort: z.number().optional().describe('SMTP server port (default: 587 for STARTTLS, 465 for SSL)'),
      smtpSecure: z.boolean().optional().describe('Use SSL/TLS for SMTP (default: false, uses STARTTLS)'),
      smtpUser: z.string().optional().describe('SMTP username (defaults to IMAP user if not provided)'),
      smtpPassword: z.string().optional().describe('SMTP password (defaults to IMAP password if not provided)'),
    }
  }, withErrorHandling(withUserAuthorization(db, async ({ name, host, port, user, password, tls, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword }, context) => {
    // Create account for the authenticated user from context
    const account = db.createAccount({
      user_id: context.userId,
      name,
      host,
      port,
      username: user,
      password,
      tls,
      is_active: true,
      // SMTP configuration if provided
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_secure: smtpSecure,
      smtp_username: smtpUser || (smtpHost ? user : undefined),
      smtp_password: smtpPassword || (smtpHost ? password : undefined),
    });

    let message = `Account "${name}" added successfully for user ${context.username} (encrypted in database)`;
    if (smtpHost) {
      message += ` with SMTP enabled (${smtpHost}:${smtpPort || 587})`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          user: context.username,
          accountId: account.account_id,
          message,
          smtp: smtpHost ? {
            enabled: true,
            host: smtpHost,
            port: smtpPort || 587,
            secure: smtpSecure || false,
          } : {
            enabled: false
          },
        }, null, 2)
      }]
    };
  })));

  // List accounts tool
  server.registerTool('imap_list_accounts', {
    description: 'List all IMAP accounts for current user (from MCP_USER_ID environment variable)',
    inputSchema: {}
  }, withErrorHandling(withUserAuthorization(db, async (params, context) => {
    // Get accounts for the authenticated user from context
    const accounts = db.listDecryptedAccountsForUser(context.userId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          user: context.username,
          accounts: accounts.map(acc => ({
            id: acc.account_id,
            name: acc.name,
            host: acc.host,
            port: acc.port,
            user: acc.username,
            tls: acc.tls,
          })),
        }, null, 2)
      }]
    };
  })));

  // Remove account tool
  server.registerTool('imap_remove_account', {
    description: 'Remove an IMAP account from database',
    inputSchema: {
      accountId: z.string().describe('ID of the account to remove'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    await imapService.disconnect(accountId);
    db.deleteAccount(accountId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Account ${accountId} removed successfully`,
        }, null, 2)
      }]
    };
  }));

  // Connect to account tool
  server.registerTool('imap_connect', {
    description: 'Connect to an IMAP account',
    inputSchema: {
      accountId: z.string().describe('Account ID to connect to'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    const account = db.getDecryptedAccount(accountId);

    if (!account) {
      throw new AccountNotFoundError(accountId);
    }

    // Convert database account to ImapAccount format
    await imapService.connect({
      id: account.account_id,
      name: account.name,
      host: account.host,
      port: account.port,
      user: account.username,
      password: account.password,
      tls: account.tls
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Connected to account "${account.name}"`,
          accountId: account.account_id,
        }, null, 2)
      }]
    };
  }));

  // Disconnect from account tool
  server.registerTool('imap_disconnect', {
    description: 'Disconnect from an IMAP account',
    inputSchema: {
      accountId: z.string().describe('Account ID to disconnect from'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    await imapService.disconnect(accountId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Disconnected from account ${accountId}`,
        }, null, 2)
      }]
    };
  }));

  // List email provider presets tool
  server.registerTool('imap_list_providers', {
    description: 'List all available email provider presets (Gmail, Outlook, Yahoo, etc.) with pre-configured IMAP/SMTP settings',
    inputSchema: {}
  }, withErrorHandling(async () => {
    const providers = emailProviders.map(p => ({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      imapHost: p.imapHost,
      imapPort: p.imapPort,
      imapSecurity: p.imapSecurity,
      smtpHost: p.smtpHost,
      smtpPort: p.smtpPort,
      smtpSecurity: p.smtpSecurity,
      domains: p.domains,
      requiresAppPassword: p.requiresAppPassword,
      oauth2Supported: p.oauth2Supported,
      helpUrl: p.helpUrl,
      notes: p.notes,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          count: providers.length,
          providers,
        }, null, 2)
      }]
    };
  }));

  // Add account using provider preset tool
  server.registerTool('imap_add_account_with_provider', {
    description: 'Add a new IMAP account using a provider preset (auto-fills IMAP/SMTP settings). Use imap_list_providers to see available providers.',
    inputSchema: {
      providerId: z.string().describe('Provider ID (e.g., "gmail", "outlook", "yahoo"). Use imap_list_providers to see all options.'),
      name: z.string().describe('Friendly name for the account'),
      email: z.string().describe('Email address'),
      password: z.string().describe('Password or app-specific password (see provider notes)'),
      smtpEnabled: z.boolean().default(false).describe('Enable SMTP for sending emails (default: false)'),
      imapUsername: z.string().optional().describe(
        'Override the IMAP login username. Defaults to the email address. Set this when the ' +
        'provider requires a non-email login form (e.g., "DOMAIN\\\\user" on Exchange, a short ' +
        'username on certain hosting setups). When set, the same value is also used as the SMTP ' +
        'username unless overridden separately.'
      ),
    }
  }, withErrorHandling(withUserAuthorization(db, async ({ providerId, name, email, password, smtpEnabled, imapUsername }, context) => {
    // Get provider preset
    const provider = getProviderById(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}. Use imap_list_providers to see available providers.`);
    }

    const loginUsername = imapUsername ?? email;

    // Create account with provider settings
    const account = db.createAccount({
      user_id: context.userId,
      name,
      host: provider.imapHost,
      port: provider.imapPort,
      username: loginUsername,
      password,
      tls: provider.imapSecurity === 'SSL' || provider.imapSecurity === 'TLS',
      is_active: true,
      smtp_host: smtpEnabled && provider.smtpHost ? provider.smtpHost : undefined,
      smtp_port: smtpEnabled && provider.smtpPort ? provider.smtpPort : undefined,
      smtp_secure: smtpEnabled && provider.smtpSecurity ? (provider.smtpSecurity === 'SSL' || provider.smtpSecurity === 'TLS') : undefined,
      smtp_username: smtpEnabled ? loginUsername : undefined,
      smtp_password: smtpEnabled ? password : undefined,
    });

    let message = `Account "${name}" added successfully for ${provider.displayName}`;
    if (provider.requiresAppPassword) {
      message += ` ⚠️ NOTE: ${provider.notes || 'This provider requires an app-specific password.'}`;
    }
    if (provider.helpUrl) {
      message += ` See: ${provider.helpUrl}`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          user: context.username,
          accountId: account.account_id,
          provider: provider.displayName,
          message,
          settings: {
            imap: {
              host: provider.imapHost,
              port: provider.imapPort,
              security: provider.imapSecurity,
            },
            smtp: smtpEnabled && provider.smtpHost ? {
              host: provider.smtpHost,
              port: provider.smtpPort,
              security: provider.smtpSecurity,
            } : undefined,
          },
        }, null, 2)
      }]
    };
  })));

  // Auto-detect provider from email and add account tool
  server.registerTool('imap_add_account_auto', {
    description: 'Add a new IMAP account by auto-detecting provider from email address (e.g., @gmail.com → Gmail preset)',
    inputSchema: {
      name: z.string().describe('Friendly name for the account'),
      email: z.string().describe('Email address (provider will be auto-detected from domain)'),
      password: z.string().describe('Password or app-specific password'),
      smtpEnabled: z.boolean().default(false).describe('Enable SMTP for sending emails (default: false)'),
      imapUsername: z.string().optional().describe(
        'Override the IMAP login username. Defaults to the email address. Set this when the ' +
        'provider requires a non-email login form (e.g., "DOMAIN\\\\user" on Exchange). When set, ' +
        'the same value is also used as the SMTP username.'
      ),
    }
  }, withErrorHandling(withUserAuthorization(db, async ({ name, email, password, smtpEnabled, imapUsername }, context) => {
    // Auto-detect provider from email
    const provider = getProviderByEmail(email);
    if (!provider) {
      throw new Error(`Could not auto-detect provider for ${email}. Use imap_add_account for manual configuration or imap_add_account_with_provider with a specific provider.`);
    }

    const loginUsername = imapUsername ?? email;

    // Create account with auto-detected provider settings
    const account = db.createAccount({
      user_id: context.userId,
      name,
      host: provider.imapHost,
      port: provider.imapPort,
      username: loginUsername,
      password,
      tls: provider.imapSecurity === 'SSL' || provider.imapSecurity === 'TLS',
      is_active: true,
      smtp_host: smtpEnabled && provider.smtpHost ? provider.smtpHost : undefined,
      smtp_port: smtpEnabled && provider.smtpPort ? provider.smtpPort : undefined,
      smtp_secure: smtpEnabled && provider.smtpSecurity ? (provider.smtpSecurity === 'SSL' || provider.smtpSecurity === 'TLS') : undefined,
      smtp_username: smtpEnabled ? loginUsername : undefined,
      smtp_password: smtpEnabled ? password : undefined,
    });

    let message = `Account "${name}" added successfully (auto-detected: ${provider.displayName})`;
    if (provider.requiresAppPassword) {
      message += ` ⚠️ NOTE: ${provider.notes || 'This provider requires an app-specific password.'}`;
    }
    if (provider.helpUrl) {
      message += ` See: ${provider.helpUrl}`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          user: context.username,
          accountId: account.account_id,
          provider: provider.displayName,
          autoDetected: true,
          message,
          settings: {
            imap: {
              host: provider.imapHost,
              port: provider.imapPort,
              security: provider.imapSecurity,
            },
            smtp: smtpEnabled && provider.smtpHost ? {
              host: provider.smtpHost,
              port: provider.smtpPort,
              security: provider.smtpSecurity,
            } : undefined,
          },
        }, null, 2)
      }]
    };
  })));

  // imap_get_outbox_dir (#148): return the per-user attachment outbox path.
  // Creates the dir on first access (mode 0700). The dir is always present
  // in the resolved allow-list, so writing files there means imap_send_email
  // can attach them via attachmentPaths without any env / user_config setup.
  server.registerTool('imap_get_outbox_dir', {
    description:
      'Return the per-user attachment outbox directory path. Files written to this directory ' +
      'can be attached via imap_send_email\'s attachmentPaths field with no additional setup — ' +
      'the directory is always present in the resolved allow-list. The same v2.17.9 dotfile / ' +
      'size / filename rules apply as for any allow-listed dir; this is a sanctioned drop zone, ' +
      'not a special exempt zone. The directory is created lazily on first access (mode 0700) ' +
      'under ~/.imap-mcp/users/<userId>/outbox/. Use this when an agent needs to email a file ' +
      'it just generated on the server host, instead of base64-inlining the bytes through MCP.',
    inputSchema: {}
  }, withErrorHandling(withUserAuthorization(db, async (_args, context) => {
    const { getOutboxDir } = await import('../services/attachment-validator.js');
    const outboxDir = getOutboxDir(context.userId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          outboxDir,
          userId: context.userId,
          username: context.username,
          usage:
            'Write attachment files to this directory, then reference them via attachmentPaths ' +
            'in imap_send_email. Same dotfile / size / filename rules apply as for any allow-listed dir.',
        }, null, 2)
      }]
    };
  })));

  // imap_test_account (#90): one-shot connectivity probe against an existing
  // account using stored credentials. Spawns a fresh ImapFlow client to avoid
  // touching the connection pool / circuit breaker — useful right after
  // imap_add_account_with_provider to confirm the credentials work without
  // first calling imap_connect (which would warm up state and reroute through
  // breaker logic).
  server.registerTool('imap_test_account', {
    description:
      'Test an existing account\'s IMAP connectivity using its stored credentials. ' +
      'Spawns a one-shot connection that does not affect the persistent connection pool ' +
      'or circuit breaker state. Returns folder count and INBOX message count on success, ' +
      'or a structured error (TLS / auth / DNS / timeout) on failure with a duration in ms. ' +
      'Useful immediately after imap_add_account_with_provider or imap_add_account_auto to ' +
      'verify credentials before relying on the account.',
    inputSchema: {
      accountId: z.string().describe('Account ID to test (from imap_list_accounts).'),
    }
  }, withErrorHandling(withUserAuthorization(db, async ({ accountId }, context) => {
    const dbAccount = db.getDecryptedAccount(accountId);
    if (!dbAccount) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            result: 'account_not_found',
            accountId,
          }, null, 2)
        }]
      };
    }
    if (dbAccount.user_id !== context.userId) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            result: 'account_not_owned_by_caller',
            accountId,
            hint: 'The accountId belongs to a different user. Pass an accountId returned by imap_list_accounts for the current MCP_USER_ID.',
          }, null, 2)
        }]
      };
    }

    const account = {
      id: dbAccount.account_id,
      name: dbAccount.name,
      host: dbAccount.host,
      port: dbAccount.port,
      user: dbAccount.username,
      password: dbAccount.password,
      tls: dbAccount.tls,
    };

    const result = await imapService.testConnection(account);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.ok,
          accountId,
          accountName: dbAccount.name,
          host: dbAccount.host,
          port: dbAccount.port,
          tls: dbAccount.tls,
          folderCount: result.folderCount,
          inboxMessageCount: result.inboxMessageCount,
          error: result.error,
          durationMs: result.durationMs,
        }, null, 2)
      }]
    };
  })));
}