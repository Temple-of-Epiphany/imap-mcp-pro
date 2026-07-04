/**
 * Tool annotations — drives Claude Desktop's "Tool Permissions" UI.
 *
 * MCP tool annotations (per the MCP spec) carry hints that clients use
 * to group tools by side-effect category and to apply per-group default
 * policies. Claude Desktop's settings panel groups by:
 *   - Read-only tools          (readOnlyHint: true)
 *   - Write/delete tools       (destructiveHint: true)
 *   - Other / neutral          (no hint set)
 *
 * Conventions used in this table:
 *   - readOnlyHint: tool only reads server-side state; safe to call repeatedly
 *   - destructiveHint: tool modifies server-side state in a way users would
 *     want approval for (send, delete, move, write to mailbox, mutate config)
 *   - idempotentHint: repeated calls converge to the same state
 *   - openWorldHint: tool interacts with external systems (IMAP/SMTP servers,
 *     UserCheck API, DNS lookups). Helps clients reason about latency.
 *
 * NB: a tool can be both readOnly + openWorld (e.g. imap_search_emails:
 * reads remote mailbox without modifying it).
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Version: 0.1.0
 */

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Read-only hints for tools that only read state. Most don't mutate the
 *  remote IMAP server or local DB; the ones that hit IMAP/SMTP/etc. also
 *  carry openWorldHint:true. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
const READ_REMOTE: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

/** Destructive hints for tools that mutate state — local DB, remote
 *  mailbox flags, sent SMTP, etc. */
const WRITE_LOCAL: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };
const WRITE_REMOTE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** Connect/disconnect/reload: state changes (so not read-only) but not
 *  destructive of user data. Both hints are set explicitly (false) so every
 *  tool carries an applicable read-only/destructive hint per the directory. */
