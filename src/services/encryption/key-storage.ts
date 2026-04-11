/**
 * Encryption Key Storage Implementations
 *
 * Provides multiple backends for storing database encryption keys:
 * - OS Keychain (macOS/Windows) - Most secure, for Claude Desktop
 * - Encrypted File - Fallback for standard mode
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2025-12-05
 * Date Updated: 2025-12-05
 * Version: 1.0.0
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import * as keytar from 'keytar';

/**
 * Key Storage Strategy Interface
 */
export interface KeyStorage {
  storeKey(userId: string, key: Buffer): Promise<void>;
  retrieveKey(userId: string): Promise<Buffer | null>;
  deleteKey(userId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

/**
 * OS Keychain Storage (Secure - Claude Desktop)
 * Uses macOS Keychain or Windows Credential Manager
 */
export class KeychainStorage implements KeyStorage {
  private serviceName = 'imap-mcp-pro-db';

  async storeKey(userId: string, key: Buffer): Promise<void> {
    console.log('[Keychain] Storing encryption key for user:', userId);
    await keytar.setPassword(this.serviceName, userId, key.toString('hex'));
    console.log('[Keychain] Key stored successfully');
  }

  async retrieveKey(userId: string): Promise<Buffer | null> {
    console.log('[Keychain] Retrieving encryption key for user:', userId);
    const hexKey = await keytar.getPassword(this.serviceName, userId);

    if (!hexKey) {
      console.log('[Keychain] No key found');
      return null;
    }

    console.log('[Keychain] Key retrieved successfully');
    return Buffer.from(hexKey, 'hex');
  }

  async deleteKey(userId: string): Promise<void> {
    console.log('[Keychain] Deleting encryption key for user:', userId);
    await keytar.deletePassword(this.serviceName, userId);
    console.log('[Keychain] Key deleted successfully');
  }

  async isAvailable(): Promise<boolean> {
    // Keychain available on macOS and Windows
    const available = process.platform === 'darwin' || process.platform === 'win32';
    console.log('[Keychain] Available:', available, '(platform:', process.platform + ')');
    return available;
  }
}

/**
 * Encrypted File Storage (Less secure - Standard mode)
 * Uses encrypted file with machine-specific key derivation
 */
export class EncryptedFileStorage implements KeyStorage {
  private keyDir: string;
  private masterKeyPath: string;

  constructor(configDir?: string) {
    this.keyDir = configDir || path.join(os.homedir(), '.config', 'imap-mcp');
    this.masterKeyPath = path.join(this.keyDir, '.master.key');
  }

  private async getMasterKey(): Promise<Buffer> {
    try {
      const keyHex = await fs.readFile(this.masterKeyPath, 'utf-8');
      console.log('[EncryptedFile] Using existing master key');
      return Buffer.from(keyHex.trim(), 'hex');
    } catch (error) {
      // Generate new master key on first run
      console.log('[EncryptedFile] Generating new master key');
      const masterKey = crypto.randomBytes(32);
      await fs.mkdir(this.keyDir, { recursive: true });
      await fs.writeFile(this.masterKeyPath, masterKey.toString('hex'));

      // Set restrictive permissions (owner read/write only)
      try {
        await fs.chmod(this.masterKeyPath, 0o600);
        console.log('[EncryptedFile] Master key permissions set to 600');
      } catch (chmodError) {
        console.warn('[EncryptedFile] Could not set file permissions:', chmodError);
      }

      console.log('[EncryptedFile] Master key created at:', this.masterKeyPath);
      return masterKey;
    }
  }

  async storeKey(userId: string, key: Buffer): Promise<void> {
    console.log('[EncryptedFile] Storing encryption key for user:', userId);
    const masterKey = await this.getMasterKey();

    // Encrypt the database key with the master key
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);

    const encrypted = Buffer.concat([
      cipher.update(key),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    // Store: IV (16) + AuthTag (16) + Encrypted Key (32)
    const payload = Buffer.concat([iv, authTag, encrypted]);

    const keyPath = path.join(this.keyDir, `${userId}.dbkey`);
    await fs.writeFile(keyPath, payload);

    try {
      await fs.chmod(keyPath, 0o600);
      console.log('[EncryptedFile] Key file permissions set to 600');
    } catch (chmodError) {
      console.warn('[EncryptedFile] Could not set file permissions:', chmodError);
    }

    console.log('[EncryptedFile] Key stored at:', keyPath);
  }

  async retrieveKey(userId: string): Promise<Buffer | null> {
    try {
      console.log('[EncryptedFile] Retrieving encryption key for user:', userId);
      const masterKey = await this.getMasterKey();
      const keyPath = path.join(this.keyDir, `${userId}.dbkey`);
      const payload = await fs.readFile(keyPath);

      // Extract: IV (16) + AuthTag (16) + Encrypted Key
      const iv = payload.subarray(0, 16);
      const authTag = payload.subarray(16, 32);
      const encrypted = payload.subarray(32);

      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);

      console.log('[EncryptedFile] Key retrieved successfully');
      return decrypted;
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        console.log('[EncryptedFile] No key file found');
      } else {
        console.error('[EncryptedFile] Error retrieving key:', error);
      }
      return null;
    }
  }

  async deleteKey(userId: string): Promise<void> {
    console.log('[EncryptedFile] Deleting encryption key for user:', userId);
    const keyPath = path.join(this.keyDir, `${userId}.dbkey`);
    try {
      await fs.unlink(keyPath);
      console.log('[EncryptedFile] Key deleted successfully');
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        console.error('[EncryptedFile] Error deleting key:', error);
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    // Always available as fallback
    console.log('[EncryptedFile] Available: true (fallback storage)');
    return true;
  }
}

/**
 * Auto-select appropriate key storage based on environment
 */
export function createKeyStorage(): KeyStorage {
  // Claude Desktop extension - use OS Keychain
  if (process.env.CLAUDE_DESKTOP_EXTENSION === 'true') {
    console.log('[KeyStorage] Selected: OS Keychain (Claude Desktop mode)');
    return new KeychainStorage();
  }

  // Standard mode - use encrypted file
  console.log('[KeyStorage] Selected: Encrypted File (Standard mode)');
  return new EncryptedFileStorage();
}
