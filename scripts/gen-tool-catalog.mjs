#!/usr/bin/env node
/**
 * gen-tool-catalog.mjs — generate docs/TOOL_CATALOG.md from the live tool manifest.
 *
 * Reads the authoritative tool list (name + description) straight from the
 * built server (`node dist/index.js --print-tools-manifest`), buckets the tools
 * into stable categories, and writes a Markdown catalog. Run from postbuild so
 * the catalog can never drift from the registered tools again (#201).
 *
 * Author:        Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
 * Part of:       IMAP MCP Pro (Temple of Epiphany)
 * Date Created:  2026-06-21
 * Date Updated:  2026-06-21
 * Version:       1.0.0
 *
 * Changelog:
 *   1.0.0 (2026-06-21) — initial: manifest → categorized docs/TOOL_CATALOG.md.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');
const outPath = path.join(repoRoot, 'docs', 'TOOL_CATALOG.md');

// Ordered (regex → category) rules; first match wins. Keep specific patterns
// (e.g. *_chunked, db_*) ahead of broader ones.
const CATEGORIES = [
  ['Users (MSP multi-tenant)', /^imap_(create_user|get_user|list_users)$/],
  ['Account management', /^imap_(add_account|add_account_auto|add_account_with_provider|remove_account|list_accounts|connect|disconnect|test_account|share_account|unshare_account|list_providers|db_add_account|db_get_account|db_list_accounts|db_remove_account)$/],
  ['Bulk operations', /^imap_bulk_/],
  ['Size, export & quota', /^imap_(get_email_sizes|get_largest_emails|export_email|export_folder|export_account|extract_attachments|get_attachment|get_quota)$/],
  ['Attachment staging', /^imap_(attachment_stage_|list_staged_attachments|get_outbox_dir)/],
  ['Email operations', /^imap_(search_emails|get_email|get_latest_emails|mark_as_read|mark_as_unread|delete_email|copy_email|move_email|send_email|reply_to_email|forward_email|get_email_priority|set_email_priority)$/],
  ['Folder & mailbox operations', /^imap_(list_folders|folder_status|get_unread_count|create_folder|delete_folder|rename_folder|get_mailbox_status|subscribe_mailbox|unsubscribe_mailbox|list_subscribed_mailboxes|append_message)$/],
  ['Subscriptions & unsubscribe', /^imap_(extract_unsubscribe_links|get_unsubscribe_links|get_unsubscribe_links_for|execute_unsubscribe|get_subscription_summary|list_unsubscribe_candidates|mark_subscription_unsubscribed|update_subscription_category|update_subscription_notes)$/],
  ['Categorization & scoring', /^imap_(add_keyword|remove_keyword|list_categories|apply_categories|analyze_folder_confidence|score_email_confidence)$/],
  ['Spam & UserCheck', /^imap_(check_email_spam|check_emails_spam_bulk|check_folder_spam|scan_account_spam|add_usercheck_key|get_usercheck_key|delete_usercheck_key)$/],
  ['DNS firewall & domain checks', /^imap_(check_domain|check_domain_dns_firewall|scan_message_domains|test_quad9_dns)$/],
  ['Local cache', /^imap_(search_cache|sync_folder_cache)$/],
  ['Capabilities, diagnostics & metrics', /^imap_(get_capabilities|test_smtp|test_sent_folder|list_unarchived_sends|get_metrics|get_operation_metrics|reset_metrics|get_smtp_metrics|reset_smtp_metrics|get_circuit_breaker|reset_circuit_breaker)$/],
  ['Meta & discovery', /^imap_(about|list_tools|help|check_skill_updates|update_skills|results)$/],
  ['Admin & lifecycle', /^imap_(server_reload|open_web_ui)$/],
];

function categoryFor(name) {
  for (const [label, rx] of CATEGORIES) if (rx.test(name)) return label;
  return 'Other';
}

function loadManifest() {
  if (!existsSync(distEntry)) {
    throw new Error(`Built server not found at ${distEntry} — run "npm run build" first.`);
  }
  // Point the spawned server at a throwaway DB so generating docs during a
  // build never touches the developer's real ~/.imap-mcp/data.db.
  const throwawayDb = path.join(tmpdir(), `imap-mcp-catalog-${process.pid}.db`);
  const raw = execFileSync('node', [distEntry, '--print-tools-manifest'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, IMAP_MCP_DATABASE_PATH: throwawayDb },
  });
  return JSON.parse(raw);
}

function firstSentence(desc) {
  const s = String(desc || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : s).slice(0, 240);
}

function render(tools) {
  const byCat = new Map(CATEGORIES.map(([label]) => [label, []]));
  byCat.set('Other', []);
  for (const t of tools) byCat.get(categoryFor(t.name)).push(t);

  const lines = [];
  lines.push('# Tool Catalog');
  lines.push('');
  lines.push('> **Generated file — do not edit by hand.** Produced from the live tool');
  lines.push('> manifest by `scripts/gen-tool-catalog.mjs` (runs on `npm run build`).');
  lines.push('> The authoritative runtime list is always available via the `imap_list_tools` tool.');
  lines.push('');
  lines.push(`**${tools.length} MCP tools** total.`);
  lines.push('');

  // Table of contents with per-category counts.
  lines.push('## Categories');
  lines.push('');
  for (const [label] of [...CATEGORIES, ['Other']]) {
    const items = byCat.get(label);
    if (!items || items.length === 0) continue;
    const anchor = label.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '-');
    lines.push(`- [${label}](#${anchor}) — ${items.length}`);
  }
  lines.push('');

  for (const [label] of [...CATEGORIES, ['Other']]) {
    const items = byCat.get(label);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${label}`);
    lines.push('');
    lines.push('| Tool | Description |');
    lines.push('| --- | --- |');
    for (const t of items) {
      lines.push(`| \`${t.name}\` | ${firstSentence(t.description).replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

const manifest = loadManifest();
const tools = (manifest.tools || []).slice().sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(outPath, render(tools));
console.log(`[gen-tool-catalog] wrote ${path.relative(repoRoot, outPath)} (${tools.length} tools)`);
