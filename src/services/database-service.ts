/**
 * Database Service for IMAP MCP Pro
 *
 * Provides SQLite3 database operations with encryption at rest for sensitive data.
 * Supports MSP multi-tenant architecture with user-scoped data access.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Version: 1.0.0
 * Date: 2025-11-05
 */

import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  User,
  Account,
  DecryptedAccount,
  UserAccount,
  Contact,
  Rule,
  Category,
  SpamDomain,
  SpamCache,
  UnsubscribeLink,
  SubscriptionSummary,
  AuditLog,
  DatabaseConfig,
  EncryptedData
} from '../types/database-types.js';
import { MigrationService } from './migration-service.js';

export class DatabaseService {
  private db: DatabaseSync;
  private encryptionKey: Buffer;
  private algorithm = 'aes-256-gcm';

  constructor(config?: Partial<DatabaseConfig>) {
    const dbPath = config?.dbPath || path.join(os.homedir(), '.imap-mcp', 'data.db');
    const dbDir = path.dirname(dbPath);

    // Create directory if it doesn't exist (owner-only).
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    }

    // node:sqlite — same SQLite file format as better-sqlite3, so the
    // existing DB at dbPath opens transparently. Native module ships with
    // Node and inherits the host process's code signature, so it loads
    // inside macOS-hardened apps like Claude Desktop where third-party
    // .node binaries get rejected by library-validation.
    this.db = new DatabaseSync(dbPath);

    // SECURITY (#235): the data directory and DB file hold plaintext metadata
    // (cached subjects/senders) and the encryption key — all owner-only data at
    // rest. The DB file is created at the process umask (often 0644), so tighten
    // it (and the dir + any journal/WAL sidecars) here, with repair-on-startup
    // for files that predate this fix. Mirrors the key-file handling below.
    this.secureStorage(dbPath, dbDir);

    // Set up encryption key
    this.encryptionKey = this.getOrCreateEncryptionKey(dbDir);

    // Initialize schema
    this.initializeSchema();

