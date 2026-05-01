---
name: unsubscribe-cleanup
version: "0.1.1"
description: "Find and execute newsletter unsubscribes safely using imap-mcp-pro. Enumerates senders ranked by message count, filters to genuine bulk-mail (List-Unsubscribe header present, never replied to), presents candidates for user confirmation, and executes selected unsubscribes via the existing imap_execute_unsubscribe pipeline. Use when the user wants to reduce newsletter clutter, stop receiving promotional mail, or clean up subscription noise."
date_created: 2026-04-30
date_updated: 2026-05-01
---

# Unsubscribe Cleanup

## Overview

This skill drives a safe, user-confirmed newsletter cleanup workflow against a single IMAP account using the `imap-mcp-pro` MCP server. It's designed for the daily-pain case where an inbox accumulates hundreds of newsletter senders and the user wants to reduce clutter without accidentally unsubscribing from anything important.

The skill does **not** auto-execute. Every unsubscribe is explicitly confirmed by the user. The workflow is read-heavy (cache enumeration), mutation-light (only the chosen unsubscribes fire). It never deletes existing messages from the unsubscribed sender — unsubscribing only stops *future* mail.

## When to Use

**User phrases that trigger this skill:**

- "clean up newsletters"
- "unsubscribe from spam"
- "stop these promotional emails"
- "reduce newsletter clutter"
- "find newsletters I never read"

**Don't use this skill when:**

- The user wants to *delete* existing messages (use `imap_bulk_delete_emails` directly)
- The user wants to triage critical-vs-noise mail (defer to `email-triage` skill once available)
- The user wants to search or research correspondence (defer to `correspondence-research` skill)

## Required MCP Tools

This skill depends on the `imap-mcp-pro` MCP server being installed and connected. Required tools:

**Cache primitives (imap-mcp-pro v2.17.0+):**
- `imap_sync_folder_cache` — populate the local cache for a folder
- `imap_search_cache` — fast SQL-backed search; modes include `group_by_sender`, `by_domain`, `by_address`

