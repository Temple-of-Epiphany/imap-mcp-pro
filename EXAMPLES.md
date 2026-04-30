# IMAP MCP Pro — Worked Examples

**Author:** Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
**Date Created:** 2026-04-29
**Date Updated:** 2026-04-29

These are sample Claude conversation transcripts for common workflows. They are **representative**, not literal recordings — actual responses vary slightly based on Claude version, account state, and inbox contents.

LLM clients perform measurably better when worked examples are present in repo docs. If you contribute a new tool or capability, add a corresponding section here.

---

## 1. Adding an email account

**You:** Add my Gmail account to IMAP MCP Pro. Email is jane@example.com.

**Claude:** I'll use the auto-detect flow so you don't have to specify host/port manually.

> *Tool call: `imap_add_account_auto`*
> Parameters: `{ "name": "Gmail", "email": "jane@example.com", "password": "<app-password>" }`

**Result:** Account added with ID `0ee1425e-163c-43e1-a04b-d20b6410c910`. Detected provider: Gmail (`imap.gmail.com:993`, TLS, SMTP `smtp.gmail.com:465`). Connection verified.

> *Tool call: `imap_list_folders`*
> `{ "accountId": "0ee1425e-163c-43e1-a04b-d20b6410c910" }`

**Claude:** I see your standard folders plus 7 labels under `[Gmail]/`. Anything you want to do first — check unread, search a label?

---

## 2. Searching a large folder with handle paging

**You:** Find emails from Stripe in my inbox over the last 90 days.

**Claude:** I'll search and let the server decide whether to inline or hand back a result handle.

> *Tool call: `imap_search_emails`*
> `{ "accountId": "0ee1425e-...", "folder": "INBOX", "from": "stripe.com", "since": "2026-01-29" }`

**Result:** 247 messages. The server returned a handle envelope (auto-mode) instead of inlining all 247 to keep the response under the token budget.

```json
{
  "mode": "handle",
  "resultId": "9b8c1f2a-...",
  "count": 247,
  "firstN": [ /* 5-message preview */ ],
  "facets": {
    "topSenders": [{ "email": "noreply@stripe.com", "count": 219 }, ...],
    "unread": 12,
    "flagged": 0,
    "dateRange": { "earliest": "2026-01-30T...", "latest": "2026-04-28T..." }
  },
  "expiresAt": "2026-04-29T23:42:00Z",
  "hint": "Result stored as temp. Use imap_results action='get' resultId='9b8c1f2a-...' offset=0 limit=50 to page through."
}
```

**Claude:** 247 emails, 12 unread, mostly from `noreply@stripe.com`. Want me to page through them, or filter further (e.g. only invoices, only unread)?

**You:** Page through the unread ones.

> *Tool call: `imap_search_emails`*
> `{ "accountId": "...", "folder": "INBOX", "from": "stripe.com", "since": "2026-01-29", "unreadOnly": true }`

**Result:** 12 messages, returned inline (under threshold). Listed by date.

---

## 3. Sending email

**You:** Reply to that last Stripe receipt and forward it to my accountant at acct@example.com.

**Claude:** I'll reply with a forward note rather than just `imap_forward_email` since you want context preserved.

> *Tool call: `imap_get_email`*
> `{ "accountId": "...", "folder": "INBOX", "uid": 18472 }`

(Reads the receipt to extract the Subject line and key fields.)

> *Tool call: `imap_forward_email`*
> ```json
> {
>   "accountId": "...",
>   "folder": "INBOX",
>   "uid": 18472,
>   "to": ["acct@example.com"],
>   "subject": "Fwd: Stripe receipt for 2026-04-28",
>   "body": "Tagging this one — please book to Marketing/SaaS for the April books."
> }
> ```

