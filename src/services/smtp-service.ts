// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * SmtpService — pooled SMTP send with retry classification + metrics
 *
 * WP3 (Issue #99): adds nodemailer pool support, exponential-backoff retry
 * for transient failures, provider-aware error guidance, per-account
 * counters, and a diagnostic test path that captures TLS info + EHLO
 * capabilities.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: original
 * Date Updated: 2026-04-30 (WP3)
 * Version: 0.2.0
 *
 * Tracker: #97. Issue: #99 (WP3).
 */

import nodemailer from 'nodemailer';
// MailComposer compiles the full MIME we hand to IMAP APPEND. The default
// `transporter.sendMail` path strips Bcc from the DATA payload per RFC 5322
// §3.6.3 — we want Bcc preserved in the Sent folder copy.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
// Low-level SMTP for the diagnostic tool — gives us greeting, capabilities,
// and TLS info that the high-level Transport hides.
import SMTPConnection from 'nodemailer/lib/smtp-connection/index.js';
import { ImapAccount, EmailComposer, SmtpConfig } from '../types/index.js';
import { humanBytes } from '../utils/human-bytes.js';
import {
  classifySmtpError,
  providerGuidanceFor,
  backoffMs,
  ClassifiedError,
  ErrorCategory,
} from './smtp-error-classifier.js';

export interface SendEmailOutcome {
  /** RFC 5322 Message-ID returned by the SMTP server */
  messageId: string;
  /** Full MIME (with Bcc header preserved) for IMAP APPEND to Sent folder */
  rawMessage: Buffer;
  /** Wall-clock send completion time; used as APPEND internal-date */
  sentAt: Date;
  /** Number of retry attempts we made (0 means succeeded on first try) */
  retriesAttempted: number;
}

export interface SmtpSendError {
  category: ErrorCategory;
  smtpCode: number | null;
  smtpMessage: string;
  providerGuidance: string | null;
  retriesAttempted: number;
  retryable: boolean;
}

/** Per-account SMTP metrics. Reset by resetMetrics(). */
export interface SmtpAccountMetrics {
  accountId: string;
  smtpHost: string;
  sendTotal: number;
  sendSuccessTotal: number;
  sendFailureTotal: number;
  retryTotal: number;
  retryByCategory: Record<ErrorCategory, number>;
  totalDurationMs: number;
  lastSendDurationMs: number | null;
  lastSendAt: string | null;
  lastError: { category: ErrorCategory; smtpCode: number | null; message: string } | null;
}

export interface PoolStats {
  configured: number;     // pools constructed (one per account that's sent)
  // The sum of these matches what the pool exposes on idle/active
  // counters — nodemailer doesn't expose them all directly, so we
  // capture what we can without poking into private state.
}

export interface PoolOptions {
  maxConnections?: number;
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
  healthCheck?: boolean;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface TestSmtpResult {
  success: boolean;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  tlsVersion: string | null;
  tlsCipher: string | null;
  certificateValid: boolean | null;
  certificateExpiresAt: string | null;
  serverGreeting: string | null;
  authMethods: string[];
  capabilities: string[];
  /** EHLO SIZE limit in bytes (RFC 1870), or null if the server doesn't advertise one. */
  sizeLimit: number | null;
  rttMs: number | null;
  authResult: 'ok' | 'failed' | 'skipped';
  authError: string | null;
  providerGuidance: string | null;
  transcript?: string[];
  error?: string;
}

const DEFAULT_POOL: Required<PoolOptions> = {
  maxConnections: 3,
  idleTimeoutSeconds: 60,
  maxLifetimeSeconds: 600,
  healthCheck: true,
};

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

export class SmtpService {
  private transporters: Map<string, nodemailer.Transporter> = new Map();
  private metrics: Map<string, SmtpAccountMetrics> = new Map();
  // Per-account EHLO SIZE limit (bytes, RFC 1870), captured by testSmtp. Used by
  // the SIZE-aware pre-send guard (#191) to fail fast on oversized messages.
  private sizeLimitByAccount: Map<string, number> = new Map();
  private poolOptions: Required<PoolOptions>;
  private retryOptions: Required<RetryOptions>;

  constructor(opts: { pool?: PoolOptions; retry?: RetryOptions } = {}) {
    this.poolOptions = { ...DEFAULT_POOL, ...opts.pool };
    this.retryOptions = { ...DEFAULT_RETRY, ...opts.retry };
  }

  // ---------- transport / pool ----------

  async createTransporter(account: ImapAccount): Promise<nodemailer.Transporter> {
    const cached = this.transporters.get(account.id);
    if (cached) return cached;

    const smtp = account.smtp ?? this.getDefaultSmtpConfig(account);

    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: {
        user: smtp.user || account.user,
        pass: smtp.password || account.password,
      },
      tls: smtp.tls,
      pool: true,
      maxConnections: this.poolOptions.maxConnections,
      // Bound message reuse and keep the idle window under the ~60-300s
      // window after which servers tend to drop the socket, so a pooled
      // connection is not reaped mid-send.
      maxMessages: 100,
      socketTimeout: this.poolOptions.idleTimeoutSeconds * 1000,
    });

    if (this.poolOptions.healthCheck) {
      await transporter.verify();
    }

    this.transporters.set(account.id, transporter);
    return transporter;
  }

  // Best-effort submission endpoint for accounts added without explicit SMTP
  // settings: known IMAP hosts map to their documented submission server; any
  // other host is derived from the IMAP hostname.
  private getDefaultSmtpConfig(account: ImapAccount): SmtpConfig {
    const submissionByImapHost: Record<string, SmtpConfig> = {
      'imap.gmail.com':        { host: 'smtp.gmail.com',        port: 587, secure: false },
      'outlook.office365.com': { host: 'smtp.office365.com',    port: 587, secure: false },
      'imap-mail.outlook.com': { host: 'smtp-mail.outlook.com', port: 587, secure: false },
      'imap.mail.yahoo.com':   { host: 'smtp.mail.yahoo.com',   port: 587, secure: false },
      'imap.aol.com':          { host: 'smtp.aol.com',          port: 587, secure: false },
      'imap.fastmail.com':     { host: 'smtp.fastmail.com',     port: 587, secure: false },
    };

    const known = submissionByImapHost[account.host];
    if (known) return known;

    return {
      host: account.host.replace('imap.', 'smtp.').replace('imap-', 'smtp-'),
      port: account.tls ? 465 : 587,
      secure: account.port === 993,
    };
  }

  // ---------- metrics ----------

  private metricsFor(account: ImapAccount): SmtpAccountMetrics {
    let m = this.metrics.get(account.id);
    if (m) return m;
    const smtpHost = account.smtp?.host ?? this.getDefaultSmtpConfig(account).host;
    m = {
      accountId: account.id,
      smtpHost,
      sendTotal: 0,
      sendSuccessTotal: 0,
      sendFailureTotal: 0,
      retryTotal: 0,
      retryByCategory: { transient: 0, permanent: 0, authentication: 0, configuration: 0 },
      totalDurationMs: 0,
      lastSendDurationMs: null,
      lastSendAt: null,
      lastError: null,
    };
    this.metrics.set(account.id, m);
    return m;
  }

  getSmtpMetrics(accountId?: string): SmtpAccountMetrics[] {
    if (accountId) {
      const m = this.metrics.get(accountId);
      return m ? [m] : [];
    }
    return Array.from(this.metrics.values());
  }

  resetSmtpMetrics(accountId?: string): void {
    if (accountId) this.metrics.delete(accountId);
    else this.metrics.clear();
  }

  getPoolStats(): PoolStats {
    return { configured: this.transporters.size };
  }

  // ---------- SIZE-aware send limits (#191) ----------

  /** The server's advertised EHLO SIZE limit for an account (bytes), or null if unknown. */
  getServerSizeLimit(accountId: string): number | null {
    return this.sizeLimitByAccount.get(accountId) ?? null;
  }

  /** Record a known server SIZE limit (bytes) for an account. testSmtp calls this from EHLO. */
  setServerSizeLimit(accountId: string, bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) this.sizeLimitByAccount.set(accountId, bytes);
  }

  /**
   * Effective pre-send size ceiling (bytes) for an account, or null if unknown.
   * The smaller of the configured cap (IMAP_MCP_MAX_SEND_SIZE_BYTES; 0/unset =
   * no config cap) and the server's advertised EHLO SIZE limit (RFC 1870).
   */
  private sendSizeCeiling(accountId: string): { ceiling: number | null; configCap: number | null; serverLimit: number | null } {
    const rawCfg = Number(process.env.IMAP_MCP_MAX_SEND_SIZE_BYTES);
    const configCap = Number.isFinite(rawCfg) && rawCfg > 0 ? rawCfg : null;
    const serverLimit = this.sizeLimitByAccount.get(accountId) ?? null;
    const candidates = [configCap, serverLimit].filter((n): n is number => n != null);
    const ceiling = candidates.length ? Math.min(...candidates) : null;
    return { ceiling, configCap, serverLimit };
  }

  // ---------- send ----------

  /** Backward-compatible helper that returns only the Message-ID. */
  async sendEmail(accountId: string, account: ImapAccount, email: EmailComposer): Promise<string> {
    const { messageId } = await this.sendEmailWithCopy(accountId, account, email);
    return messageId;
  }

  /**
   * Send with retry classification + Sent-folder MIME capture.
   * On unrecoverable failure, throws a regular Error with an attached
   * `classified: ClassifiedError` property.
   */
  async sendEmailWithCopy(
    accountId: string,
    account: ImapAccount,
    email: EmailComposer
  ): Promise<SendEmailOutcome> {
    const m = this.metricsFor(account);
    const smtpHost = m.smtpHost;
    m.sendTotal += 1;

    // Classify failures from createTransporter (verify auth) the same way
    // as failures from sendMail — otherwise auth errors during pool warmup
    // bypass the classifier and the caller can't see retriesAttempted/
    // category/providerGuidance.
    let transporter;
    try {
      transporter = await this.createTransporter(account);
    } catch (err) {
      const c = classifySmtpError(err, smtpHost);
      m.sendFailureTotal += 1;
      m.lastError = { category: c.category, smtpCode: c.smtpCode, message: c.smtpMessage };
      const e = new Error(c.smtpMessage || 'SMTP transport setup failed') as Error & { classified: ClassifiedError; retriesAttempted: number };
      e.classified = c;
      e.retriesAttempted = 0;
      throw e;
    }

    const mailOptions: nodemailer.SendMailOptions = {
      from: email.from || account.user,
      to: email.to,
      cc: email.cc,
      bcc: email.bcc,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments?.map(att => ({
        filename: att.filename,
        content: att.content,
        path: att.path,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        cid: att.cid,
      })),
      replyTo: email.replyTo,
      inReplyTo: email.inReplyTo,
      references: Array.isArray(email.references) ? email.references.join(' ') : email.references,
    };

    // Compile the Sent-folder copy with Bcc preserved.
    let rawMessage: Buffer;
    try {
      rawMessage = await new Promise<Buffer>((resolve, reject) => {
        const composer = new MailComposer(mailOptions);
        const node = composer.compile() as any;
        node.keepBcc = true;
        node.build((err: Error | null, bytes: Buffer) => {
          if (err) reject(err);
          else resolve(bytes);
        });
      });
    } catch (e) {
      throw new Error(
        `Failed to compile MIME for Sent folder copy: ${e instanceof Error ? e.message : 'Unknown error'}`
      );
    }

    // SIZE-aware pre-send guard (#191). rawMessage is the exact encoded MIME,
    // so its byte length IS the true SMTP message size (base64 attachment
    // overhead already included) — compare against the smaller of the
    // configured cap and the server's advertised EHLO SIZE limit, and fail fast
    // with a clear message rather than attempting a doomed send (552 from the
    // server). When neither limit is known, behavior is unchanged.
    const { ceiling, serverLimit } = this.sendSizeCeiling(accountId);
    if (ceiling != null && rawMessage.length > ceiling) {
      const source = serverLimit != null && ceiling === serverLimit
        ? "the SMTP server's advertised SIZE limit"
        : 'the configured send cap (IMAP_MCP_MAX_SEND_SIZE_BYTES)';
      const msg = `Message is ${humanBytes(rawMessage.length)}, which exceeds ${source} of ${humanBytes(ceiling)}. Reduce attachment size or split the message.`;
      const c: ClassifiedError = { category: 'configuration', retryable: false, smtpCode: 552, smtpMessage: msg, providerGuidance: null, rawMessage: msg };
      m.sendFailureTotal += 1;
      m.lastError = { category: c.category, smtpCode: c.smtpCode, message: c.smtpMessage };
      const e = new Error(msg) as Error & { classified: ClassifiedError; retriesAttempted: number };
      e.classified = c;
      e.retriesAttempted = 0;
      throw e;
    }

    // Send with retry.
    const t0 = Date.now();
    let attempt = 0;
    let lastClassified: ClassifiedError | null = null;
    while (attempt < this.retryOptions.maxAttempts) {
      attempt++;
      try {
        const info = await transporter.sendMail(mailOptions);
        const duration = Date.now() - t0;
        m.sendSuccessTotal += 1;
        m.totalDurationMs += duration;
        m.lastSendDurationMs = duration;
        m.lastSendAt = new Date().toISOString();
        return {
          messageId: info.messageId,
          rawMessage,
          sentAt: new Date(),
          retriesAttempted: attempt - 1,
        };
      } catch (err) {
        const c = classifySmtpError(err, smtpHost);
        lastClassified = c;
        if (!c.retryable || attempt >= this.retryOptions.maxAttempts) {
          break;
        }
        m.retryTotal += 1;
        m.retryByCategory[c.category] += 1;
        const wait = backoffMs(attempt, this.retryOptions.baseDelayMs, this.retryOptions.maxDelayMs);
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    // Exhausted or non-retryable.
    const c = lastClassified!;
    m.sendFailureTotal += 1;
    m.lastError = { category: c.category, smtpCode: c.smtpCode, message: c.smtpMessage };
    const e = new Error(c.smtpMessage || 'SMTP send failed') as Error & { classified: ClassifiedError; retriesAttempted: number };
    e.classified = c;
    e.retriesAttempted = attempt - 1;
    throw e;
  }

  async verifySmtpConnection(account: ImapAccount): Promise<boolean> {
    try {
      const transporter = await this.createTransporter(account);
      await transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  // ---------- diagnostic: imap_test_smtp ----------

  /**
   * Probe SMTP connectivity without sending. Captures TLS info, EHLO
   * capabilities, RTT. Optionally attempts AUTH and reports pass/fail.
   */
  async testSmtp(
    account: ImapAccount,
    opts: { verbose?: boolean; testAuth?: boolean } = {}
  ): Promise<TestSmtpResult> {
    const cfg = account.smtp || this.getDefaultSmtpConfig(account);
    const transcript: string[] = [];
    const t0 = Date.now();

    const conn: any = new (SMTPConnection as any)({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      tls: cfg.tls,
      logger: opts.verbose ? {
        level: 'debug',
        debug: (..._a: unknown[]) => {},
        info: (..._a: unknown[]) => {},
        warn: (..._a: unknown[]) => {},
        error: (..._a: unknown[]) => {},
      } : false,
      debug: opts.verbose ?? false,
    });

    // Capture transcript via internal `_socket` events when verbose
    if (opts.verbose && conn.on) {
      conn.on('debug', (line: string) => transcript.push(String(line)));
    }

    const out: TestSmtpResult = {
      success: false,
      smtpHost: cfg.host,
      smtpPort: cfg.port,
      secure: !!cfg.secure,
      tlsVersion: null,
      tlsCipher: null,
      certificateValid: null,
      certificateExpiresAt: null,
      serverGreeting: null,
      authMethods: [],
      capabilities: [],
      sizeLimit: null,
      rttMs: null,
      authResult: 'skipped',
      authError: null,
      providerGuidance: providerGuidanceFor(cfg.host),
    };

    try {
      await new Promise<void>((resolve, reject) => {
        conn.connect((err?: Error) => {
          if (err) reject(err); else resolve();
        });
      });
      out.rttMs = Date.now() - t0;
      // SMTPConnection internals: greeting lives in lastServerResponse after
      // connect+EHLO; the supported extensions and auth methods are in
      // _supportedExtensions and _supportedAuth respectively (versioned at
      // nodemailer 7.x — recheck on upgrade).
      const greeting = conn.lastServerResponse ?? conn._remainder ?? '';
      out.serverGreeting = String(greeting).trim() || null;
      const exts = conn._supportedExtensions ?? conn.supportedExtensions ?? [];
      out.capabilities = Array.isArray(exts) ? exts.map(String) : [];
      const supportedAuth = conn._supportedAuth ?? conn.supportedAuth ?? [];
      out.authMethods = Array.isArray(supportedAuth) ? supportedAuth.map(String) : [];

      // EHLO SIZE limit (RFC 1870). nodemailer stores the numeric maximum in
      // _maxAllowedSize after EHLO; fall back to parsing a "SIZE <n>" capability
      // string in case a future version surfaces it there instead.
      let sizeLimit: number | null = null;
      const maxAllowed = Number(conn._maxAllowedSize ?? conn.maxAllowedSize);
      if (Number.isFinite(maxAllowed) && maxAllowed > 0) sizeLimit = maxAllowed;
      if (sizeLimit == null) {
        for (const cap of out.capabilities) {
          const mch = /^SIZE\s+(\d+)/i.exec(cap);
          if (mch) { sizeLimit = Number(mch[1]); break; }
        }
      }
      out.sizeLimit = sizeLimit;
      if (sizeLimit != null) this.setServerSizeLimit(account.id, sizeLimit);

      // Pull TLS info from the socket if available
      const sock: any = (conn._socket ?? conn.socket ?? null);
      if (sock?.getProtocol) {
        try { out.tlsVersion = sock.getProtocol(); } catch {}
      }
      if (sock?.getCipher) {
        try { out.tlsCipher = sock.getCipher()?.name ?? null; } catch {}
      }
      if (sock?.getPeerCertificate) {
        try {
          const cert = sock.getPeerCertificate();
          if (cert && cert.valid_to) {
            out.certificateExpiresAt = new Date(cert.valid_to).toISOString();
            out.certificateValid = sock.authorized === true;
          }
        } catch {}
      }

      if (opts.testAuth !== false) {
        try {
          await new Promise<void>((resolve, reject) => {
            conn.login(
              { user: cfg.user || account.user, pass: cfg.password || account.password },
              (err?: Error) => err ? reject(err) : resolve()
            );
          });
          out.authResult = 'ok';
        } catch (e: any) {
          out.authResult = 'failed';
          out.authError = String(e?.message ?? e);
        }
      }
      out.success = true;
    } catch (e: any) {
      out.error = String(e?.message ?? e);
    } finally {
      try { conn.quit(); } catch {}
      try { conn.close(); } catch {}
    }

    if (opts.verbose) out.transcript = transcript;
    return out;
  }

  // ---------- shutdown ----------

  disconnect(accountId: string): void {
    const transporter = this.transporters.get(accountId);
    if (!transporter) return;
    transporter.close();
    this.transporters.delete(accountId);
  }

  disconnectAll(): void {
    for (const transporter of this.transporters.values()) {
      try { transporter.close(); } catch {}
    }
    this.transporters.clear();
  }
}
