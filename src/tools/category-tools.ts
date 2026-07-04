/**
 * Quick Categories Tools for IMAP MCP Pro
 *
 * Provides MCP tools for automatic email categorization and organization.
 * Issue #71: Quick Categories implementation
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date: 2025-12-22
 * Version: 0.1
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ImapService } from '../services/imap-service.js';
import { DatabaseService } from '../services/database-service.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { getToolContext } from './tool-context.js';

/** A category row as stored: name, comma/semicolon keyword list, destination. */
interface CategoryRow { category_name: string; keywords: string; target_folder: string; }
/** Minimal email shape the evaluator needs. */
interface EvalEmail { uid: number; from?: string; subject?: string; date?: unknown; }

/** Split a category's keyword string into normalized, non-empty terms. */
function splitKeywords(keywords: string): string[] {
  return (keywords || '').split(/[,;]/).map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0);
}

/**
 * Pure dry-run categorization analysis (#72): for each email find ALL matching
 * categories (not just the first), so we can report coverage, conflicts
 * (multi-category matches), per-category counts, and the uncategorized set —
 * without moving anything. "Destination" mirrors imap_apply_categories'
 * first-match-wins behavior (categories are evaluated in the given order).
 */
export function evaluateCategories(emails: EvalEmail[], categories: CategoryRow[]) {
  const prepared = categories.map((c) => ({ name: c.category_name, target: c.target_folder, keywords: splitKeywords(c.keywords) }));
  const perCategory: Record<string, { count: number; target: string }> = {};
  for (const c of prepared) perCategory[c.name] = { count: 0, target: c.target };

  const matched: Array<{ uid: number; subject: string; from: string; date: unknown; destination: string; matchedCategory: string; matchedKeyword: string; allCategories: string[] }> = [];
  const uncategorized: Array<{ uid: number; subject: string; from: string; date: unknown }> = [];
  let conflicts = 0;

  for (const email of emails) {
    const text = `${email.from || ''} ${email.subject || ''}`.toLowerCase();
    const hits: Array<{ category: string; keyword: string; target: string }> = [];
    for (const c of prepared) {
      const kw = c.keywords.find((k) => text.includes(k));
      if (kw) hits.push({ category: c.name, keyword: kw, target: c.target });
    }
    if (hits.length === 0) {
      uncategorized.push({ uid: email.uid, subject: email.subject || '(no subject)', from: email.from || '', date: email.date });
      continue;
    }
    const first = hits[0]; // first-match-wins destination (matches apply behavior)
    perCategory[first.category].count++;
    const distinct = [...new Set(hits.map((h) => h.category))];
    if (distinct.length > 1) conflicts++;
    matched.push({
      uid: email.uid, subject: email.subject || '(no subject)', from: email.from || '', date: email.date,
      destination: first.target, matchedCategory: first.category, matchedKeyword: first.keyword, allCategories: distinct,
    });
  }

  const total = emails.length;
  const categorized = matched.length;
  return {
    total,
    categorized,
    uncategorized: uncategorized.length,
    coveragePercent: total > 0 ? Math.round((categorized / total) * 1000) / 10 : 0,
    conflicts,
    perCategory,
    matched,
    uncategorizedList: uncategorized,
  };
}

// Common words to ignore when mining subject lines for keyword candidates.
const KEYWORD_STOPWORDS = new Set([
  're', 'fwd', 'fw', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'is', 'are', 'be',
  'your', 'you', 'we', 'our', 'us', 'my', 'me', 'it', 'this', 'that', 'with', 'from', 'by', 'as', 'has', 'have',
  'will', 'can', 'new', 'now', 'get', 'please', 'thanks', 'thank', 'hi', 'hello', 'no', 'yes', 'not', 'do', 'all',
]);

function domainOf(rawFrom: string): string | null {
  const m = (rawFrom || '').match(/<([^>]+)>/);
  const addr = (m ? m[1] : rawFrom).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  return at >= 0 && at < addr.length - 1 ? addr.slice(at + 1) : null;
}
function addressOf(rawFrom: string): string | null {
  const m = (rawFrom || '').match(/<([^>]+)>/);
  const addr = (m ? m[1] : rawFrom).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}
