// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for AddressListService + parsers (#69/#70) on a real node:sqlite temp DB.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './database-service.js';
import { AddressListService, normalizeListValue, parseCsvEmails, parseVcfEmails } from './address-list-service.js';

describe('normalizeListValue', () => {
  it('extracts + lowercases an email from a display-name header', () => {
    expect(normalizeListValue('Alice <A@X.com>')).toEqual({ value: 'a@x.com', valueType: 'email' });
  });
  it('treats @domain and bare domain as domain entries', () => {
    expect(normalizeListValue('@Spam.com')).toEqual({ value: 'spam.com', valueType: 'domain' });
    expect(normalizeListValue('Example.COM')).toEqual({ value: 'example.com', valueType: 'domain' });
  });
  it('rejects non-addresses', () => {
    expect(normalizeListValue('notanaddress')).toBeNull();
    expect(normalizeListValue('')).toBeNull();
  });
});

describe('parsers', () => {
  it('parseCsvEmails pulls + dedupes emails from freeform CSV', () => {
    expect(parseCsvEmails('Name,Email\nBob,bob@x.com\nAlice,alice@y.com\ndup,BOB@x.com').sort()).toEqual(['alice@y.com', 'bob@x.com']);
  });
  it('parseVcfEmails reads vCard EMAIL lines', () => {
    const vcf = 'BEGIN:VCARD\nFN:Bob\nEMAIL;TYPE=INTERNET:bob@x.com\nEND:VCARD\nBEGIN:VCARD\nEMAIL:carol@z.com\nEND:VCARD';
    expect(parseVcfEmails(vcf).sort()).toEqual(['bob@x.com', 'carol@z.com']);
  });
});

describe('AddressListService', () => {
  let tmpDir: string, db: DatabaseService, svc: AddressListService;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-lists-'));
    db = new DatabaseService({ dbPath: path.join(tmpDir, 'data.db') });
    svc = new AddressListService(db);
  });
  afterEach(async () => { try { db.close(); } catch { /* */ } await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('adds, lists, and removes entries', () => {
    svc.addEntry('u', 'deny', 'Spammer <s@bad.com>');
    svc.addEntry('u', 'allow', 'good.com');
    expect(svc.listEntries('u').length).toBe(2);
    expect(svc.listEntries('u', 'deny')[0]).toMatchObject({ value: 's@bad.com', valueType: 'email' });
    expect(svc.removeEntry('u', 'deny', 's@bad.com')).toBe(true);
    expect(svc.listEntries('u', 'deny').length).toBe(0);
  });

  it('check: email beats domain, allow beats deny', () => {
    svc.addEntry('u', 'deny', 'bad.com');           // domain deny
    svc.addEntry('u', 'allow', 'vip@bad.com');       // email allow on same domain
    expect(svc.check('u', 'vip@bad.com').verdict).toBe('allow');   // email-level allow wins
    expect(svc.check('u', 'other@bad.com').verdict).toBe('deny');  // falls to domain deny
    expect(svc.check('u', 'who@elsewhere.com').verdict).toBeNull();
  });

  it('imports from CSV and is scoped per user', () => {
    const res = svc.importEntries('u', 'deny', parseCsvEmails('a@x.com\nb@y.com\nnope'), 'imported');
    expect(res.added).toBe(2);
    expect(svc.listEntries('u', 'deny').length).toBe(2);
    expect(svc.listEntries('other').length).toBe(0); // per-user isolation
  });

  it('clear removes a whole list', () => {
    svc.addEntry('u', 'allow', 'a@x.com');
    svc.addEntry('u', 'allow', 'b@x.com');
    expect(svc.clear('u', 'allow')).toBe(2);
    expect(svc.listEntries('u', 'allow').length).toBe(0);
  });
});