    console.error('[DatabaseService] Initialized at:', dbPath);
  }

  /**
   * SECURITY (#235): enforce owner-only permissions on the data directory
   * (0700) and the SQLite database file plus any journal/WAL sidecars (0600).
   * Repairs looser permissions on existing files, logging the change — the same
   * pattern getOrCreateEncryptionKey uses for the key file.
   */
  private secureStorage(dbPath: string, dbDir: string): void {
    this.enforceMode(dbDir, 0o700, 'data directory');
    this.enforceMode(dbPath, 0o600, 'database file');
    for (const suffix of ['-journal', '-wal', '-shm']) {
      this.enforceMode(dbPath + suffix, 0o600, `database sidecar (${suffix})`);
    }
  }

  /** chmod `target` to `expected` if it exists and differs. Best-effort; logs. */
  private enforceMode(target: string, expected: number, label: string): void {
    try {
      if (!fs.existsSync(target)) return;
      const mode = fs.statSync(target).mode & 0o777;
      if (mode !== expected) {
        fs.chmodSync(target, expected);
        console.error(
          `[SECURITY] Tightened ${label} permissions ${mode.toString(8)} -> ${expected.toString(8)}: ${target}`
        );
      }
    } catch (err) {
      console.error(`[SECURITY WARNING] Could not set ${label} permissions on ${target}:`, err);
    }
  }

  /**
   * Get or create encryption key for AES-256-GCM
   * SECURITY: Issue #25 - Validates and enforces 0o600 permissions
   */
  private getOrCreateEncryptionKey(dbDir: string): Buffer {
    const keyPath = path.join(dbDir, '.encryption-key');

    if (fs.existsSync(keyPath)) {
      // SECURITY: Check existing key file permissions
      const stats = fs.statSync(keyPath);
      const mode = stats.mode & parseInt('777', 8);
      const expectedMode = parseInt('600', 8);

      if (mode !== expectedMode) {
        console.error(`[SECURITY WARNING] Encryption key has insecure permissions: ${mode.toString(8)}`);
        console.error(`[SECURITY WARNING] Run: chmod 600 ${keyPath}`);
        console.error('[SECURITY WARNING] Key file should only be readable by owner');

        // Attempt to fix permissions automatically
        try {
          fs.chmodSync(keyPath, 0o600);
          console.error('[SECURITY] Fixed encryption key permissions to 600');
        } catch (err) {
          console.error('[SECURITY ERROR] Failed to fix permissions:', err);
        }
      }

      // Read existing key
      const keyHex = fs.readFileSync(keyPath, 'utf-8').trim();
      return Buffer.from(keyHex, 'hex');
    }

    // Generate new 256-bit key with secure permissions
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
    console.error('[DatabaseService] Generated new encryption key with mode 600');
    return key;
  }

  /**
   * Public access to underlying Database (used by adjacent services that
   * need to share the connection — e.g. ResultsService).
   */
  getDb(): DatabaseSync {
    return this.db;
  }

  /**
   * Public encryption helpers that reuse the AES-256-GCM key.
   * Used by ResultsService and FileExportService.
   */
  encryptString(plaintext: string): EncryptedData {
    return this.encrypt(plaintext);
  }

  decryptString(encrypted: string, ivHex: string): string {
    return this.decrypt(encrypted, ivHex);
  }

  encryptBuffer(plaintext: Buffer): { ciphertext: Buffer; iv: string; authTag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = (cipher as any).getAuthTag() as Buffer;
    return { ciphertext: enc, iv: iv.toString('hex'), authTag: authTag.toString('hex') };
  }

  decryptBuffer(ciphertext: Buffer, ivHex: string, authTagHex: string): Buffer {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
    (decipher as any).setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Encrypt sensitive data using AES-256-GCM
   */
  private encrypt(plaintext: string): EncryptedData {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = (cipher as any).getAuthTag();

    return {
      encrypted: encrypted + authTag.toString('hex'),
      iv: iv.toString('hex')
    };
  }

  /**
   * Decrypt sensitive data using AES-256-GCM
   */
  private decrypt(encrypted: string, ivHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');

    // Extract auth tag (last 16 bytes = 32 hex chars)
    const authTag = Buffer.from(encrypted.slice(-32), 'hex');
    const ciphertext = encrypted.slice(0, -32);

    const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
    (decipher as any).setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    const schemaDir = path.join(__dirname, '../database');
    const schemaPath = path.join(schemaDir, 'schema.sql');

    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema file not found: ${schemaPath}`);
    }

    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // schema.sql uses CREATE TABLE IF NOT EXISTS throughout, so it's safe to
    // run on both new and existing databases.
    try {
      this.db.exec(schema);
      console.error('[DatabaseService] Base schema applied');
    } catch (error) {
      console.error('[DatabaseService] FATAL: Schema initialization failed:', error);
      throw error;
    }

    // Additive column migrations — safe to run on both new and existing databases.
    // SQLite does not support IF NOT EXISTS on ALTER TABLE, so we catch the
    // "duplicate column name" error and continue.
    const columnMigrations = [
      'ALTER TABLE accounts ADD COLUMN capabilities TEXT',
      'ALTER TABLE accounts ADD COLUMN capabilities_updated_at INTEGER',
    ];
    for (const sql of columnMigrations) {
      try {
        this.db.exec(sql);
      } catch (e: any) {
        if (!e?.message?.includes('duplicate column name')) {
          console.error('[DatabaseService] Migration warning:', e?.message);
        }
      }
    }

    // Issue #36/#37: run versioned schema_update_*.sql migrations that haven't
    // been recorded in schema_version yet. Each migration is one transaction.
    // Disabled by IMAP_MCP_SKIP_MIGRATIONS=1 for debug scenarios.
    if (process.env.IMAP_MCP_SKIP_MIGRATIONS !== '1') {
      const migrator = new MigrationService(this.db, schemaDir);
      const result = migrator.migrate({
        onStep: (s) => console.error(`[DatabaseService] Applying migration ${s.fromVersion} -> ${s.toVersion} (${s.fileName})`),
      });
      if (result.failed) {
        console.error(
          `[DatabaseService] FATAL: migration ${result.failed.file} failed: ${result.failed.error}`
        );
        throw new Error(`Migration ${result.failed.file} failed: ${result.failed.error}`);
      }
      if (result.applied.length) {
        console.error(`[DatabaseService] Applied ${result.applied.length} migration(s)`);
      }
    }

    // Reconcile FTS5 availability. node:sqlite on some platforms (e.g. certain
    // Windows Node builds) is compiled without FTS5. The messages_cache
    // AI/AU/AD triggers reference the fts5 virtual table, so on such builds ANY
    // cache write — and the account-delete cascade into messages_cache — throws
    // "no such module: fts5" (#286). This drops those triggers when FTS5 is
    // absent so the rest works; full-text search is then guarded off.
    this.reconcileFts5();
  }

  /** Whether this SQLite build has the FTS5 module. Set at init. */
  private ftsAvailable = true;

  /** True if full-text cache search (messages_cache_fts) is usable here. */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  /**
   * Detect FTS5 support and, if absent, drop the messages_cache FTS sync
   * triggers so cache writes / account deletes don't hit "no such module: fts5".
   * Dropping a trigger doesn't load the module, so it's safe on FTS5-less
   * builds. The inert virtual table can't be dropped without the module and is
   * simply never queried (searchFullText guards on isFtsAvailable()).
   */
  private reconcileFts5(): void {
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __fts5_probe__ USING fts5(x)');
      try { this.db.exec('DROP TABLE IF EXISTS __fts5_probe__'); } catch { /* ignore */ }
      this.ftsAvailable = true;
      return;
    } catch {
      this.ftsAvailable = false;
    }

    for (const trg of ['messages_cache_fts_ai', 'messages_cache_fts_au', 'messages_cache_fts_ad']) {
      try {
        this.db.exec(`DROP TRIGGER IF EXISTS ${trg}`);
      } catch (e: any) {
        console.error(`[DatabaseService] FTS trigger cleanup warning (${trg}):`, e?.message);
      }
    }
    console.error(
      '[DatabaseService] FTS5 not available in this SQLite build — full-text cache search disabled; ' +
      'dropped messages_cache FTS triggers so sync and account deletion work without it.',
    );
  }

  /**
   * Return migration status without applying anything. Used by the CLI.
   */
  getMigrationService(): MigrationService {
    return new MigrationService(this.db, path.join(__dirname, '../database'));
  }

  // ===================
  // User Management
  // ===================

  createUser(user: Omit<User, 'created_at' | 'updated_at'>): User {
    const stmt = this.db.prepare(`
      INSERT INTO users (user_id, username, email, organization, is_active, metadata)
      VALUES ($user_id, $username, $email, $organization, $is_active, $metadata)
    `);

    stmt.run({
      user_id: user.user_id,
      username: user.username,
      email: user.email || null,
      organization: user.organization || null,
      is_active: user.is_active ? 1 : 0,
      metadata: user.metadata || null
    });

    return this.getUser(user.user_id)!;
  }

  getUser(userId: string): User | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE user_id = ?');
    const user = stmt.get(userId) as User | undefined;
    return user || null;
  }

  getUserByUsername(username: string): User | null {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    const user = stmt.get(username) as User | undefined;
    return user || null;
  }

  listUsers(): User[] {
    const stmt = this.db.prepare('SELECT * FROM users WHERE is_active = 1 ORDER BY username');
    return stmt.all() as unknown as User[];
  }

  /**
   * Resolve a caller-supplied user identifier to the canonical `users.user_id`
   * (UUID). Accepts either form:
   *
   *   - canonical user_id UUID  → returned as-is if it exists
   *   - username (e.g. "colin") → looked up; returns the matched user_id
   *
   * Returns null if neither resolution succeeds — caller must surface a
   * clear "unknown user" error rather than letting an FK constraint fail
   * deep in an unrelated insert path (issue #130).
   */
  resolveUserId(input: string): string | null {
    if (!input) return null;
    const byId = this.getUser(input);
    if (byId) return byId.user_id;
    const byName = this.getUserByUsername(input);
    return byName ? byName.user_id : null;
  }

  updateUser(userId: string, updates: Partial<User>): void {
    const fields: string[] = [];
    const values: any = { user_id: userId };

    if (updates.username !== undefined) {
      fields.push('username = $username');
      values.username = updates.username;
    }
    if (updates.email !== undefined) {
      fields.push('email = $email');
      values.email = updates.email;
    }
    if (updates.organization !== undefined) {
      fields.push('organization = $organization');
      values.organization = updates.organization;
    }
    if (updates.is_active !== undefined) {
      fields.push('is_active = $is_active');
      values.is_active = updates.is_active ? 1 : 0;
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = $metadata');
      values.metadata = updates.metadata;
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    const stmt = this.db.prepare(`
      UPDATE users SET ${fields.join(', ')} WHERE user_id = $user_id
    `);

    stmt.run(values);
  }

  deleteUser(userId: string): void {
    const stmt = this.db.prepare('DELETE FROM users WHERE user_id = ?');
    stmt.run(userId);
  }

  // ===================
  // Account Management
  // ===================

  /**
   * Find an existing account with the same IMAP identity (same user, host and
   * username, compared case-insensitively) — used to prevent duplicates.
   */
  findAccountByImapIdentity(userId: string, host: string, username: string): Account | null {
    const stmt = this.db.prepare(
      `SELECT * FROM accounts
       WHERE user_id = ? AND LOWER(host) = LOWER(?) AND LOWER(username) = LOWER(?)
       LIMIT 1`,
    );
    return (stmt.get(userId, host, username) as Account | undefined) ?? null;
  }

  createAccount(account: Omit<DecryptedAccount, 'account_id' | 'created_at' | 'updated_at' | 'last_connected'>): Account {
    // Reject duplicates up front — the accounts table has no unique constraint
    // on the IMAP identity, so without this a second add silently creates a
    // second account for the same mailbox.
    const existing = this.findAccountByImapIdentity(account.user_id, account.host, account.username);
    if (existing) {
      throw new Error(
        `An account for ${account.username}@${account.host} already exists (account_id: ${existing.account_id}). ` +
        `Remove it first with imap_remove_account, or use the existing account.`,
      );
    }

    const accountId = crypto.randomUUID();

    // Encrypt password
    const passwordData = this.encrypt(account.password);

    // Encrypt SMTP password if provided
    let smtpPasswordData: EncryptedData | null = null;
    if (account.smtp_password) {
      smtpPasswordData = this.encrypt(account.smtp_password);
    }

    const stmt = this.db.prepare(`
      INSERT INTO accounts (
        account_id, user_id, name, host, port, username,
        password_encrypted, encryption_iv, tls,
        smtp_host, smtp_port, smtp_secure, smtp_username,
        smtp_password_encrypted, smtp_encryption_iv, is_active
      ) VALUES (
        $account_id, $user_id, $name, $host, $port, $username,
        $password_encrypted, $encryption_iv, $tls,
        $smtp_host, $smtp_port, $smtp_secure, $smtp_username,
        $smtp_password_encrypted, $smtp_encryption_iv, $is_active
      )
    `);

    stmt.run({
      account_id: accountId,
      user_id: account.user_id,
      name: account.name,
      host: account.host,
      port: account.port,
      username: account.username,
      password_encrypted: passwordData.encrypted,
      encryption_iv: passwordData.iv,
      tls: account.tls ? 1 : 0,
      smtp_host: account.smtp_host || null,
      smtp_port: account.smtp_port || null,
      smtp_secure: account.smtp_secure ? 1 : 0,
      smtp_username: account.smtp_username || null,
      smtp_password_encrypted: smtpPasswordData?.encrypted || null,
      smtp_encryption_iv: smtpPasswordData?.iv || null,
      is_active: 1
    });

    // Create owner relationship
    this.linkUserToAccount(account.user_id, accountId, 'owner');

    return this.getAccount(accountId)!;
  }

  getAccount(accountId: string): Account | null {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE account_id = ?');
    const account = stmt.get(accountId) as Account | undefined;
    return account || null;
  }

  getDecryptedAccount(accountId: string): DecryptedAccount | null {
    const account = this.getAccount(accountId);
    if (!account) return null;

    // Decrypt password
    const password = this.decrypt(account.password_encrypted, account.encryption_iv);

    // Decrypt SMTP password if present
    let smtpPassword: string | undefined;
    if (account.smtp_password_encrypted && account.smtp_encryption_iv) {
      smtpPassword = this.decrypt(account.smtp_password_encrypted, account.smtp_encryption_iv);
    }

    return {
      account_id: account.account_id,
      user_id: account.user_id,
      name: account.name,
      host: account.host,
      port: account.port,
      username: account.username,
      password,
      tls: account.tls,
      smtp_host: account.smtp_host,
      smtp_port: account.smtp_port,
      smtp_secure: account.smtp_secure,
      smtp_username: account.smtp_username,
      smtp_password: smtpPassword,
      created_at: account.created_at,
      updated_at: account.updated_at,
      last_connected: account.last_connected,
      is_active: account.is_active,
      signature_text: (account as any).signature_text ?? null,
      signature_html: (account as any).signature_html ?? null
    };
  }

  /** Set (or clear, with null) an account's plain-text and/or HTML signature (#signatures). */
  setAccountSignature(accountId: string, sig: { text?: string | null; html?: string | null }): void {
    const fields: string[] = [];
    const values: any = { $id: accountId };
    if (sig.text !== undefined) { fields.push('signature_text = $text'); values.$text = sig.text; }
    if (sig.html !== undefined) { fields.push('signature_html = $html'); values.$html = sig.html; }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE accounts SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE account_id = $id`).run(values);
  }

  /** Get an account's signature (text + html), or null if the account is gone. */
  getAccountSignature(accountId: string): { text: string | null; html: string | null } | null {
    const row = this.db.prepare('SELECT signature_text, signature_html FROM accounts WHERE account_id = ?').get(accountId) as any;
    return row ? { text: row.signature_text ?? null, html: row.signature_html ?? null } : null;
  }

  listAccountsForUser(userId: string): Account[] {
    const stmt = this.db.prepare(`
      SELECT a.* FROM accounts a
      INNER JOIN user_accounts ua ON a.account_id = ua.account_id
      WHERE ua.user_id = ? AND a.is_active = 1
      ORDER BY a.name
    `);

    return stmt.all(userId) as unknown as Account[];
  }

  listDecryptedAccountsForUser(userId: string): DecryptedAccount[] {
    const accounts = this.listAccountsForUser(userId);
    return accounts.map(account => this.getDecryptedAccount(account.account_id)!).filter(Boolean);
  }

  updateAccount(accountId: string, updates: Partial<DecryptedAccount>): void {
    const fields: string[] = [];
    const values: any = { account_id: accountId };

    if (updates.name !== undefined) {
      fields.push('name = $name');
      values.name = updates.name;
    }
    if (updates.host !== undefined) {
      fields.push('host = $host');
      values.host = updates.host;
    }
    if (updates.port !== undefined) {
      fields.push('port = $port');
      values.port = updates.port;
    }
    if (updates.username !== undefined) {
      fields.push('username = $username');
      values.username = updates.username;
    }
    if (updates.password !== undefined) {
      const passwordData = this.encrypt(updates.password);
      fields.push('password_encrypted = $password_encrypted');
      fields.push('encryption_iv = $encryption_iv');
      values.password_encrypted = passwordData.encrypted;
      values.encryption_iv = passwordData.iv;
    }
    if (updates.tls !== undefined) {
      fields.push('tls = $tls');
      values.tls = updates.tls ? 1 : 0;
    }
    if (updates.smtp_host !== undefined) {
      fields.push('smtp_host = $smtp_host');
      values.smtp_host = updates.smtp_host;
    }
    if (updates.smtp_port !== undefined) {
      fields.push('smtp_port = $smtp_port');
      values.smtp_port = updates.smtp_port;
    }
    if (updates.smtp_username !== undefined) {
      fields.push('smtp_username = $smtp_username');
      values.smtp_username = updates.smtp_username;
    }
    if (updates.smtp_secure !== undefined) {
      fields.push('smtp_secure = $smtp_secure');
      values.smtp_secure = updates.smtp_secure ? 1 : 0;
    }
    if (updates.smtp_password !== undefined) {
      if (updates.smtp_password === null) {
        // Clear SMTP password
        fields.push('smtp_password_encrypted = NULL');
        fields.push('smtp_encryption_iv = NULL');
      } else {
        // Update SMTP password
        const smtpPasswordData = this.encrypt(updates.smtp_password);
        fields.push('smtp_password_encrypted = $smtp_password_encrypted');
        fields.push('smtp_encryption_iv = $smtp_encryption_iv');
        values.smtp_password_encrypted = smtpPasswordData.encrypted;
        values.smtp_encryption_iv = smtpPasswordData.iv;
      }
    }
    if (updates.is_active !== undefined) {
      fields.push('is_active = $is_active');
      values.is_active = updates.is_active ? 1 : 0;
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    const stmt = this.db.prepare(`
      UPDATE accounts SET ${fields.join(', ')} WHERE account_id = $account_id
    `);

    stmt.run(values);
  }

  updateLastConnected(accountId: string): void {
    const stmt = this.db.prepare('UPDATE accounts SET last_connected = CURRENT_TIMESTAMP WHERE account_id = ?');
    stmt.run(accountId);
  }

  /**
   * RFC 9051: Update account capabilities (Issue #58)
   * Store JSON-serialized ServerCapabilities for runtime feature detection
   */
  updateAccountCapabilities(accountId: string, capabilities: any): void {
    const stmt = this.db.prepare(`
      UPDATE accounts
      SET capabilities = ?, capabilities_updated_at = ?
      WHERE account_id = ?
    `);

    stmt.run(JSON.stringify(capabilities), Date.now(), accountId);
  }

  /**
   * RFC 9051: Get account capabilities (Issue #58)
   * Returns parsed ServerCapabilities or null if not yet queried
   */
  getAccountCapabilities(accountId: string): any | null {
    const stmt = this.db.prepare('SELECT capabilities FROM accounts WHERE account_id = ?');
    const result = stmt.get(accountId) as { capabilities: string | null } | undefined;

    if (!result || !result.capabilities) {
      return null;
    }

    try {
      return JSON.parse(result.capabilities);
    } catch (error) {
      console.error('[DatabaseService] Failed to parse capabilities JSON:', error);
      return null;
    }
  }

  deleteAccount(accountId: string): void {
    const stmt = this.db.prepare('DELETE FROM accounts WHERE account_id = ?');
    stmt.run(accountId);
  }

  // ===================
  // User-Account Links
  // ===================

  linkUserToAccount(userId: string, accountId: string, role: 'owner' | 'admin' | 'user' | 'readonly' = 'user'): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_accounts (user_id, account_id, role)
      VALUES (?, ?, ?)
    `);

    stmt.run(userId, accountId, role);
  }

  unlinkUserFromAccount(userId: string, accountId: string): void {
    const stmt = this.db.prepare('DELETE FROM user_accounts WHERE user_id = ? AND account_id = ?');
    stmt.run(userId, accountId);
  }

  getUserAccountRole(userId: string, accountId: string): string | null {
    const stmt = this.db.prepare('SELECT role FROM user_accounts WHERE user_id = ? AND account_id = ?');
    const result = stmt.get(userId, accountId) as { role: string } | undefined;
    return result?.role || null;
  }

  // ===================
  // Unsubscribe Links Management (Issue #45 Phase 4)
  // ===================

  insertUnsubscribeLink(data: Omit<UnsubscribeLink, 'id' | 'extracted_at'>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO unsubscribe_links
      (user_id, account_id, folder, uid, sender_email, subject, unsubscribe_link, list_unsubscribe_header, message_date)
      VALUES ($user_id, $account_id, $folder, $uid, $sender_email, $subject, $unsubscribe_link, $list_unsubscribe_header, $message_date)
    `);

    stmt.run({
      user_id: data.user_id,
      account_id: data.account_id,
      folder: data.folder,
      uid: data.uid,
      sender_email: data.sender_email,
      subject: data.subject || null,
      unsubscribe_link: data.unsubscribe_link || null,
      list_unsubscribe_header: data.list_unsubscribe_header || null,
      message_date: data.message_date || null,
    });
  }

  getUnsubscribeLinks(userId: string, filters?: { account_id?: string; sender_email?: string }): UnsubscribeLink[] {
    let query = 'SELECT * FROM unsubscribe_links WHERE user_id = ?';
    const params: any[] = [userId];

    if (filters?.account_id) {
      query += ' AND account_id = ?';
      params.push(filters.account_id);
    }

    if (filters?.sender_email) {
      query += ' AND sender_email = ?';
      params.push(filters.sender_email);
    }

    query += ' ORDER BY extracted_at DESC';

    const stmt = this.db.prepare(query);
    return stmt.all(...params) as unknown as UnsubscribeLink[];
  }

  // ===================
  // Subscription Summary Management (Issue #45 Phase 4)
  // ===================

  upsertSubscriptionSummary(data: {
    user_id: string;
    sender_email: string;
    sender_domain: string;
    sender_name?: string;
    unsubscribe_link?: string;
    unsubscribe_method?: 'http' | 'mailto' | 'both';
    category: 'marketing' | 'newsletter' | 'promotional' | 'transactional' | 'other';
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO subscription_summary
      (user_id, sender_email, sender_domain, sender_name, unsubscribe_link, unsubscribe_method, category, total_emails, first_seen, last_seen)
      VALUES ($user_id, $sender_email, $sender_domain, $sender_name, $unsubscribe_link, $unsubscribe_method, $category, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, sender_email) DO UPDATE SET
        total_emails = total_emails + 1,
        last_seen = CURRENT_TIMESTAMP,
        sender_name = COALESCE($sender_name, sender_name),
        unsubscribe_link = COALESCE($unsubscribe_link, unsubscribe_link),
        unsubscribe_method = COALESCE($unsubscribe_method, unsubscribe_method),
        category = $category
    `);

    stmt.run({
      user_id: data.user_id,
      sender_email: data.sender_email,
      sender_domain: data.sender_domain,
      sender_name: data.sender_name || null,
      unsubscribe_link: data.unsubscribe_link || null,
      unsubscribe_method: data.unsubscribe_method || null,
      category: data.category,
    });
  }

  getSubscriptionSummary(
    userId: string,
    filters?: { category?: string; unsubscribed?: boolean }
  ): SubscriptionSummary[] {
    let query = 'SELECT * FROM subscription_summary WHERE user_id = ?';
    const params: any[] = [userId];

    if (filters?.category) {
      query += ' AND category = ?';
      params.push(filters.category);
    }

    if (filters?.unsubscribed !== undefined) {
      query += ' AND unsubscribed = ?';
      params.push(filters.unsubscribed ? 1 : 0);
    }

    query += ' ORDER BY last_seen DESC';

    const stmt = this.db.prepare(query);
    const results = stmt.all(...params) as any[];

    return results.map(row => ({
      ...row,
      unsubscribed: Boolean(row.unsubscribed),
    }));
  }

  markSubscriptionAsUnsubscribed(userId: string, senderEmail: string): void {
    const stmt = this.db.prepare(`
      UPDATE subscription_summary
      SET unsubscribed = 1, unsubscribed_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND sender_email = ?
    `);

    stmt.run(userId, senderEmail);
  }

  updateSubscriptionCategory(
    userId: string,
    senderEmail: string,
    category: 'marketing' | 'newsletter' | 'promotional' | 'transactional' | 'other'
  ): void {
    const stmt = this.db.prepare(`
      UPDATE subscription_summary
      SET category = ?
      WHERE user_id = ? AND sender_email = ?
    `);

    stmt.run(category, userId, senderEmail);
  }

  updateSubscriptionNotes(userId: string, senderEmail: string, notes: string): void {
    const stmt = this.db.prepare(`
      UPDATE subscription_summary
      SET notes = ?
      WHERE user_id = ? AND sender_email = ?
    `);

    stmt.run(notes, userId, senderEmail);
  }

  /**
   * Update unsubscribe execution result (Issue #47)
   */
  updateSubscriptionUnsubscribeResult(
    userId: string,
    senderEmail: string,
    result: 'success' | 'failed' | 'error',
    errorDetails: string,
    markAsUnsubscribed: boolean
  ): void {
    const stmt = this.db.prepare(`
      UPDATE subscription_summary
      SET unsubscribe_attempted_at = CURRENT_TIMESTAMP,
          unsubscribe_result = ?,
          unsubscribe_error = ?,
          unsubscribed = ?,
          unsubscribed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE unsubscribed_at END
      WHERE user_id = ? AND sender_email = ?
    `);

    stmt.run(
      result,
      errorDetails,
      markAsUnsubscribed ? 1 : 0,
      markAsUnsubscribed ? 1 : 0,
      userId,
      senderEmail
    );
  }

  // ===================
  // DNS Firewall Providers (Issue #60)
  // ===================

  /**
   * Get all DNS firewall providers
   */
  getDnsFirewallProviders(): any[] {
    const stmt = this.db.prepare('SELECT * FROM dns_firewall_providers ORDER BY is_default DESC, provider_name ASC');
    return stmt.all();
  }

  /**
   * Get enabled DNS firewall providers
   */
  getEnabledDnsFirewallProviders(): any[] {
    const stmt = this.db.prepare('SELECT * FROM dns_firewall_providers WHERE is_enabled = 1 ORDER BY is_default DESC, provider_name ASC');
    return stmt.all();
  }

  /**
   * Get default DNS firewall provider
   */
  getDefaultDnsFirewallProvider(): any | null {
    const stmt = this.db.prepare('SELECT * FROM dns_firewall_providers WHERE is_default = 1 LIMIT 1');
    return stmt.get() || null;
  }

  /**
   * Get DNS firewall provider by ID
   */
  getDnsFirewallProvider(providerId: string): any | null {
    const stmt = this.db.prepare('SELECT * FROM dns_firewall_providers WHERE provider_id = ?');
    return stmt.get(providerId) || null;
  }

  /**
   * Create or update DNS firewall provider
   */
  upsertDnsFirewallProvider(provider: {
    providerId: string;
    providerName: string;
    providerType: 'dns-over-https' | 'dns-lookup';
    apiEndpoint?: string;
    apiKey?: string;
    isEnabled?: boolean;
    isDefault?: boolean;
    timeoutMs?: number;
    metadata?: string;
  }): void {
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO dns_firewall_providers (
        provider_id, provider_name, provider_type, api_endpoint, api_key,
        is_enabled, is_default, timeout_ms, created_at, updated_at, metadata
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT created_at FROM dns_firewall_providers WHERE provider_id = ?), ?),
        ?, ?
      )
    `);

    stmt.run(
      provider.providerId,
      provider.providerName,
      provider.providerType,
      provider.apiEndpoint || null,
      provider.apiKey || null,
      provider.isEnabled !== undefined ? (provider.isEnabled ? 1 : 0) : 1,
      provider.isDefault !== undefined ? (provider.isDefault ? 1 : 0) : 0,
      provider.timeoutMs || 5000,
      provider.providerId, // For COALESCE check
      now, // created_at if new
      now, // updated_at
      provider.metadata || null
    );
  }

  /**
   * Update DNS firewall provider
   */
  updateDnsFirewallProvider(providerId: string, updates: {
    providerName?: string;
    apiEndpoint?: string;
    apiKey?: string;
    isEnabled?: boolean;
    isDefault?: boolean;
    timeoutMs?: number;
    metadata?: string;
  }): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.providerName !== undefined) {
      fields.push('provider_name = ?');
      values.push(updates.providerName);
    }
    if (updates.apiEndpoint !== undefined) {
      fields.push('api_endpoint = ?');
      values.push(updates.apiEndpoint);
    }
    if (updates.apiKey !== undefined) {
      fields.push('api_key = ?');
      values.push(updates.apiKey);
    }
    if (updates.isEnabled !== undefined) {
      fields.push('is_enabled = ?');
      values.push(updates.isEnabled ? 1 : 0);
    }
    if (updates.isDefault !== undefined) {
      fields.push('is_default = ?');
      values.push(updates.isDefault ? 1 : 0);
    }
    if (updates.timeoutMs !== undefined) {
      fields.push('timeout_ms = ?');
      values.push(updates.timeoutMs);
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      values.push(updates.metadata);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(providerId);

    const stmt = this.db.prepare(`UPDATE dns_firewall_providers SET ${fields.join(', ')} WHERE provider_id = ?`);
    stmt.run(...values);
  }

  /**
   * Delete DNS firewall provider
   */
  deleteDnsFirewallProvider(providerId: string): void {
    const stmt = this.db.prepare('DELETE FROM dns_firewall_providers WHERE provider_id = ?');
    stmt.run(providerId);
  }

  // ===================
  // Categories (Issue #61)
  // ===================

  /**
   * Get all categories for an account
   */
  getCategories(accountId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM categories WHERE account_id = ? ORDER BY category_name ASC');
    return stmt.all(accountId);
  }

  // ===================
  // Quick Categories Management (Issue #71)
  // ===================

  /**
   * Create a new Quick Category
   */
  createCategory(category: Omit<Category, 'category_id' | 'created_at' | 'updated_at' | 'match_count' | 'last_matched'>): Category {
    const stmt = this.db.prepare(`
      INSERT INTO categories (user_id, account_id, category_name, keywords, target_folder, enabled)
      VALUES ($user_id, $account_id, $category_name, $keywords, $target_folder, $enabled)
    `);

    const result = stmt.run({
      user_id: category.user_id,
      account_id: category.account_id,
      category_name: category.category_name,
      keywords: category.keywords,
      target_folder: category.target_folder,
      enabled: category.enabled ? 1 : 0
    });

    return this.getCategory(result.lastInsertRowid as number)!;
  }

  /**
   * Get category by ID
   */
  getCategory(categoryId: number): Category | null {
    const stmt = this.db.prepare('SELECT * FROM categories WHERE category_id = ?');
    const category = stmt.get(categoryId) as any;
    if (!category) return null;

    return {
      ...category,
      enabled: Boolean(category.enabled)
    };
  }

  /**
   * List all categories for a user
   */
  listCategoriesForUser(userId: string, accountId?: string): Category[] {
    let query = 'SELECT * FROM categories WHERE user_id = ?';
    const params: any[] = [userId];

    if (accountId) {
      query += ' AND account_id = ?';
      params.push(accountId);
    }

    query += ' ORDER BY category_name ASC';

    const stmt = this.db.prepare(query);
    const categories = stmt.all(...params) as any[];

    return categories.map(cat => ({
      ...cat,
      enabled: Boolean(cat.enabled)
    }));
  }

  /**
   * Update category
   */
  updateCategory(categoryId: number, updates: Partial<Omit<Category, 'category_id' | 'created_at' | 'user_id' | 'account_id'>>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.category_name !== undefined) {
      fields.push('category_name = ?');
      values.push(updates.category_name);
    }
    if (updates.keywords !== undefined) {
      fields.push('keywords = ?');
      values.push(updates.keywords);
    }
    if (updates.target_folder !== undefined) {
      fields.push('target_folder = ?');
      values.push(updates.target_folder);
    }
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.match_count !== undefined) {
      fields.push('match_count = ?');
      values.push(updates.match_count);
    }
    if (updates.last_matched !== undefined) {
      fields.push('last_matched = ?');
      values.push(updates.last_matched);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(categoryId);

    const stmt = this.db.prepare(`UPDATE categories SET ${fields.join(', ')} WHERE category_id = ?`);
    stmt.run(...values);
  }

  /**
   * Delete category
   */
  deleteCategory(categoryId: number): void {
    const stmt = this.db.prepare('DELETE FROM categories WHERE category_id = ?');
    stmt.run(categoryId);
  }

  /**
   * Increment match count for a category
   */
  incrementCategoryMatch(categoryId: number): void {
    const stmt = this.db.prepare(`
      UPDATE categories
      SET match_count = match_count + 1,
          last_matched = CURRENT_TIMESTAMP
      WHERE category_id = ?
    `);
    stmt.run(categoryId);
  }

  /**
   * Get enabled categories for an account (used by categorization engine)
   */
  getEnabledCategoriesForAccount(userId: string, accountId: string): Category[] {
    const stmt = this.db.prepare(`
      SELECT * FROM categories
      WHERE user_id = ? AND account_id = ? AND enabled = 1
      ORDER BY category_name ASC
    `);
    const categories = stmt.all(userId, accountId) as any[];

    return categories.map(cat => ({
      ...cat,
      enabled: Boolean(cat.enabled)
    }));
  }

  // ===========================
  // UserCheck Key Management (Issue #83)
  // ===========================

  /**
   * Create a new UserCheck API key
   */
  createUserCheckKey(data: {
    user_id: string;
    api_key: string;
    daily_limit?: number;
    notes?: string;
  }): { id: number } {
    const stmt = this.db.prepare(`
      INSERT INTO usercheck_keys (user_id, api_key, daily_limit, notes, is_active)
      VALUES (?, ?, ?, ?, 1)
    `);

    const result = stmt.run(
      data.user_id,
      data.api_key,
      data.daily_limit || 1000,
      data.notes || null
    );

    return { id: Number(result.lastInsertRowid) };
  }

  /**
   * Get active UserCheck API key for a user
   */
  getActiveUserCheckKey(userId: string): { id: number; api_key: string; daily_limit: number } | null {
    const stmt = this.db.prepare(`
      SELECT id, api_key, daily_limit
      FROM usercheck_keys
      WHERE user_id = ? AND is_active = 1
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const result = stmt.get(userId) as any;
    if (!result) return null;

    return {
      id: result.id,
      api_key: result.api_key,
      daily_limit: result.daily_limit
    };
  }

  /**
   * List all UserCheck API keys for a user
   */
  listUserCheckKeys(userId: string): any[] {
    const stmt = this.db.prepare(`
      SELECT id, api_key, is_active, daily_limit, daily_usage,
             usage_reset_at, last_used, created_at, notes
      FROM usercheck_keys
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);

    return stmt.all(userId) as any[];
  }

  /**
   * Delete a UserCheck API key
   */
  deleteUserCheckKey(keyId: number): void {
    const stmt = this.db.prepare('DELETE FROM usercheck_keys WHERE id = ?');
    stmt.run(keyId);
  }

  /**
   * Update UserCheck key usage statistics
   */
  updateUserCheckKeyUsage(userId: string, apiKey: string): void {
    const now = new Date().toISOString();

    // Get current usage and reset time
    const stmt = this.db.prepare(`
      SELECT daily_usage, usage_reset_at FROM usercheck_keys
      WHERE user_id = ? AND api_key = ?
    `);

    const keyData = stmt.get(userId, apiKey) as { daily_usage: number; usage_reset_at: string } | undefined;

    if (!keyData) return;

    const resetDate = new Date(keyData.usage_reset_at);
    const currentDate = new Date();

    // Reset usage if 24 hours have passed
    if (currentDate.getTime() - resetDate.getTime() > 24 * 60 * 60 * 1000) {
      const updateStmt = this.db.prepare(`
        UPDATE usercheck_keys
        SET daily_usage = 1, usage_reset_at = ?, last_used = ?
        WHERE user_id = ? AND api_key = ?
      `);
      updateStmt.run(now, now, userId, apiKey);
    } else {
      // Increment usage
      const updateStmt = this.db.prepare(`
        UPDATE usercheck_keys
        SET daily_usage = daily_usage + 1, last_used = ?
        WHERE user_id = ? AND api_key = ?
      `);
      updateStmt.run(now, userId, apiKey);
    }
  }

  // ===================
  // Close Database
  // ===================

  close(): void {
    this.db.close();
    console.error('[DatabaseService] Database closed');
  }
}
