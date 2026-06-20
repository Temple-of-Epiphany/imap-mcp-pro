import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import fs from 'fs';
import os from 'os';
import { DatabaseService } from '../services/database-service.js';
import { ImapService } from '../services/imap-service.js';
import { UserCheckService } from '../services/usercheck-service.js';
import { emailProviders, getProviderByEmail } from '../providers/email-providers.js';
import { dnsProviders } from '../providers/dns-providers.js';
import { ImapAccount } from '../types/index.js';
import crypto from 'crypto';

/** Return a copy of `obj` with all `undefined`-valued keys removed. */
function pickDefined(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Project a decrypted DB account row into the web UI's account shape. */
function toWebAccount(acc: any) {
  return {
    id: acc.account_id,
    name: acc.name,
    user: acc.username,
    host: acc.host,
    port: acc.port,
    tls: acc.tls,
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebUIServerOptions {
  /** Preferred port. Defaults to 4500. Actual bind port may differ if a collision triggers fallback. */
  port?: number;
  /** Optional shared DatabaseService — pass when embedding inside the MCP server process to avoid double-opening data.db. */
  db?: DatabaseService;
  /** Optional shared ImapService — pass alongside `db` when embedding. */
  imapService?: ImapService;
}

export class WebUIServer {
  private app: express.Application;
  private db: DatabaseService;
  private imapService: ImapService;
  private port: number;
  private defaultUserId: string;
  private authLimiter: any; // Rate limiter for auth endpoints
  private publicPath!: string; // resolved during setupMiddleware; SPA catch-all uses it

  /**
   * Construct a WebUIServer.
   *
   * Two call shapes are supported for backward compatibility:
   *   - `new WebUIServer(4500)` — legacy positional port (used by setup.ts CLI path)
   *   - `new WebUIServer({ port, db, imapService })` — modern object form (used when
   *     embedding inside the MCP server process; shares the live DB/IMAP handles)
   */
  constructor(opts: number | WebUIServerOptions = 4500) {
    const o: WebUIServerOptions =
      typeof opts === 'number' ? { port: opts } : opts;
    this.app = express();
    this.port = o.port ?? 4500;
    this.db = o.db ?? new DatabaseService();
    this.imapService = o.imapService ?? new ImapService(this.db); // Pass db for auto-capability storage (Issue #58)

    // Use same user resolution logic as MCP server (from tool-context.ts)
    // Get username from environment (set in MCP config) or fall back to 'default'
    const username = process.env.MCP_USER_ID || 'default';

    // Get or create user
    let user = this.db.getUserByUsername(username);
    if (!user) {
      user = this.db.createUser({
        user_id: crypto.randomUUID(),
        username: username,
        email: undefined,
        organization: 'Personal',
        is_active: true
      });
    }
    this.defaultUserId = user.user_id;

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    // SECURITY: Restrict CORS to localhost only (Issue #24)
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (same-origin) or from localhost
        if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
          callback(null, true);
        } else {
          callback(new Error('CORS policy: Origin not allowed'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // SECURITY: Global rate limiter (Issue #26)
    const globalLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per window
      message: { success: false, error: 'Too many requests from this IP, please try again later' },
      standardHeaders: true,
      legacyHeaders: false
    });

    // SECURITY: Speed limiter - delays responses after threshold (Issue #26)
    const speedLimiter = slowDown({
      windowMs: 15 * 60 * 1000, // 15 minutes
      delayAfter: 50, // Allow 50 requests per window at full speed
      delayMs: (hits) => hits * 100 // Add 100ms delay per request above threshold
    });

    // SECURITY: Strict rate limiter for authentication endpoints (Issue #26)
    this.authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10, // Only 10 auth attempts per 15 minutes
      message: {
        success: false,
        error: 'Too many authentication attempts, please try again later',
        help: '💡 Rate limit exceeded. Please wait 15 minutes before trying again, or check your password to avoid repeated failures.'
      },
      skipSuccessfulRequests: false, // Count all attempts
      standardHeaders: true,
      legacyHeaders: false
    });

    this.app.use(bodyParser.json());
    this.app.use(globalLimiter);
    this.app.use(speedLimiter);

    // Serve static files from public directory.
    // Path resolution differs between dev and prod:
    //   - dev (tsx src/web/server.ts):    __dirname = repo/src/web   -> ../../public
    //   - prod (node dist/web/server.js): __dirname = repo/dist/web  -> ../public  (postbuild stages public/)
    // Probe both candidates and fail loudly if neither exists, instead of silently 404-ing.
    const candidates = [
      path.join(__dirname, '../../public'),
      path.join(__dirname, '../public'),
    ];
    const publicPath = candidates.find(p => {
      try { return fs.statSync(p).isDirectory(); }
      catch { return false; }
    });
    if (!publicPath) {
      throw new Error(
        `[WebUIServer] Web UI assets not found. Tried:\n  ${candidates.join('\n  ')}\n` +
        `Run 'npm run build' (postbuild stages public/ -> dist/public/) or check that the .mcpb extension was built with v2.17.10+.`
      );
    }
    this.publicPath = publicPath;
    // stderr so Claude Desktop captures it; stdout is reserved for JSON-RPC.
    console.error(`[WebUIServer] serving static assets from ${publicPath}`);
    this.app.use(express.static(publicPath));
  }

  private setupRoutes(): void {
    // Get all email providers
    this.app.get('/api/providers', (req, res) => {
      res.json(emailProviders);
    });

    // Get all DNS firewall providers
    this.app.get('/api/dns-providers', (req, res) => {
      res.json(dnsProviders);
    });

    // Get all accounts
    this.app.get('/api/accounts', (req, res) => {
      try {
        const accounts = this.db.listDecryptedAccountsForUser(this.defaultUserId);
        // Convert to web UI format (adds SMTP block when configured).
        const webAccounts = accounts.map(acc => ({
          ...toWebAccount(acc),
          smtp: acc.smtp_host
            ? { host: acc.smtp_host, port: acc.smtp_port, tls: acc.smtp_secure }
            : undefined,
        }));
        res.json(webAccounts);
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch accounts' });
      }
    });

    // Add new account
    this.app.post('/api/accounts', async (req, res) => {
      try {
        const { name, email, password, host, port, tls, smtp } = req.body;

        // Auto-detect IMAP settings from the email domain when host is omitted.
        let imapHost = host;
        let imapPort = port;
        let useTls = tls;

        const detected = !host && email ? getProviderByEmail(email) : undefined;
        if (detected) {
          imapHost = detected.imapHost;
          imapPort = detected.imapPort;
          useTls = detected.imapSecurity !== 'STARTTLS';
        }

        const account = this.db.createAccount({
          user_id: this.defaultUserId,
          name: name || email,
          host: imapHost,
          port: imapPort || 993,
          username: email,
          password,
          tls: useTls !== false,
          smtp_host: smtp?.host,
          smtp_port: smtp?.port,
          smtp_username: smtp?.user || email,
          smtp_password: smtp?.password,
          smtp_secure: smtp?.secure ?? smtp?.tls, // Accept both 'secure' and 'tls' field names
          is_active: true
        });

        res.json({ success: true, account: toWebAccount(account) });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to add account'
        });
      }
    });

    // Test connection (with strict rate limiting)
    this.app.post('/api/test-connection', this.authLimiter, async (req, res) => {
      const startTime = Date.now();

      try {
        const { email, password, host, port, tls } = req.body;

        // Create temporary account for testing
        const testAccount: ImapAccount = {
          id: 'test-' + Date.now(),
          name: 'Test',
          host: host || 'imap.gmail.com',
          port: port || 993,
          user: email,
          password,
          tls: tls !== false,
        };

        // Try to connect
        await this.imapService.connect(testAccount);

        // Get folder list to verify connection works
        const folders = await this.imapService.listFolders(testAccount.id);

        // Calculate connection time
        const connectionTime = Date.now() - startTime;

        // Disconnect
        await this.imapService.disconnect(testAccount.id);

        res.json({
          success: true,
          details: {
            folderCount: folders.length,
            connectionTime: connectionTime,
            serverHost: testAccount.host,
            serverPort: testAccount.port,
            tlsEnabled: testAccount.tls
          }
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Connection test failed';

        // Provide helpful error messages based on common issues
        let helpText = '';

        if (errorMessage.toLowerCase().includes('auth') || errorMessage.toLowerCase().includes('login') || errorMessage.toLowerCase().includes('invalid credentials')) {
          helpText = '💡 **Authentication failed.** Check your password or use an app-specific password (required for Gmail, Yahoo, and some other providers).';
        } else if (errorMessage.toLowerCase().includes('timeout') || errorMessage.toLowerCase().includes('timed out')) {
          helpText = '💡 **Connection timeout.** Check that the host and port are correct. Verify your firewall allows IMAP connections. Try toggling the TLS setting.';
        } else if (errorMessage.toLowerCase().includes('econnrefused') || errorMessage.toLowerCase().includes('connection refused')) {
          helpText = '💡 **Connection refused.** Verify the server address is correct. Check if IMAP is enabled in your account settings. Try a different port (993 for TLS, 143 for non-TLS).';
        } else if (errorMessage.toLowerCase().includes('ssl') || errorMessage.toLowerCase().includes('tls') || errorMessage.toLowerCase().includes('certificate')) {
          helpText = '💡 **SSL/TLS error.** Try toggling the TLS setting. Some servers use port 143 without TLS, others use 993 with TLS.';
        } else if (errorMessage.toLowerCase().includes('enotfound') || errorMessage.toLowerCase().includes('getaddrinfo')) {
          helpText = '💡 **Server not found.** Check that the host name is spelled correctly. Verify you have an internet connection.';
        } else {
          helpText = '💡 **Connection failed.** Double-check all settings and try again. If using Gmail or Yahoo, you may need an app-specific password.';
        }

        res.status(400).json({
          success: false,
          error: errorMessage,
          help: helpText
        });
      }
    });

    // Remove account
    this.app.delete('/api/accounts/:id', async (req, res) => {
      try {
        await this.imapService.disconnect(req.params.id);
        this.db.deleteAccount(req.params.id);
        res.json({ success: true });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to remove account'
        });
      }
    });

    // Update account
    this.app.put('/api/accounts/:id', async (req, res) => {
      try {
        const { name, email, password, host, port, tls, smtp } = req.body;

        const updates: any = pickDefined({ name, username: email, password, host, port, tls });

        // Handle SMTP configuration
        if ('smtp' in req.body) {
          if (smtp) {
            // SMTP is enabled - update fields
            if (smtp.host !== undefined) updates.smtp_host = smtp.host;
            if (smtp.port !== undefined) updates.smtp_port = smtp.port;
            if (smtp.user !== undefined) updates.smtp_username = smtp.user;
            if (smtp.password !== undefined) updates.smtp_password = smtp.password;
            // Accept both 'secure' and 'tls' field names for TLS/SSL setting
            if (smtp.secure !== undefined) updates.smtp_secure = smtp.secure;
            else if (smtp.tls !== undefined) updates.smtp_secure = smtp.tls;
          } else {
            // SMTP is disabled - clear all SMTP fields
            updates.smtp_host = null;
            updates.smtp_port = null;
            updates.smtp_username = null;
            updates.smtp_password = null;
            updates.smtp_secure = null;
          }
        }

        this.db.updateAccount(req.params.id, updates);
        const account = this.db.getAccount(req.params.id);

        if (!account) {
          res.status(404).json({ success: false, error: 'Account not found after update' });
          return;
        }

        res.json({ success: true, account: toWebAccount(account) });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update account'
        });
      }
    });

    // Get single account
    this.app.get('/api/accounts/:id', async (req, res) => {
      try {
        const account = this.db.getAccount(req.params.id);
        if (!account) {
          res.status(404).json({ success: false, error: 'Account not found' });
        } else {
          // Don't send encrypted passwords to client
          const safeAccount = {
            id: account.account_id,
            name: account.name,
            user: account.username,
            host: account.host,
            port: account.port,
            tls: account.tls,
            smtp: account.smtp_host ? {
              host: account.smtp_host,
              port: account.smtp_port,
              user: account.smtp_username,
              tls: account.smtp_secure
            } : undefined
          };

          res.json({ success: true, account: safeAccount });
        }
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get account'
        });
      }
    });

    // Test account connection (with strict rate limiting)
    this.app.post('/api/accounts/:id/test', this.authLimiter, async (req, res) => {
      const startTime = Date.now();

      try {
        const dbAccount = this.db.getDecryptedAccount(req.params.id);
        if (!dbAccount) {
          return res.status(404).json({
            success: false,
            error: 'Account not found'
          });
        }

        const results: any = {
          accountName: dbAccount.name,
          imap: { tested: false },
          smtp: { tested: false },
          totalTime: 0
        };

        // Test IMAP connection
        try {
          const imapAccount: ImapAccount = {
            id: dbAccount.account_id,
            name: dbAccount.name,
            host: dbAccount.host,
            port: dbAccount.port,
            user: dbAccount.username,
            password: dbAccount.password,
            tls: dbAccount.tls
          };

          await this.imapService.connect(imapAccount);

          // Get unread count from INBOX
          try {
            const unreadEmails = await this.imapService.searchEmails(dbAccount.account_id, 'INBOX', { seen: false });
            results.imap = {
              tested: true,
              success: true,
              unreadCount: unreadEmails.length,
              message: 'IMAP connection successful'
            };
          } catch (unreadError) {
            results.imap = {
              tested: true,
              success: true,
              unreadCount: 0,
              message: 'Connected but could not fetch unread count',
              warning: unreadError instanceof Error ? unreadError.message : 'Unknown error'
            };
          }

          // Disconnect after test
          await this.imapService.disconnect(dbAccount.account_id);
        } catch (imapError) {
          results.imap = {
            tested: true,
            success: false,
            error: imapError instanceof Error ? imapError.message : 'IMAP connection failed'
          };
        }

        // Test SMTP connection if configured
        if (dbAccount.smtp_host && dbAccount.smtp_port) {
          try {
            const transporter = nodemailer.createTransport({
              host: dbAccount.smtp_host,
              port: dbAccount.smtp_port,
              secure: dbAccount.smtp_secure || false,
              auth: {
                user: dbAccount.smtp_username || dbAccount.username,
                pass: dbAccount.smtp_password || dbAccount.password
              },
              connectionTimeout: 10000, // 10 second connection timeout
              greetingTimeout: 10000,   // 10 second greeting timeout
              socketTimeout: 10000      // 10 second socket timeout
            });

            // Add timeout wrapper for verify() operation
            const verifyWithTimeout = Promise.race([
              transporter.verify(),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('SMTP verification timed out after 10 seconds')), 10000)
              )
            ]);

            await verifyWithTimeout;
            results.smtp = {
              tested: true,
              success: true,
              message: 'SMTP connection successful'
            };
          } catch (smtpError) {
            results.smtp = {
              tested: true,
              success: false,
              error: smtpError instanceof Error ? smtpError.message : 'SMTP connection failed'
            };
          }
        } else {
          results.smtp = {
            tested: false,
            message: 'SMTP not configured'
          };
        }

        results.totalTime = Date.now() - startTime;
        res.json({ success: true, results });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Test failed',
          totalTime: Date.now() - startTime
        });
      }
    });

    // Check login status for all accounts
    this.app.get('/api/accounts/status', async (req, res) => {
      try {
        const userId = process.env.MCP_USER_ID || 'default';
        const accounts = this.db.listDecryptedAccountsForUser(userId);
        const statusResults = [];

        for (const dbAccount of accounts) {
          const imapAccount: ImapAccount = {
            id: dbAccount.account_id,
            name: dbAccount.name,
            host: dbAccount.host,
            port: dbAccount.port,
            user: dbAccount.username,
            password: dbAccount.password,
            tls: dbAccount.tls
          };

          let status = 'disconnected';
          let error = null;
          let connectionState = null;

          // Check if account has an active connection
          const metadata = (this.imapService as any).connectionMetadata.get(dbAccount.account_id);
          if (metadata) {
            connectionState = metadata.state;

            // Check circuit breaker status
            if (metadata.circuitBreaker) {
              const cb = metadata.circuitBreaker;
              if (cb.state === 'OPEN') {
                status = 'circuit_breaker_open';
                error = (cb as any).lastFailureReason || 'Too many failures - circuit breaker opened';
              } else if (cb.state === 'HALF_OPEN') {
                status = 'recovering';
              } else if (metadata.state === 'connected') {
                status = 'connected';
              } else if (metadata.state === 'error') {
                status = 'error';
                error = (cb as any).lastFailureReason || 'Connection error';
              }
            }
          }

          statusResults.push({
            id: dbAccount.account_id,
            name: dbAccount.name,
            email: dbAccount.username,
            host: dbAccount.host,
            status: status,
            connectionState: connectionState,
            error: error
          });
        }

        res.json({ success: true, accounts: statusResults });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check account status'
        });
      }
    });

    // Get UserCheck API keys for user
    this.app.get('/api/usercheck/keys', (req, res) => {
      try {
        const stmt = this.db['db'].prepare(`
          SELECT id, api_key, is_active, daily_limit, daily_usage,
                 usage_reset_at, last_used, created_at, notes
          FROM usercheck_keys
          WHERE user_id = ?
          ORDER BY created_at DESC
        `);

        const keys = stmt.all(this.defaultUserId) as any[];

        res.json({
          success: true,
          keys: keys.map(k => ({
            id: k.id,
            apiKey: k.api_key.substring(0, 8) + '...' + k.api_key.substring(k.api_key.length - 4), // Masked
            isActive: k.is_active === 1,
            dailyLimit: k.daily_limit,
            dailyUsage: k.daily_usage,
            usageResetAt: k.usage_reset_at,
            lastUsed: k.last_used,
            createdAt: k.created_at,
            notes: k.notes
          }))
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load UserCheck keys'
        });
      }
    });

    // Add UserCheck API key
    this.app.post('/api/usercheck/keys', (req, res) => {
      try {
        const { apiKey, dailyLimit, notes } = req.body;

        if (!apiKey || apiKey.trim().length === 0) {
          return res.status(400).json({
            success: false,
            error: 'API key is required'
          });
        }

        this.db['db'].prepare(`
          INSERT INTO usercheck_keys (user_id, api_key, daily_limit, notes, is_active)
          VALUES (?, ?, ?, ?, 1)
        `).run(this.defaultUserId, apiKey.trim(), dailyLimit || 1000, notes || null);

        res.json({
          success: true,
          message: 'UserCheck API key added successfully'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to add UserCheck key'
        });
      }
    });

    // Delete UserCheck API key
    this.app.delete('/api/usercheck/keys/:keyId', (req, res) => {
      try {
        const keyId = parseInt(req.params.keyId);

        if (isNaN(keyId)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid key ID'
          });
        }

        this.db['db'].prepare('DELETE FROM usercheck_keys WHERE id = ? AND user_id = ?')
          .run(keyId, this.defaultUserId);

        res.json({
          success: true,
          message: 'UserCheck API key deleted successfully'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete UserCheck key'
        });
      }
    });

    // Check email with UserCheck (backs the "Test" button in the SPAM Check view)
    this.app.post('/api/usercheck/check-email', async (req, res) => {
      try {
        const { email, checkDisposable, checkBlocklisted, checkMx, checkRoleAccount, allowPublicDomains } = req.body;

        if (!email) {
          return res.status(400).json({
            success: false,
            error: 'Email is required'
          });
        }

        const userCheckService = new UserCheckService(this.db);
        const result = await userCheckService.checkEmail(
          this.defaultUserId,
          email,
          {
            checkDisposable: checkDisposable !== false,
            checkBlocklisted: checkBlocklisted !== false,
            checkMx: checkMx !== false,
            checkRoleAccount: checkRoleAccount !== false,
            allowPublicDomains: allowPublicDomains !== false
          }
        );

        res.json({
          success: true,
          result
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check email'
        });
      }
    });

    // Check domain with UserCheck
    this.app.post('/api/usercheck/check-domain', async (req, res) => {
      try {
        const { domain, checkDisposable, checkBlocklisted, checkMx, allowPublicDomains } = req.body;

        if (!domain) {
          return res.status(400).json({
            success: false,
            error: 'Domain is required'
          });
        }

        const userCheckService = new UserCheckService(this.db);
        const result = await userCheckService.checkDomain(
          this.defaultUserId,
          domain,
          {
            checkDisposable: checkDisposable !== false,
            checkBlocklisted: checkBlocklisted !== false,
            checkMx: checkMx !== false,
            allowPublicDomains: allowPublicDomains !== false
          }
        );

        res.json({
          success: true,
          result
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check domain'
        });
      }
    });

    // DNS Firewall Providers (Issue #60)
    // Get all DNS firewall providers
    this.app.get('/api/dns-firewall/providers', (req, res) => {
      try {
        const providers = this.db.getDnsFirewallProviders();
        res.json({
          success: true,
          providers: providers.map((p: any) => ({
            providerId: p.provider_id,
            providerName: p.provider_name,
            providerType: p.provider_type,
            apiEndpoint: p.api_endpoint,
            isEnabled: p.is_enabled === 1,
            isDefault: p.is_default === 1,
            timeoutMs: p.timeout_ms,
            createdAt: p.created_at,
            updatedAt: p.updated_at
          }))
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load DNS firewall providers'
        });
      }
    });

    // Update DNS firewall provider
    this.app.put('/api/dns-firewall/providers/:providerId', (req, res) => {
      try {
        const { providerId } = req.params;
        const { isEnabled, isDefault, timeoutMs, providerName, apiEndpoint, apiKey } = req.body;

        const updates: any = {};
        if (isEnabled !== undefined) updates.isEnabled = isEnabled;
        if (isDefault !== undefined) updates.isDefault = isDefault;
        if (timeoutMs !== undefined) updates.timeoutMs = timeoutMs;
        if (providerName !== undefined) updates.providerName = providerName;
        if (apiEndpoint !== undefined) updates.apiEndpoint = apiEndpoint;
        if (apiKey !== undefined) updates.apiKey = apiKey;

        this.db.updateDnsFirewallProvider(providerId, updates);

        res.json({
          success: true,
          message: 'DNS firewall provider updated successfully'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update DNS firewall provider'
        });
      }
    });

    // Test DNS firewall provider
    this.app.post('/api/dns-firewall/providers/:providerId/test', async (req, res) => {
      try {
        const { providerId } = req.params;
        const { domain } = req.body;

        if (!domain) {
          return res.status(400).json({
            success: false,
            error: 'Domain is required'
          });
        }

        const provider = this.db.getDnsFirewallProvider(providerId);
        if (!provider) {
          return res.status(404).json({
            success: false,
            error: 'DNS firewall provider not found'
          });
        }

        // Import dns module for testing
        const dns = await import('dns');
        const { promises: dnsPromises } = dns;

        const startTime = Date.now();

        try {
          // Simple DNS lookup test
          const addresses = await dnsPromises.resolve4(domain);
          const responseTime = Date.now() - startTime;

          res.json({
            success: true,
            domain,
            addresses,
            responseTime,
            blocked: false, // Basic DNS doesn't have blocking info
            provider: provider.provider_name
          });
        } catch (dnsError) {
          const responseTime = Date.now() - startTime;

          res.json({
            success: false,
            domain,
            responseTime,
            error: dnsError instanceof Error ? dnsError.message : 'DNS query failed',
            provider: provider.provider_name
          });
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to test DNS provider'
        });
      }
    });

    // Categories (Issue #61)
    // Get all categories for an account
    // ===================================
    // Quick Categories Endpoints (Issue #71)
    // ===================================

    // Get categories for user (optionally filtered by account)
    this.app.get('/api/categories', (req, res) => {
      try {
        const userId = process.env.MCP_USER_ID || 'default';
        const { accountId } = req.query;

        const categories = this.db.listCategoriesForUser(
          userId,
          accountId as string | undefined
        );

        res.json({
          success: true,
          categories: categories.map(c => ({
            categoryId: c.category_id,
            userId: c.user_id,
            accountId: c.account_id,
            categoryName: c.category_name,
            keywords: c.keywords,
            targetFolder: c.target_folder,
            enabled: c.enabled,
            matchCount: c.match_count,
            createdAt: c.created_at,
            updatedAt: c.updated_at,
            lastMatched: c.last_matched
          }))
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get categories'
        });
      }
    });

    // Create category
    this.app.post('/api/categories', (req, res) => {
      try {
        const userId = process.env.MCP_USER_ID || 'default';
        const { accountId, categoryName, keywords, targetFolder, enabled } = req.body;

        if (!accountId || !categoryName || !keywords || !targetFolder) {
          return res.status(400).json({
            success: false,
            error: 'accountId, categoryName, keywords, and targetFolder are required'
          });
        }

        const category = this.db.createCategory({
          user_id: userId,
          account_id: accountId,
          category_name: categoryName,
          keywords,
          target_folder: targetFolder,
          enabled: enabled !== undefined ? enabled : true
        });

        res.json({
          success: true,
          category: {
            categoryId: category.category_id,
            userId: category.user_id,
            accountId: category.account_id,
            categoryName: category.category_name,
            keywords: category.keywords,
            targetFolder: category.target_folder,
            enabled: category.enabled,
            matchCount: category.match_count,
            createdAt: category.created_at,
            updatedAt: category.updated_at
          },
          message: 'Category created successfully'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create category'
        });
      }
    });

    // Update category
    this.app.put('/api/categories/:categoryId', (req, res) => {
      try {
        const { categoryId } = req.params;
        const { categoryName, keywords, targetFolder, enabled } = req.body;

        const updates: any = {};
        if (categoryName !== undefined) updates.category_name = categoryName;
        if (keywords !== undefined) updates.keywords = keywords;
        if (targetFolder !== undefined) updates.target_folder = targetFolder;
        if (enabled !== undefined) updates.enabled = enabled;

        this.db.updateCategory(parseInt(categoryId), updates);

        res.json({
          success: true,
          message: 'Category updated successfully'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update category'
        });
      }
    });

    // Delete category
    this.app.delete('/api/categories/:categoryId', (req, res) => {
      try {
        const { categoryId } = req.params;
        this.db.deleteCategory(parseInt(categoryId));

        res.json({
          success: true,
          message: 'Category deleted successfully'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete category'
        });
      }
    });

    // Profile Information (Issue #61)
    this.app.get('/api/profile', (req, res) => {
      try {
        const dbPath = path.join(os.homedir(), '.imap-mcp', 'data.db');
        let dbSize = 0;
        try {
          const stats = fs.statSync(dbPath);
          dbSize = stats.size;
        } catch (e) {
          // Ignore if file doesn't exist
        }

        res.json({
          success: true,
          profile: {
            userId: this.defaultUserId,
            databasePath: dbPath,
            databaseSize: dbSize,
            version: '2.12.0'
          }
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get profile'
        });
      }
    });

    // Claude Desktop auto-configuration (macOS and Linux)
    this.app.get('/api/claude-setup/status', async (req, res) => {
      try {
        const platform = os.platform();
        if (platform !== 'darwin' && platform !== 'linux') {
          return res.json({
            success: true,
            supported: false,
            platform,
            message: 'Auto-configuration is only supported on macOS and Linux'
          });
        }

        const configPath = this.getClaudeConfigPath();
        const serverPath = path.resolve(__dirname, '../index.js');
        let configured = false;
        let configExists = false;
        let currentEntry: any = null;

        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(raw);
          configExists = true;
          if (config.mcpServers?.imap) {
            configured = true;
            currentEntry = config.mcpServers.imap;
          }
        } catch {
          // Config doesn't exist yet — that's fine
        }

        res.json({
          success: true,
          supported: true,
          platform,
          configPath,
          serverPath,
          configExists,
          configured,
          currentEntry,
          currentPort: this.port
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check status'
        });
      }
    });

    this.app.post('/api/claude-setup/configure', async (req, res) => {
      try {
        const platform = os.platform();
        if (platform !== 'darwin' && platform !== 'linux') {
          return res.status(400).json({
            success: false,
            error: `Auto-configuration is not supported on ${platform}. Please configure manually.`
          });
        }

        const { userId, port } = req.body;
        const configPath = this.getClaudeConfigPath();
        const configDir = path.dirname(configPath);
        const serverPath = path.resolve(__dirname, '../index.js');

        // Create config directory if it doesn't exist
        fs.mkdirSync(configDir, { recursive: true });

        // Read existing config or start fresh
        let config: any = {};
        let wasExisting = false;
        try {
          const raw = fs.readFileSync(configPath, 'utf-8');
          config = JSON.parse(raw);
          wasExisting = true;
        } catch {
          config = {};
        }

        if (!config.mcpServers) {
          config.mcpServers = {};
        }

        const entry: any = {
          command: 'node',
          args: [serverPath],
          env: {
            MCP_USER_ID: userId || 'default',
            PORT: String(port || this.port)
          }
        };

        config.mcpServers.imap = entry;

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

        res.json({
          success: true,
          configPath,
          serverPath,
          entry,
          wasExisting,
          message: 'Claude Desktop configuration updated. Restart Claude Desktop to apply.'
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to configure Claude Desktop'
        });
      }
    });

    // Service port management (macOS LaunchAgent / Linux systemd)
    this.app.get('/api/service/config', (req, res) => {
      try {
        const platform = os.platform();
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.templeofepiphany.imap-mcp-pro.plist');
        const systemdUserPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'imap-mcp-pro.service');
        const systemdSystemPath = '/etc/systemd/system/imap-mcp-pro.service';

        let serviceFile: string | null = null;
        let serviceType: string | null = null;

        if (platform === 'darwin' && fs.existsSync(plistPath)) {
          serviceFile = plistPath;
          serviceType = 'launchagent';
        } else if (platform === 'linux') {
          if (fs.existsSync(systemdUserPath)) {
            serviceFile = systemdUserPath;
            serviceType = 'systemd-user';
          } else if (fs.existsSync(systemdSystemPath)) {
            serviceFile = systemdSystemPath;
            serviceType = 'systemd-system';
          }
        }

        res.json({
          success: true,
          platform,
          serviceFile,
          serviceType,
          currentPort: this.port
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to get service config' });
      }
    });

    this.app.post('/api/service/port', async (req, res) => {
      try {
        const { port } = req.body;
        const newPort = parseInt(port);
        if (!newPort || newPort < 1024 || newPort > 65535) {
          return res.status(400).json({ success: false, error: 'Port must be between 1024 and 65535' });
        }

        const platform = os.platform();

        if (platform === 'darwin') {
          const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.templeofepiphany.imap-mcp-pro.plist');
          if (!fs.existsSync(plistPath)) {
            return res.status(404).json({ success: false, error: 'LaunchAgent plist not found. Is the service installed?' });
          }

          // Read and update the plist PORT value
          let content = fs.readFileSync(plistPath, 'utf-8');
          // Replace existing PORT key/value pair, or inject before closing </dict>
          if (content.includes('<key>PORT</key>')) {
            content = content.replace(
              /(<key>PORT<\/key>\s*<string>)[^<]*/,
              `$1${newPort}`
            );
          } else {
            content = content.replace(
              /(<key>IMAP_MCP_VERSION<\/key>)/,
              `<key>PORT</key>\n        <string>${newPort}</string>\n        $1`
            );
          }
          fs.writeFileSync(plistPath, content, 'utf-8');

          // Restart the LaunchAgent via a detached background script.
          // We cannot call launchctl unload synchronously — it kills this process
          // before launchctl load can run. The script runs after we respond.
          const label = 'com.templeofepiphany.imap-mcp-pro';
          const tmpScript = `/tmp/imap-mcp-restart-${Date.now()}.sh`;
          fs.writeFileSync(tmpScript,
            `#!/bin/bash\nsleep 1\nlaunchctl stop "${label}" 2>/dev/null || true\nlaunchctl unload "${plistPath}" 2>/dev/null || true\nlaunchctl load "${plistPath}"\nrm -f "${tmpScript}"\n`,
            { mode: 0o755 }
          );
          const { spawn } = await import('child_process');
          spawn('/bin/bash', [tmpScript], { detached: true, stdio: 'ignore' }).unref();

          res.json({
            success: true,
            newPort,
            plistPath,
            message: `Service restarting on port ${newPort}. Reconnect at http://localhost:${newPort}`
          });

        } else if (platform === 'linux') {
          const userPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'imap-mcp-pro.service');
          const systemPath = '/etc/systemd/system/imap-mcp-pro.service';
          const serviceFile = fs.existsSync(userPath) ? userPath : systemPath;
          const isUser = serviceFile === userPath;

          if (!fs.existsSync(serviceFile)) {
            return res.status(404).json({ success: false, error: 'Systemd service file not found. Is the service installed?' });
          }

          let content = fs.readFileSync(serviceFile, 'utf-8');
          if (content.includes('Environment="PORT=')) {
            content = content.replace(/Environment="PORT=[^"]*"/, `Environment="PORT=${newPort}"`);
          } else {
            content = content.replace(
              /Environment="IMAP_MCP_VERSION=/,
              `Environment="PORT=${newPort}"\nEnvironment="IMAP_MCP_VERSION=`
            );
          }
          fs.writeFileSync(serviceFile, content, 'utf-8');

          const systemctlCmd = isUser ? 'systemctl --user' : 'sudo systemctl';
          const tmpScript = `/tmp/imap-mcp-restart-${Date.now()}.sh`;
          fs.writeFileSync(tmpScript,
            `#!/bin/bash\nsleep 1\n${systemctlCmd} daemon-reload\n${systemctlCmd} restart imap-mcp-pro\nrm -f "${tmpScript}"\n`,
            { mode: 0o755 }
          );
          const { spawn } = await import('child_process');
          spawn('/bin/bash', [tmpScript], { detached: true, stdio: 'ignore' }).unref();

          res.json({
            success: true,
            newPort,
            serviceFile,
            message: `Service restarting on port ${newPort}. Reconnect at http://localhost:${newPort}`
          });

        } else {
          res.status(400).json({ success: false, error: `Service port management not supported on ${platform}` });
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to update service port' });
      }
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        mcpVersion: '2.9.0',
        uiVersion: '2.9.0',
        database: 'SQLite3 with AES-256-GCM encryption',
        features: ['multi-tenant', 'account-sharing', 'encrypted-storage', 'usercheck-integration', 'confidence-scoring']
      });
    });

    // System information
    this.app.get('/api/system-info', (req, res) => {
      try {
        // Get database schema version
        const schemaVersionResult = this.db['db'].prepare('SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1').get() as { version: number } | undefined;
        const schemaVersion = schemaVersionResult?.version || 0;

        // Get database file size
        const dbPath = path.join(os.homedir(), '.imap-mcp', 'data.db');
        let dbSize = 0;
        try {
          const stats = fs.statSync(dbPath);
          dbSize = stats.size;
        } catch (e) {
          // Ignore if file doesn't exist
        }

        // Get user count
        const userCountResult = this.db['db'].prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
        const userCount = userCountResult.count;

        // Get account count for this user
        const accountCountResult = this.db['db'].prepare('SELECT COUNT(*) as count FROM accounts WHERE user_id = ?').get(this.defaultUserId) as { count: number };
        const accountCount = accountCountResult.count;

        // Get username from users table
        const userResult = this.db['db'].prepare('SELECT username FROM users WHERE user_id = ?').get(this.defaultUserId) as { username: string } | undefined;
        const username = userResult?.username || this.defaultUserId;

        res.json({
          success: true,
          currentUser: username,
          database: {
            path: dbPath,
            size: dbSize,
            sizeFormatted: this.formatBytes(dbSize),
            schemaVersion,
            encryption: 'AES-256-GCM'
          },
          stats: {
            totalUsers: userCount,
            userAccounts: accountCount
          },
          server: {
            version: '2.9.0',
            port: this.port,
            features: ['multi-tenant', 'account-sharing', 'encrypted-storage', 'usercheck-integration', 'confidence-scoring']
          }
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get system info'
        });
      }
    });

    // ---- SPA catch-all (#159) ----
    // The Web UI is a single-page app: /, /accounts, /dns-firewall, etc.
    // are all rendered client-side from public/index.html. Without this
    // catch-all, deep links and browser refresh on a sub-route 404. Match
    // every GET that:
    //   - is not under /api/  (those should still 404 cleanly)
    //   - does not look like a static asset by extension (so missing
    //     assets fail honestly rather than silently returning HTML)
    // Falls through to publicPath/index.html for everything else.
    const ASSET_EXT_RE = /\.(js|css|map|json|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|otf)$/i;
    this.app.get(/^\/(?!api\/).*/, (req, res, next) => {
      if (ASSET_EXT_RE.test(req.path)) return next();
      const indexFile = path.join(this.publicPath, 'index.html');
      res.sendFile(indexFile, (err) => {
        if (err) next(err);
      });
    });
  }

  private getClaudeConfigPath(): string {
    const platform = os.platform();
    switch (platform) {
      case 'darwin':
        return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      case 'linux':
        return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
      case 'win32':
        return path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /** Port this server is configured to bind on. After successful start(), this is the live port. */
  getPort(): number { return this.port; }

  /** URL the server (will be / is) reachable at on localhost. */
  getUrl(): string { return `http://localhost:${this.port}`; }

  async start(autoOpen: boolean = true): Promise<void> {
    return new Promise((resolve) => {
      // SECURITY: Explicitly bind to localhost (127.0.0.1) to prevent external access
      const server = this.app.listen(this.port, '127.0.0.1', () => {
        // stderr (Claude Desktop captures stderr; stdout is JSON-RPC).
        console.error(`🌐 Web UI server running at http://localhost:${this.port}`);
        console.error(`🔒 Security: Server bound to localhost only (127.0.0.1)`);

        if (autoOpen) {
          // Open browser after a short delay
          setTimeout(() => {
            open(`http://localhost:${this.port}`);
          }, 1000);
        }

        resolve();
      });

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nShutting down web server...');
        server.close(() => {
          process.exit(0);
        });
      });
    });
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.PORT || '4500');
  const server = new WebUIServer(port);
  server.start();
}