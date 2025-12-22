/**
 * Quick Categories Tools for IMAP MCP Pro
 *
 * Provides MCP tools for automatic email categorization and organization.
 * Issue #71: Quick Categories implementation
 *
 * Author: Colin Bitterfield
 * Email: colin@bitterfield.com
 * Date: 2025-12-22
 * Version: 0.1
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ImapService } from '../services/imap-service.js';
import { DatabaseService } from '../services/database-service.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { getToolContext } from './tool-context.js';

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