function topN<T extends { count: number }>(map: Map<string, number>, make: (k: string, c: number) => T, n: number, minCount: number): T[] {
  return [...map.entries()].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => make(k, c));
}

/**
 * Mine a sample of emails for category-keyword candidates (#73, data-for-Claude):
 * top sender domains, top senders, and frequent subject terms + bigrams, each
 * flagged as already-covered by existing keywords. Returns structured stats for
 * the client (Claude) to turn into recommendations — the server does not call an
 * LLM. Pure + deterministic.
 */
export function recommendKeywords(
  emails: Array<{ from?: string; subject?: string }>,
  opts: { topN?: number; minCount?: number; existingKeywords?: string[] } = {},
) {
  const n = opts.topN ?? 20;
  const minCount = opts.minCount ?? 2;
  const covered = new Set((opts.existingKeywords ?? []).map((k) => k.toLowerCase().trim()).filter(Boolean));

  const domains = new Map<string, number>();
  const senders = new Map<string, number>();
  const terms = new Map<string, number>();

  for (const e of emails) {
    const d = domainOf(e.from || '');
    if (d) domains.set(d, (domains.get(d) ?? 0) + 1);
    const a = addressOf(e.from || '');
    if (a) senders.set(a, (senders.get(a) ?? 0) + 1);

    const tokens = (e.subject || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !KEYWORD_STOPWORDS.has(t));
    for (let i = 0; i < tokens.length; i++) {
      terms.set(tokens[i], (terms.get(tokens[i]) ?? 0) + 1);
      if (i + 1 < tokens.length) {
        const bigram = `${tokens[i]} ${tokens[i + 1]}`;
        terms.set(bigram, (terms.get(bigram) ?? 0) + 1);
      }
    }
  }

  const isCovered = (k: string) => covered.has(k.toLowerCase());
  const topDomains = topN(domains, (domain, count) => ({ domain, count, covered: isCovered(domain) }), n, minCount);
  const topSenders = topN(senders, (address, count) => ({ address, count, covered: isCovered(address) }), n, minCount);
  const subjectTerms = topN(terms, (term, count) => ({ term, count, covered: isCovered(term) }), n, minCount);

  // Suggested = the highest-signal not-yet-covered candidates (domains weighted first).
  const suggested = [
    ...topDomains.filter((d) => !d.covered).slice(0, 10).map((d) => d.domain),
    ...subjectTerms.filter((t) => !t.covered).slice(0, 10).map((t) => t.term),
  ];

  return { sampled: emails.length, topDomains, topSenders, subjectTerms, suggestedKeywords: [...new Set(suggested)] };
}

