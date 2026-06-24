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
      'multiple categories (conflicts), and the uncategorized set. Use to tune keywords before imap_apply_categories.',
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
