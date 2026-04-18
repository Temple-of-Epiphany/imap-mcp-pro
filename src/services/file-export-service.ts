/**
 * File Export Service
 *
 * Owns the on-disk results directory for the resource-handle pattern.
 * - Writes encrypted JSON / JSONL exports per (userId, resultId)
 * - Stores encrypted attachment blobs
 * - Enforces per-user disk quota
 * - Supports paginated reads of stored exports
 *
 * Files live under <rootDir>/<userId>/<resultId>/
 *   - rows.json or rows.jsonl  (encrypted with AES-256-GCM)
 *   - attachments/<attachmentId>.bin (encrypted)
 *
 * Author: Temple of Epiphany
 * Date: 2026-04-18
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { Readable } from 'stream';
import { ContextReductionConfig } from '../config/context-reduction.js';
import { DatabaseService } from './database-service.js';

export interface FileExportServiceOptions {
  rootDir?: string;
  perUserQuotaBytes?: number;
}

export interface WriteRowsResult {
  filePath: string;
  size: number;
  format: 'json' | 'jsonl';
}

export interface WriteAttachmentResult {
  filePath: string;
  iv: string;
  authTag: string;
  size: number;
  checksum: string;
}

export class QuotaExceededError extends Error {
  constructor(public userId: string, public usage: number, public quota: number) {
    super(`Disk quota exceeded for user '${userId}': ${usage} > ${quota} bytes`);
    this.name = 'QuotaExceededError';
  }
}

const ENC_HEADER = Buffer.from('IMECv1\n', 'utf8'); // sentinel for encrypted file format
const IV_LEN = 16;
const TAG_LEN = 16;

export class FileExportService {
  private rootDir: string;
  private perUserQuota: number;

  constructor(private db: DatabaseService, opts: FileExportServiceOptions = {}) {
    this.rootDir = opts.rootDir ?? ContextReductionConfig.RESULTS_ROOT_DIR;
    this.perUserQuota = opts.perUserQuotaBytes ?? ContextReductionConfig.PER_USER_DISK_QUOTA;

    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  // ---------- path helpers ----------

  private safeJoin(...parts: string[]): string {
    const joined = path.resolve(this.rootDir, ...parts);
    const rel = path.relative(this.rootDir, joined);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escape attempted: ${joined}`);
    }
    return joined;
  }

  userDir(userId: string): string {
    const dir = this.safeJoin(userId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  resultDir(userId: string, resultId: string): string {
    const dir = this.safeJoin(userId, resultId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  attachmentDir(userId: string, resultId: string): string {
    const dir = this.safeJoin(userId, resultId, 'attachments');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  // ---------- quota ----------

  async getUserUsage(userId: string): Promise<number> {
    const dir = path.join(this.rootDir, userId);
    if (!fs.existsSync(dir)) return 0;
    return await this.dirSize(dir);
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await this.dirSize(p);
      else if (entry.isFile()) total += (await fs.promises.stat(p)).size;
    }
    return total;
  }

  private async checkQuota(userId: string, addBytes: number): Promise<void> {
    const usage = await this.getUserUsage(userId);
    if (usage + addBytes > this.perUserQuota) {
      throw new QuotaExceededError(userId, usage + addBytes, this.perUserQuota);
    }
  }

  // ---------- encryption helpers (file-level) ----------

  /**
   * Encrypted file layout:
   *   ENC_HEADER  (7 bytes)
   *   iv          (16 bytes)
   *   authTag     (16 bytes)
   *   ciphertext  (rest)
   */
  private encryptToBuffer(plaintext: Buffer): Buffer {
    const { ciphertext, iv, authTag } = this.db.encryptBuffer(plaintext);
    return Buffer.concat([
      ENC_HEADER,
      Buffer.from(iv, 'hex'),
      Buffer.from(authTag, 'hex'),
      ciphertext,
    ]);
  }

  private decryptFromBuffer(buf: Buffer): Buffer {
    if (!buf.slice(0, ENC_HEADER.length).equals(ENC_HEADER)) {
      throw new Error('FileExportService: missing encryption header');
    }
    const iv = buf.slice(ENC_HEADER.length, ENC_HEADER.length + IV_LEN).toString('hex');
    const authTag = buf
      .slice(ENC_HEADER.length + IV_LEN, ENC_HEADER.length + IV_LEN + TAG_LEN)
      .toString('hex');
    const ciphertext = buf.slice(ENC_HEADER.length + IV_LEN + TAG_LEN);
    return this.db.decryptBuffer(ciphertext, iv, authTag);
  }

  // ---------- rows write/read ----------

  async writeRows(
    userId: string,
    resultId: string,
    rows: unknown[]
  ): Promise<WriteRowsResult> {
    const useJsonl = rows.length > ContextReductionConfig.JSONL_THRESHOLD_ROWS;
    const dir = this.resultDir(userId, resultId);
    const fileName = useJsonl ? 'rows.jsonl' : 'rows.json';
    const filePath = path.join(dir, fileName);

    let plaintext: Buffer;
    if (useJsonl) {
      const lines = rows.map(r => JSON.stringify(r)).join('\n');
      plaintext = Buffer.from(lines, 'utf8');
    } else {
      plaintext = Buffer.from(JSON.stringify(rows), 'utf8');
    }

    await this.checkQuota(userId, plaintext.length + 64);
    const encrypted = this.encryptToBuffer(plaintext);
    await fs.promises.writeFile(filePath, encrypted, { mode: 0o600 });

    return { filePath, size: encrypted.length, format: useJsonl ? 'jsonl' : 'json' };
  }

  async readRowsSlice(
    filePath: string,
    offset: number,
    limit: number
  ): Promise<unknown[]> {
    const buf = await fs.promises.readFile(filePath);
    const plain = this.decryptFromBuffer(buf);

    if (filePath.endsWith('.jsonl')) {
      const out: unknown[] = [];
      let idx = 0;
      const stream = Readable.from([plain]);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        if (idx >= offset && out.length < limit) {
          out.push(JSON.parse(line));
        }
        idx += 1;
        if (out.length >= limit) break;
      }
      return out;
    }

    const all = JSON.parse(plain.toString('utf8')) as unknown[];
    return all.slice(offset, offset + limit);
  }

  async countRows(filePath: string): Promise<number> {
    const buf = await fs.promises.readFile(filePath);
    const plain = this.decryptFromBuffer(buf);
    if (filePath.endsWith('.jsonl')) {
      const stream = Readable.from([plain]);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let n = 0;
      for await (const line of rl) if (line) n += 1;
      return n;
    }
    return (JSON.parse(plain.toString('utf8')) as unknown[]).length;
  }

  // ---------- attachments ----------

  async writeAttachment(
    userId: string,
    resultId: string,
    attachmentId: string,
    content: Buffer
  ): Promise<WriteAttachmentResult> {
    await this.checkQuota(userId, content.length + 64);
    const dir = this.attachmentDir(userId, resultId);
    const filePath = path.join(dir, `${attachmentId}.bin`);

    const { ciphertext, iv, authTag } = this.db.encryptBuffer(content);
    const checksum = crypto.createHash('sha256').update(content).digest('hex');

    // Layout: authTag(16) || ciphertext
    const fileBuf = Buffer.concat([Buffer.from(authTag, 'hex'), ciphertext]);
    await fs.promises.writeFile(filePath, fileBuf, { mode: 0o600 });

    return { filePath, iv, authTag, size: fileBuf.length, checksum };
  }

  async readAttachment(filePath: string, ivHex: string): Promise<Buffer> {
    const buf = await fs.promises.readFile(filePath);
    const authTag = buf.slice(0, TAG_LEN).toString('hex');
    const ciphertext = buf.slice(TAG_LEN);
    return this.db.decryptBuffer(ciphertext, ivHex, authTag);
  }

  // ---------- delete / cleanup ----------

  async deleteResultDir(userId: string, resultId: string): Promise<void> {
    const dir = path.join(this.rootDir, userId, resultId);
    if (fs.existsSync(dir)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  async sweepOrphans(knownResultPaths: Set<string>): Promise<number> {
    if (!fs.existsSync(this.rootDir)) return 0;
    let removed = 0;
    const userDirs = await fs.promises.readdir(this.rootDir, { withFileTypes: true });
    for (const userDir of userDirs) {
      if (!userDir.isDirectory()) continue;
      const userPath = path.join(this.rootDir, userDir.name);
      const resultDirs = await fs.promises.readdir(userPath, { withFileTypes: true });
      for (const resDir of resultDirs) {
        if (!resDir.isDirectory()) continue;
        const resPath = path.join(userPath, resDir.name);
        if (!knownResultPaths.has(resPath)) {
          await fs.promises.rm(resPath, { recursive: true, force: true });
          removed += 1;
        }
      }
    }
    return removed;
  }

  destroy(): void {
    // No timers held here; cleanup is driven by ResultsService.
  }
}
