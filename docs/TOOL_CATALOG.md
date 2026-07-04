# Tool Catalog

> **Generated file — do not edit by hand.** Produced from the live tool
> manifest by `scripts/gen-tool-catalog.mjs` (runs on `npm run build`).
> The authoritative runtime list is always available via the `imap_list_tools` tool.

**129 MCP tools** total.

## Categories

- [Users (MSP multi-tenant)](#users-msp-multitenant) — 3
- [Account management](#account-management) — 17
- [Bulk operations](#bulk-operations) — 15
- [Size, export & quota](#size-export-quota) — 8
- [Attachment staging](#attachment-staging) — 6
- [Email operations](#email-operations) — 13
- [Folder & mailbox operations](#folder-mailbox-operations) — 11
- [Subscriptions & unsubscribe](#subscriptions-unsubscribe) — 9
- [Categorization & scoring](#categorization-scoring) — 8
- [Spam & UserCheck](#spam-usercheck) — 9
- [DNS firewall & domain checks](#dns-firewall-domain-checks) — 4
- [Allow/deny lists](#allowdeny-lists) — 6
- [Local cache](#local-cache) — 2
- [Capabilities, diagnostics & metrics](#capabilities-diagnostics-metrics) — 11
- [Meta & discovery](#meta-discovery) — 6
- [Admin & lifecycle](#admin-lifecycle) — 1

## Users (MSP multi-tenant)

| Tool | Description |
| --- | --- |
| `imap_create_user` | Create a new user (MSP multi-tenant support) |
| `imap_get_user` | Get user details by username |
| `imap_list_users` | List all active users |

## Account management

| Tool | Description |
| --- | --- |
| `imap_add_account` | Add a new IMAP account with optional SMTP configuration for current user (from MCP_USER_ID environment variable) |
| `imap_add_account_auto` | Add a new IMAP account by auto-detecting provider from email address (e.g., @gmail.com → Gmail preset) |
| `imap_add_account_with_provider` | Add a new IMAP account using a provider preset (auto-fills IMAP/SMTP settings). |
| `imap_connect` | Connect to an IMAP account |
| `imap_db_add_account` | Add IMAP account to database (with encryption at rest) |
| `imap_db_get_account` | Get decrypted account details |
| `imap_db_list_accounts` | List all IMAP accounts for a user |
| `imap_db_remove_account` | Remove IMAP account from database |
| `imap_disconnect` | Disconnect from an IMAP account |
| `imap_get_account_signature` | Get the per-account email signature (plain text + HTML). |
| `imap_list_accounts` | List all IMAP accounts for current user (from MCP_USER_ID environment variable) |
| `imap_list_providers` | List all available email provider presets (Gmail, Outlook, Yahoo, etc.) with pre-configured IMAP/SMTP settings |
| `imap_remove_account` | Remove an IMAP account from database |
| `imap_set_account_signature` | Set the per-account email signature appended to outgoing messages (plain text and/or HTML). |
| `imap_share_account` | Share an account with another user (MSP feature) |
| `imap_test_account` | Test an existing account's IMAP connectivity using its stored credentials. |
| `imap_unshare_account` | Revoke account access from a user |

## Bulk operations

| Tool | Description |
| --- | --- |
| `imap_bulk_check_domains` | Check multiple domains against DNS firewall in bulk |
| `imap_bulk_copy_emails` | Bulk copy multiple emails to another folder |
| `imap_bulk_delete_emails` | Bulk delete multiple emails by UIDs. |
| `imap_bulk_delete_emails_chunked` | Bulk delete emails with chunking for large operations (1000+ messages). |
| `imap_bulk_get_emails` | Bulk fetch multiple emails at once. |
| `imap_bulk_get_emails_chunked` | Bulk fetch emails with chunking for large operations (1000+ messages). |
| `imap_bulk_job_cancel` | Request cancellation of a running/queued bulk job. |
| `imap_bulk_job_resume` | Resume a paused, failed, or cancelled bulk job from where it stopped — only unprocessed items are run (already-checked senders are skipped). |
| `imap_bulk_job_status` | Get one bulk job's detail: status, done/total progress, error count, ETA, and last error. |
| `imap_bulk_jobs` | List persistent bulk-operation jobs (long-running scans) with status and progress. |
| `imap_bulk_mark_emails` | Bulk mark multiple emails with standard IMAP flags. |
| `imap_bulk_mark_emails_chunked` | Bulk mark emails with chunking for large operations (1000+ messages). |
| `imap_bulk_move_emails` | Bulk move multiple emails to another folder (copy + delete) |
| `imap_bulk_scan_messages` | Scan multiple messages for malicious domains and optionally auto-mark as spam |
| `imap_bulk_score_emails` | Analyze multiple emails for spoofing detection. |

## Size, export & quota

| Tool | Description |
| --- | --- |
| `imap_export_account` | Export the entire account to .eml files, mirroring the full mailbox folder structure under exports/[subfolder]/. |
| `imap_export_email` | Export one or more messages to standard .eml files on the server host (download & save). |
| `imap_export_folder` | Export all messages in a folder to standard .eml files on the server host, mirroring the folder hierarchy under the per-user outbox (exports/[subfolder]/{folder path}/). |
| `imap_extract_attachments` | Extract file attachments from a block of messages and save them to disk under the per-user outbox (exports/attachments/[subfolder]/). |
| `imap_get_attachment` | Fetch a single attachment from a message for preview or download. |
| `imap_get_email_sizes` | List messages by size to find large emails — uses RFC822.SIZE (no body download, cheap even on big folders). |
| `imap_get_largest_emails` | Find the largest emails across several folders at once (default: just INBOX) and return the global top-N. |
| `imap_get_quota` | Report account storage quota — used / limit / percent — via the IMAP QUOTA extension (RFC 9208). |

## Attachment staging

| Tool | Description |
| --- | --- |
| `imap_attachment_stage_append` | Append one chunk to a staging session. |
| `imap_attachment_stage_cancel` | Discard a staging session and reclaim its disk space. |
| `imap_attachment_stage_finalize` | Concatenate the uploaded chunks in order, compute SHA-256, mark the session ready for use in imap_send_email via stagedAttachmentIds. |
| `imap_attachment_stage_init` | Begin a chunked attachment upload. |
| `imap_get_outbox_dir` | Return the per-user attachment outbox directory path. |
| `imap_list_staged_attachments` | List staging sessions for the current user (or all users if no userId is provided and the caller is admin context). |

## Email operations

| Tool | Description |
| --- | --- |
| `imap_copy_email` | Copy an email to another folder |
| `imap_delete_email` | Delete an email (moves to trash or expunges) |
| `imap_forward_email` | Forward an existing email |
| `imap_get_email` | Get the full content of an email (or just headers). |
| `imap_get_email_priority` | Get the resolved priority of a message: our $Priority-* keyword if set (the explicit user setting), otherwise the compose-time X-Priority / Importance / X-MSMail-Priority header, otherwise normal. |
| `imap_get_latest_emails` | Get the latest emails from a folder. |
| `imap_mark_as_read` | Mark an email as read |
| `imap_mark_as_unread` | Mark an email as unread |
| `imap_move_email` | Move an email to another folder (copy + delete) |
| `imap_reply_to_email` | Reply to an existing email |
| `imap_search_emails` | Search for emails in a folder. |
| `imap_send_email` | Send an email via SMTP and (by default) append the message to the IMAP Sent folder. |
| `imap_set_email_priority` | Set the priority (high / normal / low) of one or more messages. |

## Folder & mailbox operations

| Tool | Description |
| --- | --- |
| `imap_append_message` | Append a raw RFC822 message to a mailbox (useful for importing emails, saving drafts, or copying messages) |
| `imap_create_folder` | Create a new folder/mailbox in an IMAP account |
| `imap_delete_folder` | Delete a folder/mailbox from an IMAP account |
| `imap_folder_status` | Get status information about a folder |
| `imap_get_mailbox_status` | Get mailbox statistics without selecting it (RFC 9051 STATUS command) - more efficient than SELECT |
| `imap_get_unread_count` | Get the count of unread emails in specified folders |
| `imap_list_folders` | List all folders/mailboxes in an IMAP account |
| `imap_list_subscribed_mailboxes` | List all subscribed mailboxes (RFC 9051 LSUB/LIST with SUBSCRIBED) |
| `imap_rename_folder` | Rename a folder/mailbox in an IMAP account |
| `imap_subscribe_mailbox` | Subscribe to a mailbox (RFC 9051 SUBSCRIBE command) |
| `imap_unsubscribe_mailbox` | Unsubscribe from a mailbox (RFC 9051 UNSUBSCRIBE command) |

## Subscriptions & unsubscribe

| Tool | Description |
| --- | --- |
| `imap_execute_unsubscribe` | Execute unsubscribe request for one or more senders. |
| `imap_extract_unsubscribe_links` | Scan a folder for unsubscribe links and store them for subscription management. |
| `imap_get_subscription_summary` | Get aggregated subscription summary. |
| `imap_get_unsubscribe_links` | Get all extracted unsubscribe links from emails. |
| `imap_get_unsubscribe_links_for` | Read-only: for a block of messages (explicit UIDs, or a folder scan up to `limit`), return per message the unsubscribe links found in BOTH the List-Unsubscribe header and the body, along with sender, recipient, and subject. |
| `imap_list_unsubscribe_candidates` | List all subscriptions with unsubscribe links. |
| `imap_mark_subscription_unsubscribed` | Mark a sender as unsubscribed in the database. |
| `imap_update_subscription_category` | Update the category of a subscription (marketing, newsletter, promotional, transactional, other). |
| `imap_update_subscription_notes` | Add or update notes for a subscription. |

## Categorization & scoring

| Tool | Description |
| --- | --- |
| `imap_add_keyword` | Add a custom keyword to emails. |
| `imap_analyze_folder_confidence` | Analyze all emails in a folder and provide confidence statistics. |
| `imap_apply_categories` | Apply Quick Categories to emails in a folder. |
| `imap_list_categories` | List all Quick Categories for a user, optionally filtered by account |
| `imap_recommend_keywords` | Analyze a folder and return candidate category keywords for Claude to turn into recommendations: top sender domains, top senders, and frequent subject terms + bigrams — each flagged whether an existing category keyword already covers it. |
| `imap_remove_keyword` | Remove a custom keyword from emails |
| `imap_score_email_confidence` | Analyze email headers to detect spoofing and calculate confidence score (-100 to +100). |
| `imap_test_categories` | Dry-run the Quick Categories against a folder WITHOUT moving any email: reports coverage (% that would be categorized), per-category counts + destination, which keyword triggered each match, emails matching multiple categories (conflicts),  |

## Spam & UserCheck

| Tool | Description |
| --- | --- |
| `imap_add_usercheck_key` | Add a UserCheck API key for a user (admin or own user only) |
| `imap_check_email_spam` | Check a single email address against UserCheck for spam |
| `imap_check_emails_spam_bulk` | Check multiple email addresses against UserCheck for spam (max 1000) |
| `imap_check_emails_spam_bulk_start` | Start a resumable bulk spam check of a list of email addresses (UserCheck) as a tracked job. |
| `imap_check_folder_spam` | Check all emails in a folder against UserCheck and return spam messages |
| `imap_delete_usercheck_key` | Delete a UserCheck API key |
| `imap_get_usercheck_key` | Get UserCheck API key information for a user |
| `imap_scan_account_spam` | Scan entire IMAP account for spam using UserCheck, checking all folders |
| `imap_scan_account_spam_start` | Start a resumable account-wide spam scan (UserCheck) as a tracked job. |

## DNS firewall & domain checks

| Tool | Description |
| --- | --- |
| `imap_check_domain` | Check a domain against UserCheck for spam/validity |
| `imap_check_domain_dns_firewall` | Check if a domain is blocked by DNS firewall (Quad9 threat intelligence) |
| `imap_scan_message_domains` | Extract and validate all domains from an email message against DNS firewall |
| `imap_test_quad9_dns` | Verify Quad9 DNS threat-blocking is active. |

## Allow/deny lists

| Tool | Description |
| --- | --- |
| `imap_add_list_entry` | Add an entry to a per-user allow or deny list. |
| `imap_check_address` | Check a sender (a plain address, or a full From header with display name) against the user's allow/deny lists. |
| `imap_clear_list` | Remove ALL entries from a user's allow or deny list. |
| `imap_import_list` | Bulk-import addresses into an allow/deny list from CSV or vCard (.vcf — including Apple Contacts exports). |
| `imap_list_entries` | List a user's allow/deny entries (optionally filtered to one list). |
| `imap_remove_list_entry` | Remove an entry from a per-user allow or deny list (matches the normalized value). |

## Local cache

| Tool | Description |
| --- | --- |
| `imap_search_cache` | Fast SQL-backed search against the local header cache. |
| `imap_sync_folder_cache` | Populate the local message header cache for one folder. |

## Capabilities, diagnostics & metrics

| Tool | Description |
| --- | --- |
| `imap_get_capabilities` | Query IMAP server capabilities and supported extensions (RFC 9051 CAPABILITY command) |
| `imap_get_circuit_breaker` | Inspect the per-account circuit breaker state (CLOSED / OPEN / HALF_OPEN), failure count, last failure reason, and configured thresholds/timeout. |
| `imap_get_metrics` | Get connection metrics and health information for an account |
| `imap_get_operation_metrics` | Get detailed metrics for IMAP operations |
| `imap_get_smtp_metrics` | Get per-account SMTP metrics: send total, success/failure counts, retry counts (split by error category), last-send duration and timestamp, last error info. |
| `imap_list_unarchived_sends` | List queued Sent-folder APPEND operations that failed after a successful SMTP send. |
| `imap_reset_circuit_breaker` | Manually reset the circuit breaker for an account back to CLOSED with zero failure count. |
| `imap_reset_metrics` | Reset connection metrics for an account |
| `imap_reset_smtp_metrics` | Reset SMTP metrics for an account (or all accounts if omitted). |
| `imap_test_sent_folder` | Diagnose Sent folder resolution for an account. |
| `imap_test_smtp` | Probe SMTP connectivity for an account without sending. |

## Meta & discovery

| Tool | Description |
| --- | --- |
| `imap_about` | Get comprehensive information about the IMAP MCP Pro service including version, features, and capabilities |
| `imap_check_skill_updates` | Check public GitHub for newer skill versions without changing anything on disk. |
| `imap_help` | Show IMAP MCP Pro capabilities and copy-paste workflow recipes, by category. |
| `imap_list_tools` | List all available MCP tools with descriptions and parameters |
| `imap_results` | Manage cached MCP tool results (resource-handle pattern). |
| `imap_update_skills` | Apply skill updates from public GitHub for explicitly named skills. |

## Admin & lifecycle

| Tool | Description |
| --- | --- |
| `imap_server_reload` | Reset the server's runtime state without restarting Claude Desktop: close pooled IMAP and SMTP connections and clear the in-memory IMAP capabilities cache. |

