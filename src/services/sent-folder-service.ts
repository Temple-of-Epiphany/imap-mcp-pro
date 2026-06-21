/**
 * SentFolderService — resolve the Sent folder per account
 *
 * Algorithm (per WP4 spec, RFC 6154 SPECIAL-USE):
 *   1. Cached entry not expired? return it.
 *   2. LIST with SPECIAL-USE: find the mailbox flagged \Sent.
 *   3. Provider preset table (Gmail, Outlook, iCloud, Fastmail, Yahoo, Dovecot).
 *   4. Fallback name probe: Sent / Sent Items / Sent Messages / [Gmail]/Sent Mail / INBOX.Sent.
 *   5. AUTO_CREATE_SENT_FOLDER configured? create "Sent".
 *   6. Otherwise return null (caller skips append, doesn't fail the send).
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Date Updated: 2026-04-30
 * Version: 0.1.0
 *
 * Tracker: #97. Issue: #98.
 */

import { DatabaseService } from './database-service.js';
import { ImapService } from './imap-service.js';
import { Folder } from '../types/index.js';

export type SentFolderResolutionMethod =
  | 'cache'
  | 'special_use'
  | 'preset'
  | 'fallback'
  | 'auto_created'
  | 'override'
  | 'failed';

export interface ResolvedSentFolder {
  /** Resolved folder name (null if resolution failed and caller should skip APPEND) */
  folderName: string | null;
  /** How resolution was reached, for diagnostics */
  method: SentFolderResolutionMethod;
  /** True if the value came from the cache table */
  cacheHit: boolean;
  /** True for accounts where APPEND should be skipped under default settings (Gmail) */
  gmailAutoSkip: boolean;
  /** When resolution failed, the account's folder names (so callers can hint a `sentFolderOverride`). */
  availableFolders?: string[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Provider host → preferred Sent folder name. */
const PROVIDER_PRESETS: Array<{ match: RegExp; folder: string }> = [
  { match: /(^|\.)gmail\.com$/i,         folder: '[Gmail]/Sent Mail' },
  { match: /(^|\.)googlemail\.com$/i,    folder: '[Gmail]/Sent Mail' },
  { match: /(^|\.)office365\.com$/i,     folder: 'Sent Items' },
  { match: /(^|\.)outlook\.com$/i,       folder: 'Sent Items' },
  { match: /(^|\.)hotmail\.com$/i,       folder: 'Sent Items' },
  { match: /(^|\.)icloud\.com$/i,        folder: 'Sent Messages' },
  { match: /(^|\.)me\.com$/i,            folder: 'Sent Messages' },
  { match: /(^|\.)mac\.com$/i,           folder: 'Sent Messages' },
  { match: /(^|\.)fastmail\.com$/i,      folder: 'Sent' },
  { match: /(^|\.)mail\.yahoo\.com$/i,   folder: 'Sent' },
  { match: /(^|\.)yahoo\.com$/i,         folder: 'Sent' },
  { match: /(^|\.)aol\.com$/i,           folder: 'Sent' },
  { match: /(^|\.)hostinger\.com$/i,     folder: 'Sent' },
  { match: /(^|\.)zoho\.com$/i,          folder: 'Sent' },
  { match: /(^|\.)mailbox\.org$/i,       folder: 'Sent' },
  { match: /(^|\.)posteo\.de$/i,         folder: 'Sent' },
  { match: /(^|\.)gmx\./i,               folder: 'Sent' },
  { match: /(^|\.)web\.de$/i,            folder: 'Sent' },
  { match: /(^|\.)protonmail\./i,        folder: 'Sent' },
];

/**
 * Leaf folder names (lower-cased) that denote a Sent folder, including common
 * localizations. Matched against the LAST path segment so namespaced names
 * (`INBOX.Sent`, `INBOX/Sent Items`, `[Gmail]/Sent Mail`) resolve too.
 */
const SENT_LEAF_NAMES = new Set([
  'sent', 'sent items', 'sent messages', 'sent mail',
  'enviados', 'elementos enviados', 'enviadas', 'itens enviados',   // es / pt
  'gesendet', 'gesendete', 'gesendete objekte', 'gesendete elemente', // de
  'envoyés', 'éléments envoyés', 'messages envoyés',                 // fr
  'inviata', 'posta inviata',                                        // it
  'verzonden', 'verzonden items',                                    // nl
  'skickat', 'skickade',                                             // sv
  'wysłane',                                                          // pl
  'отправленные',                                                     // ru
  '已发送', '已发送邮件',                                               // zh
]);

/** Last path segment of an IMAP folder name (handles `/` and `.` hierarchy separators). */
function leafName(name: string): string {
  const parts = name.split(/[/.]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

/** Hosts where Gmail-style server-side Sent copy makes APPEND a duplicate. */
function isGmailHost(host: string): boolean {
  return /(^|\.)(gmail\.com|googlemail\.com)$/i.test(host) || host === 'imap.gmail.com';
}

export class SentFolderService {
  constructor(
    private db: DatabaseService,
    private imap: ImapService
  ) {}

  /**
   * Look up the resolved sent folder. Honors override and writes through
   * to the cache table on a fresh resolution.
   */
  async resolveSentFolder(
    accountId: string,
    options: { override?: string; autoCreate?: boolean } = {}
  ): Promise<ResolvedSentFolder> {
    const { override, autoCreate = false } = options;
    const account = this.db.getAccount(accountId);
    const host = account?.host ?? '';
    const gmailAutoSkip = isGmailHost(host);

    if (override) {
      this.writeCache(accountId, override, 'override');
      return { folderName: override, method: 'override', cacheHit: false, gmailAutoSkip };
    }

    // 1. Cache
    const cached = this.readCache(accountId);
    if (cached) {
      return { folderName: cached.folderName, method: 'cache', cacheHit: true, gmailAutoSkip };
    }

    // 2. SPECIAL-USE
    let folders: Folder[] = [];
    try {
      folders = await this.imap.listFolders(accountId);
    } catch {
      folders = [];
    }
    const specialSent = folders.find((f) =>
      f.attributes?.some((a: unknown) => /^\\Sent$/i.test(String(a)))
    );
    if (specialSent) {
      this.writeCache(accountId, specialSent.name, 'special_use');
      return { folderName: specialSent.name, method: 'special_use', cacheHit: false, gmailAutoSkip };
    }

    const folderNames = new Set(folders.map((f) => f.name));

    // 3. Provider preset
    const preset = PROVIDER_PRESETS.find((p) => p.match.test(host));
    if (preset && folderNames.has(preset.folder)) {
      this.writeCache(accountId, preset.folder, 'preset');
      return { folderName: preset.folder, method: 'preset', cacheHit: false, gmailAutoSkip };
    }

    // 4. Leaf-name match — case-insensitive, namespaced + localized aware.
    for (const f of folders) {
      if (SENT_LEAF_NAMES.has(leafName(f.name).toLowerCase())) {
        this.writeCache(accountId, f.name, 'fallback');
        return { folderName: f.name, method: 'fallback', cacheHit: false, gmailAutoSkip };
      }
    }

    // 5. Auto-create
    if (autoCreate) {
      try {
        await this.imap.createFolder(accountId, 'Sent');
        this.writeCache(accountId, 'Sent', 'auto_created');
        return { folderName: 'Sent', method: 'auto_created', cacheHit: false, gmailAutoSkip };
      } catch {
        // fall through to failed
      }
    }

    // 6. Failed — surface the folder list so the caller can hint sentFolderOverride.
    return {
      folderName: null,
      method: 'failed',
      cacheHit: false,
      gmailAutoSkip,
      availableFolders: [...folderNames],
    };
  }

  /** Force a re-resolution on next call (e.g. when folder list changes). */
  invalidateCache(accountId: string): void {
    this.db.getDb()
      .prepare('DELETE FROM sent_folder_cache WHERE account_id = ?')
      .run(accountId);
  }

  // ---------- private ----------

  private readCache(accountId: string): { folderName: string; method: SentFolderResolutionMethod } | null {
    const row = this.db.getDb()
      .prepare('SELECT folder_name, resolution_method, expires_at FROM sent_folder_cache WHERE account_id = ?')
      .get(accountId) as { folder_name: string; resolution_method: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.db.getDb().prepare('DELETE FROM sent_folder_cache WHERE account_id = ?').run(accountId);
      return null;
    }
    return { folderName: row.folder_name, method: row.resolution_method as SentFolderResolutionMethod };
  }

  private writeCache(
    accountId: string,
    folderName: string,
    method: Exclude<SentFolderResolutionMethod, 'cache' | 'failed'>
  ): void {
    const now = Date.now();
    this.db.getDb()
      .prepare(`
        INSERT INTO sent_folder_cache (account_id, folder_name, resolution_method, resolved_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          folder_name = excluded.folder_name,
          resolution_method = excluded.resolution_method,
          resolved_at = excluded.resolved_at,
          expires_at = excluded.expires_at
      `)
      .run(accountId, folderName, method, now, now + CACHE_TTL_MS);
  }
}

export { isGmailHost };
