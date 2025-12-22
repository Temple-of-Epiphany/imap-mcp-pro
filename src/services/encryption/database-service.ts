/**
 * Encrypted Database Service
 *
 * Manages SQLCipher-encrypted database with automatic key management.
 * Supports both OS Keychain (Claude Desktop) and encrypted file storage (Standard mode).
 *
 * Author: Colin Bitterfield
 * Email: colin@bitterfield.com
 * Date Created: 2025-12-05
 * Date Updated: 2025-12-05
 * Version: 1.0.0
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { KeyStorage, createKeyStorage } from './key-storage.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const SQLite = require('@journeyapps/sqlcipher');

// Type definitions for better-sqlite3 compatible API
type Database = any;
type Statement = any;
type RunResult = { lastID: number | bigint; changes: number };

/**
 * Encrypted Database Service
 * Manages SQLCipher database with automatic key management
 */
export class EncryptedDatabaseService {
  private db: Database | null = null;
  private keyStorage: KeyStorage;
  private userId: string;
  private dbPath: string;
  private encryptionKey: Buffer | null = null;

  constructor(userId: string, dbPath?: string) {
    this.userId = userId;
    this.dbPath = dbPath || path.join(
      os.homedir(),
      '.local/share/imap-mcp',
      `${userId}.db`
    );

    // Auto-select key storage based on environment
    this.keyStorage = createKeyStorage();
  }

  /**
   * Initialize and unlock the database
   */
  async initialize(): Promise<void> {
    console.log('========================================');
    console.log('Encrypted Database Initialization');
    console.log('========================================');
    console.log('User ID:', this.userId);
    console.log('Database path:', this.dbPath);
    console.log('Environment:', process.env.CLAUDE_DESKTOP_EXTENSION === 'true' ? 'Claude Desktop' : 'Standard');
    console.log('');

    // Get or create encryption key
    this.encryptionKey = await this.keyStorage.retrieveKey(this.userId);

    if (!this.encryptionKey) {
      console.log('[DB] No encryption key found - generating new key');
      this.encryptionKey = crypto.randomBytes(32);
      await this.keyStorage.storeKey(this.userId, this.encryptionKey);
      console.log('[DB] New encryption key generated and stored');
    } else {
      console.log('[DB] Encryption key retrieved from storage');
    }

    // Check if we have SQLCipher support
    const useSQLCipher = await this.isSQLCipherAvailable();

    if (useSQLCipher) {
      await this.openWithSQLCipher();
    } else {
      console.warn('[DB] ⚠️  SQLCipher not available - using unencrypted database');
      console.warn('[DB] ⚠️  This should only happen in development');
      await this.openUnencrypted();
    }

    // Run migrations
    await this.runMigrations();

    console.log('[DB] Database initialized successfully');
    console.log('========================================\n');
  }

  /**
   * Open database with SQLCipher encryption
   */
  private async openWithSQLCipher(): Promise<void> {
    console.log('[DB] Opening database with SQLCipher encryption...');

    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    await fs.mkdir(dbDir, { recursive: true });

    // Open with SQLCipher
    this.db = new SQLite(this.dbPath);

    // Set encryption key (must be done before any other operations)
    const keyHex = this.encryptionKey!.toString('hex');
    this.db.pragma(`key = "x'${keyHex}'"`);

    // Configure SQLCipher settings for security
    this.db.pragma('cipher_page_size = 4096');
    this.db.pragma('kdf_iter = 256000'); // PBKDF2 iterations
    this.db.pragma('cipher_hmac_algorithm = HMAC_SHA512');
    this.db.pragma('cipher_kdf_algorithm = PBKDF2_HMAC_SHA512');

    // Test if database is accessible (will throw if key is wrong)
    try {
      this.db.prepare('SELECT count(*) FROM sqlite_master').get();
      console.log('[DB] ✓ Database unlocked successfully');

      // Log SQLCipher version
      const version = this.db.pragma('cipher_version', { simple: true });
      console.log('[DB] SQLCipher version:', version);
    } catch (error) {
      console.error('[DB] ❌ Failed to unlock database - invalid encryption key');
      throw new Error('Failed to unlock database - invalid encryption key');
    }
  }

  /**
   * Open database without encryption (fallback for development)
   */
  private async openUnencrypted(): Promise<void> {
    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    await fs.mkdir(dbDir, { recursive: true });

    this.db = new SQLite(this.dbPath);
    console.log('[DB] Database opened (unencrypted - development only)');
  }