**Result:** Forward sent. Message ID returned. The original message remains in INBOX (forward doesn't move).

---

## 4. Bulk operations on hundreds of messages

**You:** I want to move every email from `notifications@github.com` from the last 6 months into a folder called Newsletters/GitHub.

**Claude:** That's likely several hundred messages. I'll chunk the move so we don't blow the connection.

> *Tool call: `imap_search_emails`*
> `{ "accountId": "...", "folder": "INBOX", "from": "notifications@github.com", "since": "2025-10-29", "responseMode": "handle" }`

**Result:** `resultId=ab12cd34-...`, 1,847 messages.

> *Tool call: `imap_create_folder`*
> `{ "accountId": "...", "name": "Newsletters/GitHub" }` → created

> *Tool call: `imap_results`*
> `{ "action": "get", "resultId": "ab12cd34-...", "offset": 0, "limit": 1847 }` → returns full UID list

> *Tool call: `imap_bulk_move_emails`*
> `{ "accountId": "...", "sourceFolder": "INBOX", "targetFolder": "Newsletters/GitHub", "uids": [12, 14, 15, ...] }`

(Tool auto-chunks at 50 UIDs per IMAP transaction; reports per-chunk progress.)

**Result:** Moved 1,847 of 1,847 in 38 chunks. Total wall time 14.2s.

> *Tool call: `imap_results`*
> `{ "action": "delete", "resultId": "ab12cd34-..." }` → cleaned up the result

---

## 5. Spam scan with UserCheck

**You:** Scan my Junk folder for sender domains and tell me which are confirmed spam vs ambiguous.

**Claude:** I'll use the UserCheck integration.

> *Tool call: `imap_check_folder_spam`*
> `{ "accountId": "...", "folder": "INBOX.Junk", "limit": 200 }`

**Result:** Scanned 200 messages. Categorized by sender domain:

```
Domain                          Risk   Count   Notes
────────────────────────────────────────────────────────────
mailer.suspicious.example       HIGH      47   Disposable, on UserCheck blocklist
notifications.example           LOW       38   Legit transactional, false-flagged
adlist.example                  HIGH      29   Marketing list, opt-in unclear
totally-fake.example            HIGH      22   New domain (<30 days), no SPF/DKIM
... (8 more rows)
```

**Claude:** 4 sender domains account for 136 of the 200 messages and all four are high-risk. Want me to bulk-delete those, or keep them for review?

---

## 6. Auto-categorization

**You:** Apply my keyword categories to the inbox.

**Claude:**

> *Tool call: `imap_list_categories`*
> `{ "accountId": "..." }`

(Confirms the 8 categories you have configured: Newsletters, Receipts, Social, Calendar, Travel, Bills, Updates, Personal.)

> *Tool call: `imap_apply_categories`*
> `{ "accountId": "...", "folder": "INBOX", "limit": 500 }`

**Result:** Categorized 463 of 500 messages (37 had no matching keywords). Distribution:

- Newsletters: 217
- Receipts: 89
- Social: 64
- Updates: 51
- Travel: 22
- Bills: 14
- Calendar: 4
- Personal: 2

Categories were applied as IMAP keywords (`$Newsletters`, `$Receipts`, etc.) so they survive across clients.

---

## 7. Multi-account view

**You:** What's my unread count across all my accounts?

**Claude:**

> *Tool call: `imap_list_accounts`* → 4 accounts

For each account in parallel:

> *Tool call: `imap_get_unread_count`* (per accountId)

**Result:**

| Account | Folder | Unread |
|---|---|---|
| Gmail (jane@example.com) | INBOX | 12 |
| Work (jane@company.com) | INBOX | 47 |
| Newsletters | INBOX | 219 |
| iCloud | INBOX | 3 |

**Claude:** 281 unread total. Work is the busiest. Want me to triage the 47 work-account unreads first?

---

## 8. Sending an attachment via path (v2.0)

**You:** Send the Q1 report from `~/Documents/imap-attachments/q1.pdf` to `cfo@example.com`.

**Claude:** I'll use `attachmentPaths` so you don't have to base64 the PDF into the request.

> *Tool call: `imap_send_email`*
> ```json
> {
>   "accountId": "...",
>   "to": "cfo@example.com",
>   "subject": "Q1 Report",
>   "text": "Attached.",
>   "attachmentPaths": ["/Users/me/Documents/imap-attachments/q1.pdf"]
> }
> ```

**Result:**

```json
{
  "success": true,
  "messageId": "<...@bitterfield.com>",
  "result": "sent_and_archived",
  "archive": { "folder": "INBOX.Sent", "uid": 642, "method": "special_use", "cacheHit": true }
}
```

**Claude:** Sent and archived to the Sent folder (resolved via SPECIAL-USE — cached for 24 hours).

If the path isn't whitelisted, Claude gets a structured error:

```json
{
  "success": false,
  "result": "attachment_validation_failed",
  "errors": ["Path resolves outside allowed dirs: /etc/passwd -> /etc/passwd"],
  "errorDetails": [{ "kind": "outside-allowed-dirs", "path": "/etc/passwd", "resolved": "/etc/passwd" }]
}
```

The configured allowed directories live in `IMAP_MCP_ALLOWED_ATTACHMENT_DIRS` (or `users.allowed_attachment_dirs` per-user).

---

## 9. Chunked upload from a web client (v2.0)

A web UI can't put files on the server's filesystem, so it uses the staging API instead.

**Client (browser):**

```js
// Read the file
const file = input.files[0];

// 1. init
const { stagingId, chunkSizeBytes } = await mcp.call('imap_attachment_stage_init', {
  filename: file.name,
  expectedSize: file.size,
  contentType: file.type,
});

// 2. upload in chunks (256 KiB by default)
for (let off = 0, idx = 0; off < file.size; off += chunkSizeBytes, idx++) {
  const slice = file.slice(off, off + chunkSizeBytes);
  const buf = new Uint8Array(await slice.arrayBuffer());
  const chunkData = btoa(String.fromCharCode(...buf));  // base64
  await mcp.call('imap_attachment_stage_append', {
    stagingId,
    chunkIndex: idx,
    chunkData,
    isFinal: off + chunkSizeBytes >= file.size,  // auto-finalize on last chunk
  });
}
```

**Then prompt:**

> Send a quick note to ops@example.com with the file I just uploaded.

> *Tool call: `imap_send_email`*
> ```json
> {
>   "accountId": "...",
>   "to": "ops@example.com",
>   "subject": "Logs",
>   "text": "Attached the bundle from this morning.",
>   "stagedAttachmentIds": ["<the stagingId>"]
> }
> ```

The server attaches the assembled blob and deletes the staging session on send success. Out-of-order chunk uploads are fine (each chunk is keyed by index, not arrival order).

---

## 10. Diagnosing a flaky SMTP server (v2.0)

**You:** I'm getting intermittent send failures on my Yahoo account. What's wrong?

**Claude:**

> *Tool call: `imap_test_smtp`*
> `{ "accountId": "...", "verbose": false }`

**Result:**

```json
{
  "success": true,
  "smtpHost": "smtp.mail.yahoo.com",
  "secure": false,
  "tlsVersion": "TLSv1.3",
  "tlsCipher": "TLS_AES_256_GCM_SHA384",
  "rttMs": 387,
  "authResult": "ok",
  "capabilities": ["STARTTLS", "PIPELINING", "SIZE", "8BITMIME", "AUTH"],
  "providerGuidance": "Yahoo / AOL require an app password. Generate one in Account Security → App passwords."
}
```

> *Tool call: `imap_get_smtp_metrics`*
> `{ "accountId": "..." }`

**Result:**

```json
{
  "accounts": [{
    "smtpHost": "smtp.mail.yahoo.com",
    "sendTotal": 17,
    "sendSuccessTotal": 14,
    "sendFailureTotal": 3,
    "retryTotal": 6,
    "retryByCategory": { "transient": 6, "permanent": 0, "authentication": 0, "configuration": 0 },
    "lastSendDurationMs": 2104,
    "lastError": null
  }],
  "pool": { "configured": 1 }
}
```

**Claude:** Yahoo's SMTP is up (TLS 1.3, auth ok, 387 ms RTT). Of your 17 recent sends, 3 failed initially but **all 6 retries were classified as transient** (4xx codes, connection blips) — no auth failures, no permanent errors. Last error is null, meaning the eventual outcome was successful for everything attempted. The flakiness is on Yahoo's side; the retry classifier is absorbing it.

---

## Tips for working with the tools

- **Default to `responseMode='auto'`** — the server picks the right tier (inline / handle / file) based on size. Override only when you know better.
- **Call `imap_results action='persist'`** before closing a session if you want to keep a result across multiple Claude conversations. Otherwise it expires after 2 hours.
- **For bulk operations on > 50 messages**, prefer the `_chunked` variants (`imap_bulk_get_emails_chunked`, etc.) — they auto-split into transactions sized for IMAP server limits.
- **Use `--validate-config`** when troubleshooting — it shows the resolved config with provenance (which env var or config file each value came from).
