#!/usr/bin/env tsx
/**
 * smoke-test-cache.ts — end-to-end exercise of v2.17.0 MVP cache against a live
 * IMAP account. Runs the full success-criterion workflow from issue #124:
 *
 *   1. Connect to the account
 *   2. Sync INBOX cache (cold)
 *   3. group_by_sender top 20
 *   4. by_domain spot check
 *   5. Re-sync (warm — should be near-zero ops)
 *   6. group_by_sender again (warm — should be < 200ms)
 *
 * Usage:
 *   npx tsx scripts/smoke-test-cache.ts <accountId> [folder]
 *
 * Default folder is INBOX. Account ID can be looked up via:
 *   sqlite3 ~/.imap-mcp/data.db "SELECT account_id, name, username FROM accounts;"
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Version: 0.1.0
 */

import { DatabaseService } from '../src/services/database-service.js';
import { ImapService } from '../src/services/imap-service.js';
import { MessageCacheService } from '../src/services/message-cache-service.js';

const accountId = process.argv[2];
const folder = process.argv[3] ?? 'INBOX';

if (!accountId) {
  console.error('Usage: npx tsx scripts/smoke-test-cache.ts <accountId> [folder]');
  console.error('');
  console.error('List accounts:');
  console.error('  sqlite3 ~/.imap-mcp/data.db "SELECT account_id, name, username FROM accounts;"');
  process.exit(2);
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log(`\n=== v2.17.0 MVP cache smoke test ===`);
  console.log(`Account:  ${accountId}`);
  console.log(`Folder:   ${folder}`);
  console.log('');

  const db = new DatabaseService();
  const imap = new ImapService(db);
  const cache = new MessageCacheService(db, imap);

  // ---- Step 1: Connect ----
  const account = db.getDecryptedAccount(accountId);
  if (!account) {
    console.error(`Account not found: ${accountId}`);
    process.exit(2);
  }
  const t1 = Date.now();
  await imap.connect({
    id: account.account_id,
    name: account.name,
    host: account.host,
    port: account.port,
    user: account.username,
    password: account.password,
    tls: account.tls,
  });
  console.log(`[1] connect (${account.name} @ ${account.host}): ${fmt(Date.now() - t1)}`);

  // ---- Step 2: Cold sync ----
  console.log(`[2] sync (cold) ...`);
  const sync1 = await cache.syncFolder(accountId, folder);
  console.log(`    rows added:   ${sync1.rowsAdded}`);
  console.log(`    rows after:   ${sync1.rowsAfter}`);
  console.log(`    duration:     ${fmt(sync1.durationMs)}`);
  console.log(`    UIDVALIDITY:  ${sync1.uidValidity}${sync1.uidValidityChanged ? ' (changed!)' : ''}`);

  // ---- Step 3: group_by_sender top 20 (cold cache, but read is fast either way) ----
  console.log(`\n[3] group_by_sender (top 20):`);
  const t3 = Date.now();
  const groups = await cache.groupBySender(accountId, folder, { limit: 20 });
  const t3ms = Date.now() - t3;
  console.log(`    duration: ${fmt(t3ms)}\n`);
  console.log(`    ${pad('#', 3)} ${pad('count', 6)} ${pad('list_unsub', 11)} ${pad('sender', 50)}`);
  console.log(`    ${'-'.repeat(3)} ${'-'.repeat(6)} ${'-'.repeat(11)} ${'-'.repeat(50)}`);
  groups.forEach((g, i) => {
    const sender = g.fromName ? `${g.fromName} <${g.fromAddress}>` : g.fromAddress;
    const truncSender = sender.length > 50 ? sender.slice(0, 47) + '...' : sender;
    console.log(
      `    ${pad(String(i + 1), 3)} ${pad(String(g.count), 6)} ` +
      `${pad(g.listUnsubscribePresent ? 'yes' : 'no', 11)} ${pad(truncSender, 50)}`
    );
  });

  // ---- Step 4: by_domain spot check (use top sender's domain) ----
  if (groups.length > 0) {
    const topDomain = groups[0].fromDomain;
    if (topDomain) {
      console.log(`\n[4] by_domain "${topDomain}" (limit 5):`);
      const t4 = Date.now();
      const byDom = await cache.searchByFromDomain(accountId, folder, topDomain, { limit: 5 });
      const t4ms = Date.now() - t4;
      console.log(`    duration: ${fmt(t4ms)}, rows: ${byDom.length}`);
      byDom.slice(0, 3).forEach(r => {
        const d = r.dateReceived ? new Date(r.dateReceived).toISOString().slice(0, 10) : '-';
        console.log(`      ${d} | ${r.fromAddress} | ${r.subject?.slice(0, 60) ?? ''}`);
      });
    }
  }

  // ---- Step 5: Re-sync (warm — should be near-zero new) ----
  console.log(`\n[5] sync (warm) ...`);
  const sync2 = await cache.syncFolder(accountId, folder);
  console.log(`    rows added:   ${sync2.rowsAdded}`);
  console.log(`    duration:     ${fmt(sync2.durationMs)}`);

  // ---- Step 6: group_by_sender again (warm, target < 200ms) ----
  console.log(`\n[6] group_by_sender (warm):`);
  const t6 = Date.now();
  const groups2 = await cache.groupBySender(accountId, folder, { limit: 20 });
  const t6ms = Date.now() - t6;
  console.log(`    duration: ${fmt(t6ms)} ${t6ms < 200 ? '✓' : '✗ (target < 200ms)'}`);
  console.log(`    rows: ${groups2.length}`);

  // ---- Summary ----
  console.log(`\n=== Summary ===`);
  const checks = [
    { name: 'Cold sync rows > 0',                  pass: sync1.rowsAfter > 0 },
    { name: 'Cold sync < 60s',                     pass: sync1.durationMs < 60_000 },
    { name: 'Warm sync near-zero new rows',        pass: sync2.rowsAdded === 0 },
    { name: 'group_by_sender warm < 200ms',        pass: t6ms < 200 },
    { name: 'group_by_sender returns >= 1 sender', pass: groups.length >= 1 },
  ];
  for (const c of checks) {
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`);
  }
  const allPass = checks.every(c => c.pass);
  console.log(`\nResult: ${allPass ? 'PASS' : 'FAIL'}`);

  // ---- Cleanup ----
  await imap.disconnect(accountId);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
