// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// tool-catalog.ts — the live catalog of registered MCP tools (#302).
//
// `imap_list_tools` used to carry a hand-written array that drifted to 41 of
// 131 tools. The registerTool wrapper in ./index.ts now records every tool it
// registers (name, title, description, parameter names, annotation hints) and
// this module assigns a category from one rule table that
// scripts/gen-tool-catalog.mjs (docs/TOOL_CATALOG.md) also uses, so the
// in-server listing and the published catalog can never disagree.

export interface ToolCatalogCategory {
  /** Stable slug used for the `category` filter argument. */
  slug: string;
  /** Human label used in docs/TOOL_CATALOG.md. */
  label: string;
  match: RegExp;
}

// Ordered: first match wins. Keep specific patterns ahead of broad ones.
export const TOOL_CATEGORIES: readonly ToolCatalogCategory[] = [
  { slug: 'user',          label: 'Users (MSP multi-tenant)',              match: /^imap_(create_user|get_user|list_users)$/ },
  { slug: 'account',       label: 'Account management',                    match: /^imap_(add_account|add_account_auto|add_account_with_provider|remove_account|list_accounts|connect|disconnect|test_account|share_account|unshare_account|list_providers|set_account_signature|get_account_signature|db_add_account|db_get_account|db_list_accounts|db_remove_account)$/ },
  { slug: 'bulk',          label: 'Bulk operations',                       match: /^imap_bulk_/ },
  { slug: 'export',        label: 'Size, export & quota',                  match: /^imap_(get_email_sizes|get_largest_emails|export_email|export_folder|export_account|extract_attachments|get_attachment|get_quota)$/ },
  { slug: 'staging',       label: 'Attachment staging',                    match: /^imap_(attachment_stage_|list_staged_attachments|get_outbox_dir)/ },
  { slug: 'email',         label: 'Email operations',                      match: /^imap_(search_emails|get_email|get_latest_emails|mark_as_read|mark_as_unread|delete_email|copy_email|move_email|send_email|reply_to_email|forward_email|get_email_priority|set_email_priority)$/ },
  { slug: 'folder',        label: 'Folder & mailbox operations',           match: /^imap_(list_folders|folder_status|get_unread_count|create_folder|delete_folder|rename_folder|get_mailbox_status|subscribe_mailbox|unsubscribe_mailbox|list_subscribed_mailboxes|append_message)$/ },
  { slug: 'subscriptions', label: 'Subscriptions & unsubscribe',           match: /^imap_(extract_unsubscribe_links|get_unsubscribe_links|get_unsubscribe_links_for|execute_unsubscribe|get_subscription_summary|list_unsubscribe_candidates|mark_subscription_unsubscribed|update_subscription_category|update_subscription_notes)$/ },
  { slug: 'categorization',label: 'Categorization & scoring',              match: /^imap_(add_keyword|remove_keyword|list_categories|apply_categories|test_categories|recommend_keywords|analyze_folder_confidence|score_email_confidence)$/ },
  { slug: 'spam',          label: 'Spam & UserCheck',                      match: /^imap_(check_email_spam|check_emails_spam_bulk|check_emails_spam_bulk_start|check_folder_spam|scan_account_spam|scan_account_spam_start|scan_messages_spam|add_usercheck_key|get_usercheck_key|delete_usercheck_key)$/ },
  { slug: 'dns',           label: 'DNS firewall & domain checks',          match: /^imap_(check_domain|check_domain_dns_firewall|scan_message_domains|test_quad9_dns)$/ },
  { slug: 'lists',         label: 'Allow/deny lists',                      match: /^imap_(add_list_entry|remove_list_entry|list_entries|check_address|import_list|clear_list)$/ },
  { slug: 'cache',         label: 'Local cache',                           match: /^imap_(search_cache|sync_folder_cache)$/ },
  { slug: 'diagnostics',   label: 'Capabilities, diagnostics & metrics',   match: /^imap_(get_capabilities|test_smtp|test_sent_folder|list_unarchived_sends|get_metrics|get_operation_metrics|reset_metrics|get_smtp_metrics|reset_smtp_metrics|get_circuit_breaker|reset_circuit_breaker)$/ },
  { slug: 'meta',          label: 'Meta & discovery',                      match: /^imap_(about|list_tools|help|check_skill_updates|update_skills|results)$/ },
  { slug: 'admin',         label: 'Admin & lifecycle',                     match: /^imap_(server_reload|open_web_ui)$/ },
];

export const OTHER_CATEGORY: ToolCatalogCategory = { slug: 'other', label: 'Other', match: /$^/ };

export function categoryFor(toolName: string): ToolCatalogCategory {
  return TOOL_CATEGORIES.find(c => c.match.test(toolName)) ?? OTHER_CATEGORY;
}

export interface ToolRecord {
  name: string;
  title: string;
  description: string;
  category: string;
  categoryLabel: string;
  /** Top-level input parameter names, from the registered Zod shape. */
  parameters: string[];
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

let catalog: ToolRecord[] = [];

/** @internal called by the registerTool wrapper at the start of each registration pass. */
export function resetToolCatalog(): void { catalog = []; }

/** @internal called by the registerTool wrapper for every tool that reaches the SDK. */
export function recordTool(name: string, config: any): void {
  const cat = categoryFor(name);
  const shape = config?.inputSchema?.shape ?? config?.inputSchema ?? {};
  const parameters = shape && typeof shape === 'object' ? Object.keys(shape) : [];
  const a = config?.annotations ?? {};
  catalog.push({
    name,
    title: String(config?.title ?? a.title ?? name),
    description: String(config?.description ?? ''),
    category: cat.slug,
    categoryLabel: cat.label,
    parameters,
    readOnly: a.readOnlyHint === true,
    destructive: a.destructiveHint === true,
    openWorld: a.openWorldHint === true,
  });
}

/** Tools registered in the most recent registerTools() pass, in registration order. */
export function getToolCatalog(): ToolRecord[] {
  return catalog.map(t => ({ ...t, parameters: [...t.parameters] }));
}