export function categoryTools(
  server: McpServer,
  imapService: ImapService,
  db: DatabaseService
): void {

  // Apply categories to emails in a folder
  server.registerTool('imap_apply_categories', {
    description: 'Apply Quick Categories to emails in a folder. Scans emails and moves them to target folders based on keyword matches. Default limit is 100 to prevent token overflow.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder to scan (default: INBOX)'),
      limit: z.number().optional().default(100).describe('Maximum number of emails to process (default: 100, max: 200)'),
      unreadOnly: z.boolean().optional().default(false).describe('Process only unread emails (Issue #82)'),
      dryRun: z.boolean().optional().default(false).describe('Dry run mode - show matches without moving emails')
    }
  }, withErrorHandling(async ({ accountId, folder, limit, unreadOnly, dryRun }) => {
    const { userId } = getToolContext(db);

    // Enforce maximum limit to prevent token overflow (Issue #85)
    const maxLimit = 200;
    const effectiveLimit = Math.min(limit || 100, maxLimit);

    // Get enabled categories for this account
    const categories = db.getEnabledCategoriesForAccount(userId, accountId);

    if (categories.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            message: 'No enabled categories found for this account. Create categories first in the Web UI.',
            processedEmails: 0,
            categorizedEmails: 0,
            categories: []
          }, null, 2)
        }]
      };
    }

    // Search for emails (optionally unread only) - Issue #82
    const searchCriteria = unreadOnly ? { unreadOnly: true } : {};
    let allEmails = await imapService.searchEmails(accountId, folder, searchCriteria);

    // Limit to most recent emails if needed
    let emails = allEmails;
    if (allEmails.length > effectiveLimit) {
      // Sort by UID descending (most recent first) and take limit
      emails = allEmails.sort((a, b) => b.uid - a.uid).slice(0, effectiveLimit);
    }

    // Build warnings
    const warnings = [];
    if (limit && limit > maxLimit) {
      warnings.push(`Requested limit ${limit} exceeds maximum ${maxLimit}. Processing ${maxLimit} emails to prevent token overflow.`);
    }
    if (allEmails.length > effectiveLimit) {
      warnings.push(`Found ${allEmails.length} emails in folder but processing only ${effectiveLimit} most recent. Use search criteria in imap_search_emails first to narrow results.`);
    }

    let processedCount = 0;
    let categorizedCount = 0;
    const categoryMatches: Record<string, number> = {};
    const moveOperations: Array<{
      uid: number;
      from: string;
      to: string;
      subject: string;
      matchedCategory: string;
      matchedKeyword: string;
    }> = [];

    // Process each email
    for (const email of emails) {
      processedCount++;

      // Check against each category
      for (const category of categories) {
        // Split keywords by comma or semicolon
        const keywords = category.keywords
          .split(/[,;]/)
          .map(k => k.trim().toLowerCase())
          .filter(k => k.length > 0);

        // Check if any keyword matches in from/subject (EmailMessage only has basic fields)
        const emailText = `${email.from || ''} ${email.subject || ''}`.toLowerCase();

        for (const keyword of keywords) {
          if (emailText.includes(keyword)) {
            // Match found!
            categorizedCount++;
            categoryMatches[category.category_name] = (categoryMatches[category.category_name] || 0) + 1;

            moveOperations.push({
              uid: email.uid,
              from: folder,
              to: category.target_folder,
              subject: email.subject || '(no subject)',
              matchedCategory: category.category_name,
              matchedKeyword: keyword
            });

            // Move email if not dry run
            if (!dryRun) {
              try {
                await imapService.moveEmail(accountId, folder, email.uid, category.target_folder);
                db.incrementCategoryMatch(category.category_id);
              } catch (error) {
                console.error(`Failed to move email ${email.uid}:`, error);
              }
            }

            // Break after first match (don't apply multiple categories to same email)
            break;
          }
        }
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          dryRun,
          processedEmails: processedCount,
          categorizedEmails: categorizedCount,
          categoryMatches,
          warnings: warnings.length > 0 ? warnings : undefined,
          moveOperations: dryRun ? moveOperations : undefined,
          message: dryRun
            ? `Dry run complete. Found ${categorizedCount} emails that would be categorized.`
            : `Categorization complete. Moved ${categorizedCount} emails to target folders.`
        }, null, 2)
      }]
    };
  }));

  // Test categorization without moving anything (#72)
  server.registerTool('imap_test_categories', {
    description:
      'Dry-run the Quick Categories against a folder WITHOUT moving any email: reports coverage (% that would ' +
      'be categorized), per-category counts + destination, which keyword triggered each match, emails matching ' +
      'multiple categories (conflicts), and the uncategorized set. Helps tune keywords ahead of imap_apply_categories.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder to test against (default: INBOX)'),
      limit: z.number().optional().default(200).describe('Max most-recent emails to test (default 200, cap 1000)'),
      unreadOnly: z.boolean().optional().default(false).describe('Test only unread emails'),
      sampleSize: z.number().optional().default(50).describe('Max rows to include in each sample list (default 50)'),
    }
  }, withErrorHandling(async ({ accountId, folder, limit, unreadOnly, sampleSize }) => {
    const { userId } = getToolContext(db);
    const categories = db.getEnabledCategoriesForAccount(userId, accountId);
    if (categories.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'No enabled categories for this account. Create categories first in the Web UI.' }, null, 2) }] };
    }

    const cap = Math.min(limit ?? 200, 1000);
    const all = await imapService.searchEmails(accountId, folder, unreadOnly ? { unreadOnly: true } : {});
    const emails = all.length > cap ? [...all].sort((a, b) => b.uid - a.uid).slice(0, cap) : all;

    const a = evaluateCategories(emails, categories as any);
    const n = Math.max(0, sampleSize ?? 50);
    const warnings: string[] = [];
    if (all.length > cap) warnings.push(`Folder has ${all.length} emails; tested the ${cap} most recent.`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          folder,
          summary: {
            tested: a.total,
            categorized: a.categorized,
            uncategorized: a.uncategorized,
            coveragePercent: a.coveragePercent,
            conflicts: a.conflicts,
          },
          perCategory: a.perCategory,
          // Capped samples to protect the token budget; counts above are complete.
          wouldMove: a.matched.slice(0, n).map((m) => ({ uid: m.uid, from: m.from, subject: m.subject, date: m.date, destination: m.destination, matchedKeyword: m.matchedKeyword, matchedCategory: m.matchedCategory, ...(m.allCategories.length > 1 ? { conflictsWith: m.allCategories } : {}) })),
          uncategorizedSample: a.uncategorizedList.slice(0, n).map((u) => ({ uid: u.uid, from: u.from, subject: u.subject, date: u.date })),
          warnings: warnings.length ? warnings : undefined,
          note: 'Dry run — no emails were moved.',
        }, null, 2)
      }]
    };
  }));

  // Recommend category keywords from a folder's mail (#73, data-for-Claude)
  server.registerTool('imap_recommend_keywords', {
    description:
      'Analyze a folder and return candidate category keywords for Claude to turn into recommendations: top ' +
      'sender domains, top senders, and frequent subject terms + bigrams — each flagged whether an existing ' +
      'category keyword already covers it. The server does no AI itself; it returns structured stats so the ' +
      'assistant can propose categories/keywords. Read-only.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder to analyze (default: INBOX)'),
      limit: z.number().optional().default(500).describe('Max most-recent emails to sample (default 500, cap 2000)'),
      topN: z.number().optional().default(20).describe('How many candidates to return per category (default 20)'),
      minCount: z.number().optional().default(2).describe('Ignore candidates seen fewer than this many times (default 2)'),
    }
  }, withErrorHandling(async ({ accountId, folder, limit, topN: topCount, minCount }) => {
    const { userId } = getToolContext(db);
    const cap = Math.min(limit ?? 500, 2000);
    const all = await imapService.searchEmails(accountId, folder, {});
    const emails = all.length > cap ? [...all].sort((a, b) => b.uid - a.uid).slice(0, cap) : all;

    // Existing keywords (across this account's categories) to flag coverage.
    const existingKeywords: string[] = [];
    try {
      for (const c of db.getEnabledCategoriesForAccount(userId, accountId) as any[]) {
        existingKeywords.push(...splitKeywords(c.keywords));
      }
    } catch { /* categories optional */ }

    const rec = recommendKeywords(emails, { topN: topCount ?? 20, minCount: minCount ?? 2, existingKeywords });
    const warnings = all.length > cap ? [`Folder has ${all.length} emails; analyzed the ${cap} most recent.`] : undefined;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          folder,
          ...rec,
          existingKeywordCount: existingKeywords.length,
          warnings,
          note: 'Candidates only — review and apply via the Web UI or imap_add_keyword. "covered" means an existing category keyword already matches.',
        }, null, 2)
      }]
    };
  }));

  // List categories for an account
  server.registerTool('imap_list_categories', {
    description: 'List all Quick Categories for a user, optionally filtered by account',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID to filter by (optional)'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    const { userId } = getToolContext(db);

    const categories = db.listCategoriesForUser(userId, accountId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          count: categories.length,
          categories: categories.map(cat => ({
            categoryId: cat.category_id,
            accountId: cat.account_id,
            categoryName: cat.category_name,
            keywords: cat.keywords,
            targetFolder: cat.target_folder,
            enabled: cat.enabled,
            matchCount: cat.match_count,
            lastMatched: cat.last_matched
          }))
        }, null, 2)
      }]
    };
  }));
}
