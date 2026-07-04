// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for tool titles + annotation hints — required for the Anthropic
// directory ("all tools must include a title and a read-only/destructive hint").

import { describe, expect, it } from 'vitest';
import { titleFromName, getAnnotations } from './annotations.js';

describe('titleFromName', () => {
  it.each([
    ['imap_search_emails', 'Search Emails'],
    ['imap_get_smtp_metrics', 'Get SMTP Metrics'],
    ['imap_test_quad9_dns', 'Test Quad9 DNS'],
    ['imap_bulk_job_status', 'Bulk Job Status'],
    ['imap_add_usercheck_key', 'Add UserCheck Key'],
    ['imap_import_list', 'Import List'],
    ['imap_get_quota', 'Get Quota'],
  ])('%s → %s', (name, title) => {
    expect(titleFromName(name)).toBe(title);
  });

  it('never produces an empty title', () => {
    for (const n of ['imap_about', 'imap_results', 'imap_help']) {
      expect(titleFromName(n).length).toBeGreaterThan(0);
    }
  });
});

describe('getAnnotations always yields a read-only or destructive hint', () => {
  it.each([
    'imap_search_emails', 'imap_delete_email', 'imap_add_list_entry', 'imap_check_address',
    'imap_scan_account_spam_start', 'imap_bulk_job_cancel', 'imap_test_categories',
    'imap_some_unknown_future_tool', // fallback path
  ])('%s has a defined hint', (name) => {
    const a = getAnnotations(name);
    expect(a.readOnlyHint === true || a.destructiveHint === true).toBe(true);
  });
});