**Unsubscribe primitives (imap-mcp-pro PR #45+):**
- `imap_list_unsubscribe_candidates` — read-only candidate list with subscription metadata
- `imap_get_unsubscribe_links` — extract URLs/mailtos from a specific message
- `imap_execute_unsubscribe` — fire the unsubscribe action (HTTP GET, POST, or mailto)
- `imap_mark_subscription_unsubscribed` — record the action in the local subscription DB

**Account discovery:**
- `imap_list_accounts` — confirm the target account exists

If any required tool is missing, stop and tell the user the MCP server needs upgrading to v2.17.0 or later.

## Asking the user questions

**Always use plain Markdown** — numbered lists, prose, fenced lists. **NEVER use `<ask_user_input_v0>`, `ask_user_choice`, `ChoicePrompt`, or any other tool-call XML tag** when interacting with the user.

Why: those tags render as a structured chooser only inside the **claude.ai** web app. In **Claude Desktop** (where this MCP's users actually run), they emit as raw XML in chat — looks broken, confuses the user, and blocks the workflow.

**Wrong** — would render as raw `<ask_user_input_v0>...</ask_user_input_v0>` text in Claude Desktop:

```
<ask_user_input_v0>
  <questions>[{"question":"Pick one","options":["A","B"],"type":"single_select"}]</questions>
</ask_user_input_v0>
```

**Right** — plain Markdown, works everywhere:

```markdown
Two things I need from you before proceeding:

1. **Which to unsubscribe?** Reply with numbers ("1, 3, 5"), a sender name, or "all but #4".
2. **Default deletion behavior?** Type one: `Trash`, `Archive`, or `skip` (only unsubscribe, leave existing messages alone).
```

If the user has already stated a preference earlier in the conversation, just proceed without re-asking.

## Workflow

### Step 1 — Confirm scope

Ask the user (or infer from context):

1. **Account** — which IMAP account? Use `imap_list_accounts` to show options if unclear. Default to the user's primary account.
2. **Folder** — see "Folder selection" below; the right default depends on the provider.
3. **Date range** — default last 90 days. The user might say "last 6 months" or "all of 2025" — convert to a since-date.

#### Folder selection

| Provider (host contains) | Recommended folder | Why |
|---|---|---|
| `gmail.com` / `googlemail.com` / `imap.gmail.com` | **`[Gmail]/All Mail`** | Gmail's tabbed inbox (Primary / Promotions / Updates / Forums / Social) hides newsletters from the IMAP `INBOX` view — Promotions/Updates messages are filtered out. `INBOX` typically shows *only* the Primary tab via IMAP, so scanning it misses 90%+ of newsletters. `[Gmail]/All Mail` covers everything but is slower (10K+ messages typical). |
| Outlook / Office 365 / iCloud / Hostinger / others | **`INBOX`** | These providers don't filter newsletters out of IMAP `INBOX`. |
| User-specified | what they said | Honor explicit instructions. |

**Do not** operate on `Sent`, `Trash`, `Junk`, or `_Pending_Cleanup`.

**Detection** — call `imap_list_accounts`, inspect each account's `host` field:
- `imap.gmail.com` or anything matching `(gmail|googlemail)\.com$` → Gmail
- otherwise → standard `INBOX`

If you're scanning a Gmail account's `INBOX` and the result has fewer than ~10 senders, **explicitly tell the user** the inbox looked nearly empty because Gmail tabs aren't IMAP folders, and offer to retry against `[Gmail]/All Mail`.

Confirm scope back to the user in one sentence before proceeding: *"I'll look at INBOX in your Gmail account for newsletters received in the last 90 days."*

### Step 2 — Sync the folder cache

```
imap_sync_folder_cache accountId="<id>" folder="INBOX"
```

This populates the local SQLite cache with header data. First run on a 5–10K-message folder takes 30–60 seconds. Subsequent runs are incremental (typically < 5 seconds).

If the sync fails or times out, report the error and stop — don't try to proceed without the cache.

### Step 3 — Enumerate sender candidates

```
imap_search_cache accountId="<id>" folder="INBOX" mode="group_by_sender" since="90d" limit=50
```

Returns rows like:
```
{ from_address, from_domain, from_name, count, last_seen, list_unsubscribe_present }
```

### Step 4 — Filter to high-confidence newsletter candidates

Apply these filters to the result:

1. `list_unsubscribe_present = true` — sender self-declared as bulk mail (RFC 2369). Highest-confidence signal.
2. `count >= 3` — at least 3 messages in the date range. One-offs aren't newsletters.
3. **(Optional)** Exclude senders the user has replied to. Cross-check against the Sent folder if cached (out of scope for v0.1; defer to a future enhancement).

If the filter yields fewer than 5 candidates, broaden the date range and retry once. If still empty, report "no newsletter candidates found" and stop.

### Step 5 — Present top 20 candidates

Render as a numbered list. For each:

- Sender name + address
- Message count in range
- Subject of most recent message (call `imap_search_cache` per-sender if needed)
- Subscription status from the local DB (use `imap_list_unsubscribe_candidates` to enrich)

Format:
```
 1. Promo Daily <noreply@promodaily.com>
    23 messages · last: "20% Off Everything Today!" (Apr 28)
    Status: not previously unsubscribed

 2. The Verge Newsletter <newsletter@theverge.com>
    18 messages · last: "Today in tech" (Apr 30)
    Status: previously unsubscribed (still receiving — link may have expired)

 ...
```

### Step 6 — Get user selections

Ask the user to pick which to unsubscribe — by number, by sender name, or "all but #X." Never assume "do everything." If the user says "all 20," **explicitly confirm** before proceeding: *"That's 20 unsubscribes. Confirm before I proceed?"*

### Step 7 — Execute with safety throttle

For each selected sender:

1. Get a representative message UID from cached results
2. `imap_get_unsubscribe_links uid=<uid>` — extract the unsubscribe URL/mailto
3. `imap_execute_unsubscribe` with the link — fire the action
4. `imap_mark_subscription_unsubscribed` — record locally
5. Report per-sender outcome inline: ✓ success, ✗ failed (with reason), ⚠ partial (e.g., mailto sent but unclear if processed)

**Safety throttle:** if the user selected more than 5 unsubscribes, pause every 5 and ask: *"5 done so far. Continue with the next 5?"* This prevents runaway execution and gives the user a chance to bail if outcomes look wrong.

### Step 8 — Final summary

Report the outcome:

```
Unsubscribe summary for INBOX (Gmail):
  ✓ Successful: 4 senders
  ✗ Failed:     1 sender (broken unsubscribe link — recommend manual)
  ⚠ Partial:    0 senders
  ⏭ Skipped:    16 candidates not selected

Existing messages from these senders are still in your inbox.
Want me to also delete or archive their existing messages? (separate workflow)
```

The closing question is intentional — many users will want a follow-up cleanup of the existing mail, but that's a separate skill (`email-triage` once available) and a separate confirmation.

## Safety Rules

1. **Never auto-execute the full candidate list.** Always require explicit per-sender or per-batch confirmation.
2. **Throttle at 5.** No more than 5 unsubscribes without re-confirmation.
3. **Never delete messages.** This skill only stops *future* mail. Existing messages stay.
4. **Never operate on Sent / Trash / Junk / Drafts.** Default folder is `INBOX`; reject other folder choices unless the user explicitly insists with reasoning.
5. **Stop on cache failure.** Don't try to enumerate without the cache — falling back to direct IMAP would be slow and miss the `list_unsubscribe` filter.
6. **Report failures clearly.** Broken unsubscribe links, mailto bounces, or HTTP errors should be surfaced with the sender name so the user can manually clean up.
7. **No retry on failure.** If `imap_execute_unsubscribe` fails, report and continue. Retrying might double-process if the first attempt actually worked.

## Output Format

The skill emits structured Markdown for Claude Desktop's chat UI:

- Scope confirmation: one sentence
- Candidate list: numbered, with metadata indented
- Outcome per sender: inline ✓/✗/⚠ glyph + reason
- Final summary: counts + closing question

Internal tool call structure (for the LLM's reference):

```
1. imap_list_accounts             → confirm account
2. imap_sync_folder_cache         → populate cache
3. imap_search_cache (group_by_sender) → enumerate
4. imap_list_unsubscribe_candidates → enrich with subscription DB
5. (per selection):
   - imap_search_cache (by_address) → get a message UID
   - imap_get_unsubscribe_links     → extract link
   - imap_execute_unsubscribe       → fire
   - imap_mark_subscription_unsubscribed → record
```

## Examples

### Example 1 — Happy path

**User:** "Clean up newsletters in my Gmail."

**Claude (via skill):**

> I'll look at INBOX in your Gmail account for newsletters received in the last 90 days. Syncing the local cache first…
>
> Cache sync complete: 8,240 messages indexed in 41 seconds.
>
> Top 20 newsletter candidates by message count:
>
> ```
>  1. Promo Daily <noreply@promodaily.com>          — 23 msgs
>  2. The Verge Newsletter <newsletter@theverge.com> — 18 msgs
>  ...
> ```
>
> Which to unsubscribe? (numbers, names, or "all")

**User:** "1, 2, 5, 8, 11"

**Claude:**

> 5 selected. Executing:
>
> ```
>  1. Promo Daily              ✓ Unsubscribed
>  2. The Verge Newsletter     ✓ Unsubscribed
>  5. RetailMeNot              ✓ Unsubscribed
>  8. Quora Digest             ✗ Failed: unsubscribe link returned 404
> 11. Medium Daily             ✓ Unsubscribed
> ```
>
> Summary: 4 successful, 1 failed (Quora — recommend manual unsubscribe via the email itself).
>
> Existing messages from these senders are still in your inbox. Want me to clean them up too? (separate workflow)

### Example 2 — Bail-out at the throttle

**User:** "Unsubscribe from all 20."

**Claude:**

> That's 20 unsubscribes. Confirm before I proceed?

**User:** "Yes."

**Claude:** *(after first 5)*

> 5 done — 4 successful, 1 failed (Quora 404). Continue with the next 5?

**User:** "Stop, the Quora one worries me."

**Claude:**

> Stopped after 5. Final summary: 4 successful, 1 failed, 15 candidates skipped. Want me to investigate the Quora failure?

### Example 3 — No candidates

**User:** "Unsubscribe me from newsletters in my work account from last week."

**Claude:**

> I'll look at INBOX in your work account for newsletters received in the last 7 days.
>
> Cache sync complete: 47 messages indexed.
>
> No newsletter candidates found in that date range (no senders with `List-Unsubscribe` headers and ≥ 3 messages). Want me to broaden the search to the last 90 days?

## Error Handling

| Error | Action |
|---|---|
| `cache_miss` from `imap_search_cache` | Run `imap_sync_folder_cache` first; if user already requested sync and it failed, surface the underlying error |
| `imap_sync_folder_cache` times out | Report and stop. Don't fall back to direct IMAP — the workflow assumes cache is present |
| `imap_get_unsubscribe_links` returns empty | Skip this sender, mark "no unsubscribe link found" in summary |
| `imap_execute_unsubscribe` HTTP 4xx/5xx | Mark ✗ with status code, continue with next |
| `imap_execute_unsubscribe` mailto bounce | Mark ⚠ "mailto sent but bounce reported" — outcome unclear |
| User says "stop" mid-workflow | Halt immediately; report what's been done so far |

## Out of Scope (this skill version)

- Cross-account unsubscribe in one workflow — single account at a time
- Auto-deleting existing messages from unsubscribed senders (defer to `email-triage` skill)
- Re-subscribing — this skill is one-way
- Whitelist management ("never unsubscribe from sender X")
- Subscription analytics / engagement scoring

These can land in v0.2+ once the v0.1 workflow is validated against real usage.

## Related Skills

- `email-triage` (placeholder, claude-skills-library #8) — broader inbox cleanup with safe quarantine workflow
- `correspondence-research` (placeholder, claude-skills-library #9) — search and analyze correspondence

## Author

- Author: Colin Bitterfield
- Email: colin.bitterfield@templeofepiphany.com
- Project: imap-mcp-pro
- License: SEE LICENSE in the imap-mcp-pro repository