  /**
   * Check if SQLCipher is available
   */
  private async isSQLCipherAvailable(): Promise<boolean> {
    try {
      const testDb = new SQLite(':memory:');
      testDb.pragma('cipher_version');
      testDb.close();
      console.log('[DB] SQLCipher support: Available');
      return true;
    } catch {
      console.log('[DB] SQLCipher support: Not available');
      return false;
    }
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    console.log('[DB] Running database migrations...');

    // Read and execute schema
    const schemaPath = path.join(__dirname, '../../database/schema.sql');
    try {
      const schema = await fs.readFile(schemaPath, 'utf-8');
      this.db.exec(schema);
      console.log('[DB] ✓ Schema initialized');
    } catch (error) {
      console.error('[DB] ❌ Schema initialization failed:', error);
      throw error;
    }
  }

  /**
   * Execute a SQL statement
   */
  execute(sql: string, params?: any[]): RunResult {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).run(...(params || []));
  }

  /**
   * Get a single row
   */
  get<T = any>(sql: string, params?: any[]): T | undefined {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).get(...(params || [])) as T;
  }

  /**
   * Get all rows
   */
  all<T = any>(sql: string, params?: any[]): T[] {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql).all(...(params || [])) as T[];
  }

  /**
   * Prepare a statement for reuse
   */
  prepare(sql: string): Statement {
    if (!this.db) throw new Error('Database not initialized');
    return this.db.prepare(sql);
  }

  /**
   * Execute raw SQL
   */
  exec(sql: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.exec(sql);
  }

  /**
   * Close and lock the database
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.encryptionKey = null;
      console.log('[DB] Database closed and locked');
    }
  }

  /**
   * Re-key the database (change encryption key)
   */
  async rekey(newKey?: Buffer): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    console.log('[DB] Re-keying database...');

    newKey = newKey || crypto.randomBytes(32);
    const newKeyHex = newKey.toString('hex');

    // SQLCipher rekey operation
    this.db.pragma(`rekey = "x'${newKeyHex}'"`);

    // Update stored key
    await this.keyStorage.storeKey(this.userId, newKey);
    this.encryptionKey = newKey;

    console.log('[DB] ✓ Database re-keyed successfully');
  }

  /**
   * Migrate from unencrypted to encrypted database
   */
  async migrateToEncrypted(unencryptedDbPath: string): Promise<void> {
    console.log('===========================================');
    console.log('Database Migration: Unencrypted → Encrypted');
    console.log('===========================================\n');

    console.log('Source (unencrypted):', unencryptedDbPath);
    console.log('Target (encrypted):', this.dbPath);
    console.log('');

    // Open unencrypted database
    console.log('Step 1: Opening source database...');
    const sourceDb = new SQLite(unencryptedDbPath);
    console.log('✓ Source database opened');

    // Create new encryption key
    console.log('\nStep 2: Generating encryption key...');
    const newKey = crypto.randomBytes(32);
    await this.keyStorage.storeKey(this.userId, newKey);
    console.log('✓ Encryption key generated and stored');

    // Use ATTACH DATABASE to copy data
    console.log('\nStep 3: Migrating data...');
    const keyHex = newKey.toString('hex');

    // Ensure target directory exists
    const targetDir = path.dirname(this.dbPath);
    await fs.mkdir(targetDir, { recursive: true });

    sourceDb.exec(`
      ATTACH DATABASE '${this.dbPath}' AS encrypted KEY "x'${keyHex}'";
      PRAGMA encrypted.cipher_page_size = 4096;
      PRAGMA encrypted.kdf_iter = 256000;
      SELECT sqlcipher_export('encrypted');
      DETACH DATABASE encrypted;
    `);

    sourceDb.close();
    console.log('✓ Data migrated to encrypted database');

    // Open the new encrypted database
    console.log('\nStep 4: Verifying migration...');
    this.encryptionKey = newKey;
    await this.openWithSQLCipher();

    // Verify data
    const userCount = this.get<{ count: number }>('SELECT COUNT(*) as count FROM users');
    const accountCount = this.get<{ count: number }>('SELECT COUNT(*) as count FROM accounts');

    console.log('✓ Migration verified:');
    console.log('  - Users:', userCount?.count || 0);
    console.log('  - Accounts:', accountCount?.count || 0);

    console.log('\n===========================================');
    console.log('Migration Complete!');
    console.log('===========================================');
    console.log('Original database:', unencryptedDbPath);
    console.log('Encrypted database:', this.dbPath);
    console.log('\n⚠️  Next steps:');
    console.log('1. Verify the encrypted database works correctly');
    console.log('2. Backup the original database');
    console.log('3. Delete the original unencrypted database:');
    console.log('   rm', unencryptedDbPath);
    console.log('===========================================\n');
  }

  /**
   * Get database instance (for advanced operations)
   */
  getDatabase(): Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }
}