const NEUTRAL_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // ---- account-tools (8) ----
  'imap_add_account':                  WRITE_LOCAL,
  'imap_add_account_auto':             WRITE_LOCAL,
  'imap_add_account_with_provider':    WRITE_LOCAL,
  'imap_remove_account':               WRITE_LOCAL,
  'imap_list_accounts':                READ_ONLY,
  'imap_test_account':                 READ_ONLY,
  'imap_get_outbox_dir':               READ_ONLY,
  'imap_list_providers':               READ_ONLY,
  'imap_share_account':                WRITE_LOCAL,
  'imap_unshare_account':              WRITE_LOCAL,
  'imap_set_account_signature':        WRITE_LOCAL,
  'imap_get_account_signature':        READ_ONLY,

  // ---- email-tools — search/get/list (read-remote) ----
  'imap_search_emails':                READ_REMOTE,
  'imap_get_email':                    READ_REMOTE,
  'imap_get_latest_emails':            READ_REMOTE,
  'imap_get_email_sizes':              READ_REMOTE,
  'imap_get_largest_emails':           READ_REMOTE,
  'imap_get_email_priority':           READ_REMOTE,
  'imap_set_email_priority':           WRITE_REMOTE,
  'imap_get_quota':                    READ_REMOTE,
  'imap_export_email':                 READ_REMOTE,
  'imap_export_folder':                READ_REMOTE,
  'imap_export_account':               READ_REMOTE,
  'imap_extract_attachments':          READ_REMOTE,
  'imap_get_attachment':               READ_REMOTE,
  'imap_get_unsubscribe_links_for':    READ_REMOTE,
  'imap_get_unread_count':             READ_REMOTE,
  'imap_bulk_get_emails':              READ_REMOTE,
  'imap_bulk_get_emails_chunked':      READ_REMOTE,
  'imap_extract_unsubscribe_links':    READ_REMOTE,

  // ---- email-tools — write/destructive ----
  'imap_mark_as_read':                 WRITE_REMOTE,
  'imap_mark_as_unread':               WRITE_REMOTE,
  'imap_delete_email':                 WRITE_REMOTE,
  'imap_move_email':                   WRITE_REMOTE,
  'imap_copy_email':                   WRITE_REMOTE,
  'imap_send_email':                   WRITE_REMOTE,
  'imap_reply_to_email':               WRITE_REMOTE,
  'imap_forward_email':                WRITE_REMOTE,
  'imap_append_message':               WRITE_REMOTE,
  'imap_bulk_delete_emails':           WRITE_REMOTE,
  'imap_bulk_delete_emails_chunked':   WRITE_REMOTE,
  'imap_bulk_mark_emails':             WRITE_REMOTE,
  'imap_bulk_mark_emails_chunked':     WRITE_REMOTE,
  'imap_bulk_move_emails':             WRITE_REMOTE,
  'imap_bulk_copy_emails':             WRITE_REMOTE,

  // ---- email-tools — diagnostics + metrics (read) ----
  'imap_test_smtp':                    READ_REMOTE,
  'imap_test_sent_folder':             READ_REMOTE,
  'imap_get_smtp_metrics':             READ_ONLY,
  'imap_reset_smtp_metrics':           WRITE_LOCAL,
  'imap_list_unarchived_sends':        READ_ONLY,

  // ---- WP2 attachment staging (writes server-local state) ----
  'imap_attachment_stage_init':        WRITE_LOCAL,
  'imap_attachment_stage_append':      WRITE_LOCAL,
  'imap_attachment_stage_finalize':    WRITE_LOCAL,
  'imap_attachment_stage_cancel':      WRITE_LOCAL,
  'imap_list_staged_attachments':      READ_ONLY,

  // ---- v2.17.0 MVP cache (Issue #124) ----
  // sync_folder_cache: reads remote (IMAP) and writes local DB rows. Treat
  // as READ_REMOTE because the user-facing effect is "I'm reading these
  // messages" — the local cache is an implementation detail, not user state.
  'imap_sync_folder_cache':            READ_REMOTE,
  // search_cache: pure local DB read, no IMAP traffic.
  'imap_search_cache':                 READ_ONLY,

  // ---- v2.17.4 skill update from GitHub (#138) ----
  // check: read-only network call to raw.githubusercontent.com.
  'imap_check_skill_updates':          READ_REMOTE,
  // update: writes to ~/.claude/skills/imap-mcp-pro/{name}/ from GitHub.
  'imap_update_skills':                WRITE_LOCAL,

  // ---- folder-tools (6) ----
  'imap_list_folders':                 READ_REMOTE,
  'imap_folder_status':                READ_REMOTE,
  'imap_get_mailbox_status':           READ_REMOTE,
  'imap_create_folder':                WRITE_REMOTE,
  'imap_delete_folder':                WRITE_REMOTE,
  'imap_rename_folder':                WRITE_REMOTE,

  // ---- admin-tools (1) ----
  'imap_server_reload':                NEUTRAL_IDEMPOTENT,

  // ---- address-list-tools (6) ----
  'imap_add_list_entry':               WRITE_LOCAL,
  'imap_remove_list_entry':            WRITE_LOCAL,
  'imap_list_entries':                 READ_ONLY,
  'imap_check_address':                READ_ONLY,
  'imap_import_list':                  WRITE_LOCAL,
  'imap_clear_list':                   WRITE_LOCAL,

  // ---- bulk-job-tools (3) ----
  'imap_bulk_jobs':                    READ_ONLY,
  'imap_bulk_job_status':              READ_ONLY,
  'imap_bulk_job_cancel':              WRITE_LOCAL,
  'imap_bulk_job_resume':              READ_REMOTE,
  'imap_scan_account_spam_start':      READ_REMOTE,
  'imap_check_emails_spam_bulk_start': READ_REMOTE,

  // ---- meta-tools (8) ----
  'imap_about':                        READ_ONLY,
  'imap_list_tools':                   READ_ONLY,
  'imap_help':                         READ_ONLY,
  'imap_open_web_ui':                  WRITE_LOCAL,
  'imap_connect':                      NEUTRAL_IDEMPOTENT,
  'imap_disconnect':                   NEUTRAL_IDEMPOTENT,
  'imap_get_metrics':                  READ_ONLY,
  'imap_get_operation_metrics':        READ_ONLY,
  'imap_reset_metrics':                WRITE_LOCAL,
  'imap_get_circuit_breaker':          READ_ONLY,
  'imap_reset_circuit_breaker':        WRITE_LOCAL,

  // ---- capability-tools (1) ----
  'imap_get_capabilities':             READ_REMOTE,

  // ---- category-tools (5) ----
  'imap_list_categories':              READ_ONLY,
  'imap_test_categories':              READ_REMOTE,         // dry-run analysis, no moves
  'imap_recommend_keywords':           READ_REMOTE,         // folder analysis, no moves
  'imap_apply_categories':             WRITE_REMOTE,        // sets keyword flags on messages
  'imap_add_keyword':                  WRITE_REMOTE,
  'imap_remove_keyword':               WRITE_REMOTE,
  'imap_analyze_folder_confidence':    READ_REMOTE,

  // ---- result-tools (1, mixed actions) ----
  // get/list are read; delete/persist are write. Treat as not-read-only
  // so the user defaults to "needs approval" — safer for the destructive
  // sub-actions.
  'imap_results':                      WRITE_LOCAL,

  // ---- scoring-tools (2) ----
  'imap_score_email_confidence':       READ_REMOTE,
  'imap_bulk_score_emails':            READ_REMOTE,

  // ---- subscription-tools (10) ----
  'imap_get_subscription_summary':     READ_ONLY,
  'imap_list_subscribed_mailboxes':    READ_REMOTE,
  'imap_subscribe_mailbox':            WRITE_REMOTE,
  'imap_unsubscribe_mailbox':          WRITE_REMOTE,
  'imap_list_unsubscribe_candidates':  READ_ONLY,
  'imap_mark_subscription_unsubscribed': WRITE_LOCAL,
  'imap_update_subscription_category': WRITE_LOCAL,
  'imap_update_subscription_notes':    WRITE_LOCAL,
  'imap_get_unsubscribe_links':        READ_ONLY,
  'imap_execute_unsubscribe':          WRITE_REMOTE,        // hits external HTTP/mailto

  // ---- user-tools (3) ----
  'imap_create_user':                  WRITE_LOCAL,
  'imap_get_user':                     READ_ONLY,
  'imap_list_users':                   READ_ONLY,

  // ---- usercheck-tools (7) ----
  'imap_add_usercheck_key':            WRITE_LOCAL,
  'imap_get_usercheck_key':            READ_ONLY,
  'imap_delete_usercheck_key':         WRITE_LOCAL,
  'imap_check_email_spam':             READ_REMOTE,
  'imap_check_emails_spam_bulk':       READ_REMOTE,
  'imap_check_folder_spam':            READ_REMOTE,
  'imap_scan_account_spam':            READ_REMOTE,

  // ---- dns-firewall-tools (6) ----
  'imap_check_domain':                 READ_REMOTE,
  'imap_bulk_check_domains':           READ_REMOTE,
  'imap_check_domain_dns_firewall':    READ_REMOTE,
  'imap_scan_message_domains':         READ_REMOTE,
  'imap_bulk_scan_messages':           READ_REMOTE,
  'imap_test_quad9_dns':               READ_REMOTE,
};

