// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// AddressListService — per-user allow/deny lists of emails/domains (#69/#70).
//
// Entries are normalized email addresses or bare domains. check() resolves a
// sender to a verdict with email-beats-domain specificity and allow-beats-deny
// at each level (so an explicitly allowed sender is never treated as denied).
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)

import { DatabaseService } from './database-service.js';

export type ListType = 'allow' | 'deny';
export type ValueType = 'email' | 'domain';
export type Verdict = 'allow' | 'deny' | null;

export interface ListEntry { listType: ListType; value: string; valueType: ValueType; note: string | null; createdAt: number; }

/** Extract a normalized address from a possibly-display-name header value. */
export function normalizeListValue(raw: string): { value: string; valueType: ValueType } | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  let v = (m ? m[1] : raw).trim().toLowerCase();
  // A leading '@domain' or bare 'domain.tld' is treated as a domain entry.
  if (v.startsWith('@')) v = v.slice(1);
  if (!v) return null;
  if (v.includes('@')) {
    const at = v.lastIndexOf('@');
    if (at === 0 || at === v.length - 1) return null;
    return { value: v, valueType: 'email' };
  }
  // Bare token with a dot → domain; otherwise reject (not a usable entry).
  return v.includes('.') ? { value: v, valueType: 'domain' } : null;
}

/** Pull email addresses out of CSV text (any column / freeform). */
export function parseCsvEmails(text: string): string[] {
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  return [...new Set((text.match(re) ?? []).map((e) => e.toLowerCase()))];
}

/** Pull email addresses out of vCard (.vcf) text — EMAIL lines (Apple Contacts export). */
export function parseVcfEmails(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^EMAIL[^:]*:(.+)$/i.exec(line.trim());
    if (m) {
      const addr = m[1].trim().toLowerCase();
      if (addr.includes('@')) out.add(addr);
    }
  }
  return [...out];
}

export class AddressListService {
  constructor(private db: DatabaseService) {}

  addEntry(userId: string, listType: ListType, rawValue: string, note?: string): ListEntry | null {
    const norm = normalizeListValue(rawValue);
    if (!norm) return null;
    this.db.getDb().prepare(
      `INSERT OR REPLACE INTO address_list_entries (user_id, list_type, value, value_type, note, created_at)
       VALUES ($u, $t, $v, $vt, $n, $c)`
    ).run({ $u: userId, $t: listType, $v: norm.value, $vt: norm.valueType, $n: note ?? null, $c: Date.now() });
    return { listType, value: norm.value, valueType: norm.valueType, note: note ?? null, createdAt: Date.now() };
  }

  removeEntry(userId: string, listType: ListType, rawValue: string): boolean {
    const norm = normalizeListValue(rawValue);
    if (!norm) return false;
    const info = this.db.getDb().prepare(
      `DELETE FROM address_list_entries WHERE user_id = $u AND list_type = $t AND value = $v`
    ).run({ $u: userId, $t: listType, $v: norm.value });
    return Number(info.changes ?? 0) > 0;
  }

  listEntries(userId: string, listType?: ListType): ListEntry[] {
    const params: Record<string, unknown> = { $u: userId };
    let where = 'user_id = $u';
    if (listType) { where += ' AND list_type = $t'; params.$t = listType; }
    const rows = this.db.getDb().prepare(
      `SELECT list_type, value, value_type, note, created_at FROM address_list_entries WHERE ${where} ORDER BY list_type, value`
    ).all(params as any) as any[];
    return rows.map((r) => ({ listType: r.list_type, value: r.value, valueType: r.value_type, note: r.note ?? null, createdAt: r.created_at }));
  }

  clear(userId: string, listType: ListType): number {
    const info = this.db.getDb().prepare(
      `DELETE FROM address_list_entries WHERE user_id = $u AND list_type = $t`
    ).run({ $u: userId, $t: listType });
    return Number(info.changes ?? 0);
  }

  /** Bulk add normalized addresses; returns added/skipped counts. */
  importEntries(userId: string, listType: ListType, rawValues: string[], note?: string): { added: number; skipped: number } {
    let added = 0, skipped = 0;
    const raw = this.db.getDb();
    raw.exec('BEGIN');
    try {
      for (const v of rawValues) {
        if (this.addEntry(userId, listType, v, note)) added++; else skipped++;
      }
      raw.exec('COMMIT');
    } catch (e) { try { raw.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    return { added, skipped };
  }

  /**
   * Resolve a sender to a verdict. Email match beats domain match; at each level
   * an allow entry beats a deny entry (an explicitly allowed sender is never
   * denied). Returns the verdict + what matched, or null when unlisted.
   */
  check(userId: string, rawFrom: string): { verdict: Verdict; matchedValue: string | null; matchedType: ValueType | null } {
    const norm = normalizeListValue(rawFrom);
    if (!norm) return { verdict: null, matchedValue: null, matchedType: null };
    const email = norm.valueType === 'email' ? norm.value : null;
    const domain = norm.valueType === 'email' ? norm.value.slice(norm.value.lastIndexOf('@') + 1) : norm.value;

    const rows = this.db.getDb().prepare(
      `SELECT list_type, value, value_type FROM address_list_entries
       WHERE user_id = $u AND (($et = 1 AND value = $email) OR (value = $domain AND value_type = 'domain'))`
    ).all({ $u: userId, $email: email, $domain: domain, $et: email ? 1 : 0 }) as any[];

    const has = (lt: ListType, vt: ValueType) => rows.find((r) => r.list_type === lt && r.value_type === vt);
    // email level (allow then deny), then domain level (allow then deny)
    for (const vt of ['email', 'domain'] as ValueType[]) {
      const a = has('allow', vt); if (a) return { verdict: 'allow', matchedValue: a.value, matchedType: vt };
      const d = has('deny', vt); if (d) return { verdict: 'deny', matchedValue: d.value, matchedType: vt };
    }
    return { verdict: null, matchedValue: null, matchedType: null };
  }
}