/**
 * Heuristic fallback for a tool name we forgot to register above.
 * Keeps the worst-case policy (treat as destructive — needs approval)
 * unless the name clearly maps to a read-only verb prefix.
 */
function fallbackFromName(name: string): ToolAnnotations {
  const n = name.replace(/^imap_/, '').toLowerCase();
  const READ_VERBS = ['get_', 'list_', 'search_', 'check_', 'scan_', 'test_', 'analyze_', 'score_', 'about'];
  if (READ_VERBS.some(v => n.startsWith(v))) return READ_ONLY;
  // Default to "destructive" so unknown tools land in "Write/delete" group.
  return WRITE_LOCAL;
}

export function getAnnotations(toolName: string): ToolAnnotations {
  return TOOL_ANNOTATIONS[toolName] ?? fallbackFromName(toolName);
}

// Acronyms/proper-nouns to preserve when title-casing a tool name.
const TITLE_ACRONYMS: Record<string, string> = {
  imap: 'IMAP', smtp: 'SMTP', dns: 'DNS', uid: 'UID', url: 'URL', eml: 'EML', ui: 'UI',
  id: 'ID', ip: 'IP', mx: 'MX', tls: 'TLS', quad9: 'Quad9', usercheck: 'UserCheck',
  fts: 'FTS', csv: 'CSV', vcf: 'VCF', api: 'API', rfc9051: 'RFC 9051',
};

/**
 * Human-readable display title derived from a tool name — required for the
 * Anthropic directory ("all tools must include a title"). e.g.
 * `imap_search_emails` → "Search Emails", `imap_get_smtp_metrics` → "Get SMTP
 * Metrics". A tool may still override this by passing its own `title`.
 */
export function titleFromName(name: string): string {
  return name
    .replace(/^imap_/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => TITLE_ACRONYMS[w] ?? (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
