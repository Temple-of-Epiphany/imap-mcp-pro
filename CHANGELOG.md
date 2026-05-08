# Changelog

All notable changes to IMAP MCP Pro will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.17.11] - 2026-05-07

### Patch — close inline `attachments[].path` allow-list bypass (closes #147)

The inline `attachments[]` form on `imap_send_email` accepted a `path` field that was forwarded straight to nodemailer at `src/tools/email-tools.ts:660`, completely bypassing the WP1 (#100) allow-list and the v2.17.9 dotfile / size / basename rules. v2.17.8 flagged the field DEPRECATED in the schema description and v2.17.9 hardened every other attachment input — leaving this as the last un-gated entry point. v2.17.11 closes it.

#### 🛡️ Security — inline path now validated identically to `attachmentPaths`

Each inline attachment is now classified at handler time:

- **Bytes shape** (`{ filename, content (base64) }`) — same v2.17.9 size + dotfile + basename rules as before. Decoded bytes capped against the per-attachment + aggregate size budget. If both `content` and `path` are passed, `content` wins (forward-compat: it has been the documented primary field since v1).
- **Path shape** (`{ filename, path }`) — **new in v2.17.11.** Routed through `validateAttachmentPaths()` against the caller's allow-list, dotfile policy, and size caps. The same envelope (`attachment_validation_failed`, `errorDetails[].kind`) is returned on rejection as the top-level `attachmentPaths` field already produced. The validated `realPath` and basename'd filename are used downstream — symbolic-link traversal into a dotdir is rejected, paths outside the allow-list are rejected, files over the per-attachment cap are rejected, and the running aggregate budget is shared across all three attachment forms in one send.
- **Empty shape** (neither `content` nor `path`) — now rejected with `empty-attachment` instead of being silently passed to the MIME composer (which would have produced a zero-byte attachment).

User + allow-list resolution was hoisted to handler scope so the inline-path validation and the top-level `attachmentPaths` validation share one source of truth instead of duplicating the lookup. No behavior change for callers using `attachmentPaths` only — same SQL queries, same env reads, same outcomes.

#### 📝 Schema description updated

`attachments[].path` is no longer flagged DEPRECATED-as-bypass. New text:

> *"Absolute file path on the server host. Validated against the same allow-list, dotfile-policy, and size caps as the top-level attachmentPaths field (since v2.17.11 / #147). Prefer the top-level attachmentPaths form for new code — this inline-path field remains for backward compatibility and is targeted for removal in v3.0."*

The v3.0 removal target is preserved — long-term, `attachmentPaths` is the canonical host-path entry and the inline `attachments` form is for inline bytes only.

#### Backward compatibility

- Callers using `attachments: [{ filename, content }]` only: **no change.** Same behavior as v2.17.9 / v2.17.10.
- Callers using `attachments: [{ filename, path }]`: **breaking change in the unsafe direction.** Previously an unconfigured server (`IMAP_MCP_ALLOWED_ATTACHMENT_DIRS` empty + per-user override null) accepted any path; now it rejects with `no-allowed-dirs-configured`. Configure the allow-list via the user_config slider or the env var, then retry.
- Callers passing both `content` and `path` on the same entry: **content now wins decisively.** Previously both were forwarded to nodemailer and behavior depended on nodemailer's preference. Now `content` is used and `path` is ignored.
- No tool surface change. No DB schema change.

#### Verified

- `npm run build`: clean.
- `npm test`: 75/75 pass (the v2.17.9 attachment-validator tests cover the validator logic this patch reuses; the new code is a routing change, not new validation logic).
- Schema description rewrite is the user-visible API change; verified to be backward-readable for any LLM client driving `imap_send_email`.

#### What this closes

The last attachment-input gap surfaced by the v2.17.7→v2.17.10 work. Per-form summary:

| Form | Allow-list | Dotfile reject | Size caps | Filename basename |
|---|---|---|---|---|
| `attachmentPaths` | ✅ since #100 | ✅ v2.17.9 | ✅ v2.17.9 | ✅ v2.17.9 |
| `attachments[].content` (base64) | n/a | ✅ v2.17.9 | ✅ v2.17.9 | ✅ v2.17.9 |
| `attachments[].path` | ✅ **v2.17.11** | ✅ **v2.17.11** | ✅ **v2.17.11** | ✅ **v2.17.11** |
| `stagedAttachmentIds` | ✅ implicit (server owns the bytes) | ✅ v2.17.9 | ✅ v2.17.9 | ✅ v2.17.9 |

## [2.17.10] - 2026-05-07

### Patch — embedded Web UI: bundle into .mcpb, auto-start with port-collision fallback (closes #150)

The Web UI (`src/web/server.ts` + `public/`) was code-present but non-functional in every distribution path: `npm run web` returned `Cannot GET /` (static-path bug), `dist/public/` didn't exist (postbuild gap), and the `.mcpb` extension never bundled or started it (entry-point gap). v2.17.10 fixes all three plus adds the configurable port + collision-handling that makes the embedded Web UI safe to ship as always-on infrastructure.

#### 🐛 Static-path resolution multi-candidate

`src/web/server.ts:111` was hard-coded to `path.join(__dirname, '../public')`. The leading comment correctly noted the dev case needs `../../public`, but the code only handled prod. Result: `npm run web` returned 404 because Express's static handler resolved to `src/public/` (which doesn't exist).

Fixed: probe both candidates, fail loudly with a precise error message if neither resolves. Adds a startup log line confirming which path served the request (`[WebUIServer] serving static assets from <path>`).

#### 📦 `postbuild.mjs` stages `public/` → `dist/public/`

Previously only `src/database/` and `skills/` were copied during postbuild. The compiled prod path resolved to `dist/web/../public = dist/public/` which didn't exist. Now `postbuild.mjs` copies `public/` recursively into `dist/`. The `dxt/build.mjs` step that follows already does `cpr(dist, server/dist)` recursively, so `dist/public/` flows into the `.mcpb` bundle for free — no `dxt/build.mjs` changes needed.

Postbuild summary line now reports: `schema.sql + N migrations + … + N web UI assets` so you can verify staging from the build log.

#### 🚀 Always-on Web UI in the .mcpb extension

The Web UI now boots automatically when the MCP server boots — present in every Claude Desktop session, not just first-run. Lifecycle is owned by a new `WebUIManager` service (`src/services/web-ui-manager.ts`) constructed during pre-handshake and started in post-handshake (so the MCP transport is responsive first; Web UI startup is detached and never blocks tool calls).

`WebUIServer`'s constructor was widened to accept an object form `{ port, db, imapService }` so the embedded boot path can share the live `DatabaseService` and `ImapService` handles already wired up in `src/index.ts` (no double-opening of `~/.imap-mcp/data.db`). The legacy positional `new WebUIServer(4500)` call shape used by `src/setup.ts` still works.

Auto-open in the embedded path is **off by default** — the .mcpb shouldn't pop a browser tab on every Claude Desktop launch. Opening is opt-in via the new MCP tool below.

#### 🔌 Port-probe with +100 fallback (configurable)

The Web UI port is now a Claude Desktop user_config slider:

> **Web UI Port (preferred)** — default `4500`, range `1024..65000`, mapped to env `IMAP_MCP_WEB_UI_PORT`.

At boot, `WebUIManager.start()` calls `findFreePort(preferred)` which probes the configured port; if it's in use, it increments by **100** (not 1) — so the fallback sequence is `4500 → 4600 → 4700 → ...` up to 10 attempts (`4500..5400`). The +100 spacing means a parallel project occupying a few ports doesn't push the fallback into an unpredictable slot. The actual chosen port and any tried-but-busy ports are logged via `[startup] component=web-ui` so a user with a misconfigured machine can see what happened.

If every candidate is busy, the post-handshake step logs the failure but does not crash the MCP server — tool invocations remain available.

#### 🆕 New MCP tool — `imap_open_web_ui`

```json
{
  "openInBrowser": false
}
```

Returns the live Web UI URL and port. When `openInBrowser` is `true`, also launches the user's default browser to that URL via the `open` package (best-effort — failure to open is non-fatal; the URL is still returned). Annotated `WRITE_LOCAL` (it spawns a browser process; not destructive but not read-only either).

This is the canonical answer to *"open the dashboard for me"* in agent workflows. The Web UI is already running; the tool just surfaces the URL because the actual port may differ from the configured default if there was a collision.

Tool count: **93 → 94**.

#### 🧪 New tests

`src/services/web-ui-manager.test.ts` (4 tests):
- `findFreePort` returns preferred when free
- skips a bound port and returns next +100
- walks multiple bound candidates
- returns `null` when every candidate in the 10-port sweep is taken

Total: **75/75 pass** (was 71).

#### Backward compatibility

- `WebUIServer(4500)` legacy constructor signature still accepted (used by `src/setup.ts`).
- `npm run web` standalone still works — actually works now, as opposed to the silent 404 it has been returning since the static-path comment was added.
- No DB schema change. No tool-surface removals — only the new `imap_open_web_ui` addition.
- Existing `.mcpb` user_config sliders unchanged; one new entry (`web_ui_port`) added with a sensible default.
- The new env var `IMAP_MCP_WEB_UI_PORT` is additive; if unset, the embedded boot uses `4500`.

#### Known limitations

- The `findFreePort` probe has the usual TOCTOU race: a port observed free may be claimed before `WebUIServer.listen()` runs. The window is sub-millisecond on localhost startup; if the race fires anyway, the bind fails synchronously and the post-handshake step logs the error instead of crashing — same posture as any other unrecoverable startup component. A user can retry via `imap_open_web_ui` once the conflicting process is dealt with.
- `WebUIManager.start()` is not currently re-callable after a successful start — it returns the existing URL on subsequent calls instead of reopening on a different port. Restarting on a different port requires restarting the MCP server.

## [2.17.9] - 2026-05-06

### Patch — attachment hardening: dotfile reject, 10 MB default cap, filename basename on all forms

Closes the first batch of attachment-input security gaps surfaced while diagnosing the Claude Desktop Workspace attachment failure that motivated v2.17.8. v2.17.8 fixed *discoverability* (the inline form was buried as "legacy"). v2.17.9 fixes *enforcement* (the rules now apply to all three input forms — inline, path, staged — uniformly).

#### 🛡️ New: dotfile / dotdir rejection (default-on, configurable)

Any attachment whose path or filename contains a segment starting with `.` is now rejected by default. Catches the canonical exfiltration shapes (`~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.config/...`, `~/.bashrc`, `~/.envrc`, etc.) without requiring the operator to enumerate every dotdir up front.

- **Path form (`attachmentPaths`):** scans both the input path and the `realpath` (so a non-dotted symlink resolving into a dotdir is also rejected). Implemented via new `findDotSegment()` helper; `.` and `..` segments are skipped (they are caught by the pre-existing parent-traversal / realpath checks).
- **Inline form (`attachments[].filename`):** filename is `path.basename`-ed and checked with `isDotfileBasename()` after sanitization.
- **Staged form (`stagedAttachmentIds`):** stored filename from `imap_attachment_stage_init` is re-checked at send time.

**Override:** set `IMAP_MCP_ALLOW_DOTFILES=true` in the server env to allow dotfile sends. Recommended only for narrow, audited use cases.

**New `ValidationFailure` kinds:** `dotfile-or-dotdir-rejected` (with `path` and `component` fields), `invalid-filename` (when sanitization yields an empty basename).

#### 🛡️ Default size caps now 20 MiB and enforced on every form

Per-attachment and aggregate size caps now both default to **20 MiB** (20 971 520 bytes; was 25 MB / 50 MB respectively). Both are enforced against:

- `attachmentPaths` — already enforced; default lowered.
- `attachments[].content` — **was previously unbounded.** A caller could submit an arbitrarily large base64 blob and the server would buffer the decoded bytes in memory before nodemailer streamed to SMTP. Now decoded byte length is checked against the per-attachment cap, and the running aggregate spans inline + path + staged in a single budget.
- `stagedAttachmentIds` — finalized session size from staging metadata is now checked at send time, in addition to the per-user disk quota that staging enforces at upload.

**Overrides (env vars, applied before defaults):**
- `IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES` — per-attachment ceiling.
- `IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES` — aggregate ceiling for one send.

The aggregate budget is shared across all three input forms, so mixing inline + path + staged in a single send still respects the total cap.

**Claude Desktop UI surfaces:** the `.mcpb` extension manifest now exposes both ceilings as `user_config` entries (*"Maximum Attachment Size — per file (bytes)"* and *"Maximum Attachment Size — aggregate per send (bytes)"*), each defaulting to 20 MiB with sliders bounded at 1 MiB / 100 MiB and 1 MiB / 200 MiB respectively. The dotfile policy is exposed as a *"Allow Dotfile / Dotdir Attachments"* boolean defaulting to off.

#### 🐛 Fixed manifest env-var name mismatch (latent since manifest first shipped)

The `.mcpb` manifest's `max_attachment_size_bytes` user_config entry was wired to the env var name `IMAP_MCP_ATTACHMENT_MAX_BYTES`, but the server has always read `IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES`. The Claude Desktop UI control was therefore inert — a user could move the slider all day without the server cap changing. Renamed the manifest's env wiring to the canonical name so the user_config now actually drives the runtime cap. New `max_total_attachment_size_bytes` and `allow_dotfiles` entries were added with the correct names from the start.

#### 🛡️ Filename basename on every form ("sanitize the path from the filename")

`sanitizeFilename()` now uses `path.basename()` as its first step (previously it merely replaced `/` and `\` with `_`, preserving path-like noise in the filename). After basename, control characters are stripped and the result is capped at 255 bytes per RFC 2183. **Leading dots are no longer auto-stripped** — that was a silent renaming policy; the explicit `denyDotfiles` knob replaces it.

Applied uniformly to:
- Path-based attachments (filename derived from `realpath` basename or the `attachmentFilenames[]` override).
- Inline attachments (`attachments[].filename`).
- Staged attachments (filename stored from `imap_attachment_stage_init`).

A filename that sanitizes to an empty string (e.g., input was just `/` or all control chars) is rejected with `invalid-filename` instead of silently being passed to the MIME composer.

#### 🧪 New tests

`src/services/attachment-validator.test.ts` (21 tests) covers:
- `sanitizeFilename` basename behavior, control-char strip, length cap, leading-dot preservation.
- `isDotfileBasename` and `findDotSegment` happy + edge cases.
- `validateAttachmentPaths` dotfile rejection (default and `denyDotfiles=false` override) with real tmpdir filesystem fixtures.
- Per-attachment and aggregate size cap enforcement.

Total test count: **71/71 pass** (was 50).

#### Backward compatibility

- **Default size caps changed.** Per-attachment cap drops 25 MB → 20 MiB (a smaller change than first drafted at 10 MiB). Aggregate cap drops 50 MB → 20 MiB. Sends with attachments between 20 MiB and 25 MB that previously succeeded will now fail with `attachment_validation_failed` / `size-exceeds-per-attachment`. Raise either ceiling via the Claude Desktop user_config sliders or by setting `IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES` / `IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES` directly.
- **Dotfile sends now refused by default.** Sends targeting `.bashrc`, `.envrc`, etc. will fail unless `IMAP_MCP_ALLOW_DOTFILES=true`. This is the intended safe default; the override exists for the narrow case where a user genuinely wants to email a dotfile.
- **`sanitizeFilename` semantics changed.** Internal helper; the only external caller is `validateAttachmentPaths`, which now produces basename-only filenames instead of underscore-substituted full paths. Callers passing absolute paths as the *filename override* (`attachmentFilenames[i]`) will get the basename rather than a mangled long string.
- **Validator no longer auto-strips leading dots from filenames.** Combined with the new `denyDotfiles` policy, the security posture is equivalent — and now explicit.
- No tool-surface, no schema, no env-var rename. New env vars (`IMAP_MCP_ALLOW_DOTFILES`, lowered `IMAP_MCP_MAX_*` defaults) are additive / refined.

#### Still open — tracked for follow-up

- **Inline `attachments[].path` allow-list bypass.** The inline form's `path` field still forwards directly to nodemailer without going through `validateAttachmentPaths`. Flagged DEPRECATED in v2.17.8's schema description; routing it through the validator (or removing it) is the next iteration of attachment-input hardening.
- **Per-user outbox dir** (auto-created, auto-allowlisted at `~/.imap-mcp/users/<userId>/outbox/`). Eliminates the "no allowed dirs configured" first-run friction without widening the attack surface beyond a server-managed dir. Tracked separately.

## [2.17.8] - 2026-05-06

### Patch — attachment-form discoverability + steering error messages (no behavior change)

`imap_send_email` exposes three attachment input forms (inline base64 `attachments`, host-path `attachmentPaths`, chunked-upload `stagedAttachmentIds`). Schema descriptions did not communicate when each one applies, so callers driving the tool from a sandboxed environment (Claude Desktop Workspace, Claude.ai code sandbox where files live at `/mnt/user-data/outputs/`) reached for `attachmentPaths` first, hit `attachment_validation_failed`, retried with the staging API (multi-call dance), and still failed when the sandbox path remained unreadable to the server. The inline form — which has worked since v1, completes in one round-trip, and bypasses the allow-list because no path is involved — was buried as `(legacy form: ...)` in the description.

This patch is documentation/error-text only. No behavior changes, no new code paths, no schema migrations.

#### 📝 Schema descriptions rewritten on `imap_send_email`

- **Tool top-level description** now ends with a one-line decision rule listing the three forms and when each one applies.
- **`attachments`** (inline base64) is presented as **INLINE FORM (preferred when the file is not on the server host)** with explicit guidance pointing at Claude Desktop Workspace and Claude.ai sandbox cases. Mentions the ~10 MB MCP transport ceiling.
- **`attachmentPaths`** is presented as **PATH FORM (preferred when the file is on the same host as this server)** with a steer to inline when the file lives in a sandbox.
- **`stagedAttachmentIds`** is presented as **STAGED FORM (for large files or streaming uploads)**, explicitly de-recommended for small-file Workspace cases.
- **`attachments[].path`** is now flagged DEPRECATED in its description: it is forwarded directly to the SMTP composer and bypasses the WP1 allow-list. Callers wanting host-path attachments should use the top-level `attachmentPaths` field, which goes through `validateAttachmentPaths`. (No code change yet — flagged for a follow-up issue. See *Known issue* below.)

#### 🪧 Validation error messages now steer to the right form

`formatValidationErrors` in `src/services/attachment-validator.ts` was rewriting two failure kinds in a way that told the caller *what* was wrong but not *what to do next*. Both now include an explicit recommendation:

- **`no-allowed-dirs-configured`** — instead of just *"Set IMAP_MCP_ALLOWED_ATTACHMENT_DIRS"*, the message now offers two paths forward: (a) if the file is in a sandbox the server cannot read, retry with the inline form; (b) if the file is on the host, here is how to configure the allow-list.
- **`outside-allowed-dirs`** — now includes the same inline-form fallback recommendation for the sandbox case.

#### 📝 Staging tool description tightened

`imap_attachment_stage_init` now opens with *"Use only when the file exceeds the ~10 MB inline ceiling… For small files in a sandbox, prefer the inline `attachments` form."* This stops the tool from being chosen as a first-line answer for cases where one inline call would suffice.

#### Known issue — flagged for follow-up

Surfaced while writing this patch, **not fixed here**: the inline `attachments[].path` field is forwarded directly to the SMTP composer (`src/tools/email-tools.ts` ~660) without going through `validateAttachmentPaths`. A caller can therefore pass `{ filename: 'x', path: '/etc/passwd' }` and bypass the WP1 allow-list. The `attachmentPaths` top-level field is the correctly-gated path-based input. This patch only flags the inline `path` field as DEPRECATED in the schema description — it does not remove or block the field, because that would be a breaking change for any external caller relying on the v1 shape. Tracking issue and removal will follow in a separate release.

#### Verified

- `npm run build`: clean.
- `npm test`: existing 50/50 still pass (no test changes — these are description-text edits).
- Manual: error envelope text confirmed via local stdio run.

#### Backward compatibility

- No tool surface change. Same arguments, same return shape, same env vars.
- No schema migration. DB stays at 1.10.0.
- Error envelopes for `attachment_validation_failed` keep the same `result` and `errorDetails[].kind` codes; only the human-readable `errors[]` strings grew longer.

## [2.17.7] - 2026-05-03

### Patch — userId resolution on usercheck tools + skill-update response sanitization (#145)

Two issues surfaced while expanding the v2.17.x acceptance test plan with UserCheck (Phase 6) and skill-update (Phase 8) coverage. Both are now fixed:

#### 🐛 Fixed — userId on usercheck tools accepts username (matches subscription-tools behavior)

`imap_add_usercheck_key` and the other 6 usercheck tools that accept `userId` were not running it through the v2.17.2 `resolveUserOrThrow` helper. Passing the username form (e.g., `"colin"`) returned `FOREIGN KEY constraint failed` deep in the INSERT path — same failure shape as #130 before that fix landed. The subscription tools were updated in v2.17.2; the usercheck tools were missed.

- **Extracted** `resolveUserOrThrow` and `UnknownUserError` into `src/utils/user-resolver.ts` (was a private helper inside `subscription-tools.ts`).
- **Applied** the resolver to all 7 usercheck tools that accept `userId`:
  - `imap_add_usercheck_key`
  - `imap_get_usercheck_key`
  - `imap_check_email_spam`
  - `imap_check_domain`
  - `imap_check_emails_spam_bulk`
  - `imap_check_folder_spam`
  - `imap_scan_account_spam`
- **Updated** every `userId` Zod description on those tools to match the documented contract: *"either canonical user_id UUID or username from the users table."*
- **Subscription-tools** now imports the shared helper instead of carrying a local copy.

`imap_delete_usercheck_key` doesn't take `userId` (it takes `keyId`), so no change needed.

#### 🛡️ Mitigated — `imap_check_skill_updates` response trimmed and sanitized

Same hang shape as the v2.17.5 `imap_get_unsubscribe_links` issue: server returns a valid response in 175ms via local stdio (verified), but Claude Desktop hangs on it. We can't fix CD's renderer from here, but we can give it less surface area to choke on.

- **Removed** the `baseUrl` field from the response (informational — can be reconstructed from `source`).
- **Sanitized** the `summary` and per-skill `fetchError` strings via `sanitizeText` (the v2.17.6 helper). Caps lengths, replaces control characters with spaces.
- **Removed** `cached` field (was always `false` — never wired up).

Response size dropped from 542 → 428 bytes (21% smaller, fewer string fields for CD to render). Whether this fully resolves the CD hang is for end-user verification post-install; if not, the v2.17.6 skill workaround pattern (avoid the affected tool in skill workflows) extends to anything that depends on `imap_check_skill_updates`.

#### 🧪 Acceptance verification

Local stdio MCP test against v2.17.7 build:

```
imap_check_skill_updates       → 175ms / 44ms cached, 428 bytes  (was 542 bytes)
imap_get_subscription_summary  →   2ms,   4557 bytes  ✓ unchanged
imap_list_unsubscribe_candidates → 0ms,   4732 bytes  ✓ unchanged
imap_get_unsubscribe_links     →   1ms,  11589 bytes  ✓ unchanged
```

All 50 unit tests pass.

userId resolution path verified by code review: all 7 usercheck handlers now extract via `userId: userIdRaw` then call `resolveUserOrThrow(db, userIdRaw)` at the top of the handler body, exactly matching the subscription-tools pattern shipped in v2.17.2.

#### 🛡️ Backward compatibility

- **userId is now strict superset** on usercheck tools — UUIDs that worked previously still work; usernames now also work.
- **No schema changes.** No DB migration.
- **`imap_check_skill_updates` response shape is a subset** of v2.17.6's. Callers that depended on the dropped fields (`baseUrl`, `cached`) will see them as `undefined`. Those fields were never used by the bundled `unsubscribe-cleanup` skill or any internal tool.

#### 📋 Tracked

- Issue #145 — root-cause filing with both bugs and the diagnostic data
- v2.17.x test plan (Phase 6 + Phase 8) — first run-through to surface these issues during plan-authoring

## [2.17.6] - 2026-05-02

### Patch — sanitize unsubscribe content; skill avoids the row-level read tool (#143)

`imap_get_unsubscribe_links` was reported hanging in Claude Desktop on every call regardless of result-set size (1 row hangs same as 19+). Local stdio reproduction shows the server returns valid responses in 0–2ms — the hang manifests only in CD's response handling. Two-pronged fix on our side: harden the response data we hand the LLM, and route the skill around the affected tool.

#### 🛡️ Defensive sanitization (server-side)

New `src/utils/sanitize-content.ts`:

- **`sanitizeUrl(url)`** — trims trailing parsing residue (`>`, `]`, `™`, `®`, `©`, control chars, whitespace) that accumulates from header parsing of `<URL>` notation. Rejects URLs that aren't `http`, `https`, or `mailto`. Returns null on garbage input.
- **`sanitizeText(text, maxLen)`** — replaces C0/C1 control characters with spaces, collapses whitespace, caps length with ellipsis. Default cap 200 chars; `list_unsubscribe_header` capped at 500.

Applied at three points:

- **`imap_extract_unsubscribe_links`** — sanitizes URL + subject + header *before* writing to the database. Future-stored data is clean at the source.
- **`imap_get_unsubscribe_links`** — sanitizes on the read path so legacy data (stored before this release) is also clean for the LLM.
- **`imap_list_unsubscribe_candidates`** — same read-path sanitization on `unsubscribe_link` and `notes`.

22 unit tests cover the sanitizer (`sanitize-content.test.ts`).

#### 🔧 Skill workaround — `unsubscribe-cleanup` 0.1.1 → 0.1.2

Step 7 of the skill (Execute) used to call `imap_get_unsubscribe_links` to fetch the per-message unsubscribe URL before executing. The same URL is already on the candidate row returned by `imap_list_unsubscribe_candidates` in step 5 — fetching it twice was always redundant. The skill now uses the candidate-row URL directly and explicitly avoids `imap_get_unsubscribe_links` for the Execute path. The tool stays available for forensic per-message inspection when explicitly requested.

Skill manifest updated: `imap_get_unsubscribe_links` removed from `depends_on.tools`.

#### 🧪 Acceptance verification

Local stdio MCP test (same path Claude Desktop uses):

```
imap_get_subscription_summary       →   2ms,   4557 bytes  ✓
imap_list_unsubscribe_candidates    →   0ms,   4737 bytes  ✓ (sanitized URLs)
imap_get_unsubscribe_links no filter →  1ms,  11601 bytes  ✓ (sanitized fields)
imap_get_unsubscribe_links 1 row    →   0ms,    550 bytes  ✓ (sanitized fields)
```

CD-side rendering can't be confirmed locally, but the response content is now bounded (no >200-char subjects, no raw control chars, no malformed-URL trailing junk). The skill workaround ensures the user-facing flow works regardless of whether sanitization fixes CD's specific trigger.

#### 🛡️ Backward compatibility

- No schema changes (DB stays at 1.11.0). Existing stored URLs/subjects/headers are sanitized on read; the on-disk values stay as-is.
- All tool surfaces preserved. `imap_get_unsubscribe_links` still accepts the same params and returns the same shape — fields are just cleaner.
- Other clients (mcp-web-pro, the unsubscriber-pro website consumer) get the same sanitization automatically.

#### 📋 Tracked

- Issue #143 — root-cause filing with the diagnostic data
- Upstream bug worth filing with Claude Desktop separately (a valid MCP response shouldn't hang any client)

## [2.17.5] - 2026-05-02

### Patch — skill update source defaults to imap-mcp-pro itself (no PAT needed)

v2.17.4 shipped with the GitHub update source defaulting to `Temple-of-Epiphany/claude-skills-library`. That repo is private, so out-of-the-box `imap_check_skill_updates` and `imap_update_skills` returned `fetchError: 404` for any user who hadn't set `IMAP_MCP_GITHUB_TOKEN`.

Architecturally, the cleaner answer is: **skills ship bundled with the MCP, so the MCP's own repo is the canonical update source**. imap-mcp-pro is public, so the raw.githubusercontent.com fetch path works for everyone with no token, no setup. claude-skills-library can stay private and serve as the cross-cutting / standalone-skill registry; imap-mcp-pro is now self-contained.

#### 🐛 Fixed

- **`defaultGitHubSource()` defaults `repo` to `imap-mcp-pro`** (was `claude-skills-library`). Skills are fetched from `https://raw.githubusercontent.com/Temple-of-Epiphany/imap-mcp-pro/main/skills/<name>/...` — the same paths where bundled skills already live in this repo.
- **No PAT required** for the default public-update path.
- **Override path intact:** users with skills in a different repo (fork, private library, etc.) can still set `IMAP_MCP_SKILL_GITHUB_REPO` / `IMAP_MCP_SKILL_GITHUB_OWNER` / `IMAP_MCP_SKILL_GITHUB_REF` and it works as before.
- **Verified end-to-end** with the public path:
  ```
  GET https://raw.githubusercontent.com/Temple-of-Epiphany/imap-mcp-pro/main/skills/unsubscribe-cleanup/version.json
    → 200 OK, returns {"name":"unsubscribe-cleanup","version":"0.1.1",...}
  ```

#### 🛡️ Backward compatibility

- No schema, API, or behavior changes for already-working calls.
- Users who explicitly set `IMAP_MCP_SKILL_GITHUB_REPO=claude-skills-library` (or any other repo) keep that behavior.
- Pure default-flip — anyone running the previous v2.17.4 build can update via the new v2.17.5 `.mcpb` and immediately get the public-fetch path.

## [2.17.4] - 2026-05-02

### Skill update from public GitHub (#138)

Adds the ability to check for and apply skill updates from the canonical `Temple-of-Epiphany/claude-skills-library` repo without rebuilding or reinstalling the `.mcpb`. Trust model is preserved: nothing happens automatically. Two new tools, intentionally split: a read-only check that surfaces "what's available," and a write tool that requires explicit skill names to apply. Auto-fetch at startup is **not** wired — manual user confirmation only.

#### ✨ Added

- **`imap_check_skill_updates`** — read-only. Fetches `version.json` for each bundled skill from GitHub, compares against the installed version, returns `{ name, installed, bundled, available, hasUpdate, fetchError }` per skill plus a one-line summary. No on-disk changes. Default `ref: "main"`, configurable per-call.
- **`imap_update_skills`** — write. Accepts an explicit `skills: string[]` (no "update everything" shortcut). Fetches `SKILL.md` + `version.json` from GitHub, version-compares, writes to `~/.claude/skills/imap-mcp-pro/<name>/`. Skills not in the bundled manifest are rejected (the manifest is the allowlist). `force: true` bypasses version compare; default behavior preserves on-disk versions ≥ remote.
- **GitHub source configuration** via env vars:
  - `IMAP_MCP_SKILL_GITHUB_OWNER` (default `Temple-of-Epiphany`)
  - `IMAP_MCP_SKILL_GITHUB_REPO` (default `claude-skills-library`)
  - `IMAP_MCP_SKILL_GITHUB_REF` (default `main`)
  - `IMAP_MCP_GITHUB_TOKEN` — optional Personal Access Token. When set, fetches go through the GitHub Contents API with `Accept: application/vnd.github.raw` (works for private repos and forks). When absent, falls back to public `raw.githubusercontent.com` URLs (no rate-limit concerns at our volume).

#### 🛡️ Trust model

Skills are *instructions to Claude*. Whoever controls the source repo controls the LLM workflow. To preserve user agency:

- Updates are **never** applied automatically. `imap_check_skill_updates` is read-only; `imap_update_skills` requires explicit skill names.
- The bundled `manifest.json` acts as an allowlist — skills not in the bundle cannot be installed via this path.
- User-modified on-disk skills are preserved unless `force: true` is passed.

#### 🧪 Acceptance verification

End-to-end smoke test on a downgraded local install:

```
Pre-state:  installed: 0.0.1, available: 0.1.1, hasUpdate: true
Apply:      updated: ["unsubscribe-cleanup"] in 342ms
Post-state: installed: 0.1.1, hasUpdate: false
```

Both raw.githubusercontent.com (public) and authenticated GitHub Contents API paths verified.

#### 🛡️ Backward compatibility

- No schema, no DB changes. New tools only.
- Bundled-skill install on startup unchanged — still copies from `dist/skills/` regardless of these new tools.

## [2.17.3] - 2026-05-02

### Patch — fix stdout filter dropping large Buffer writes (#137)

`imap_get_unsubscribe_links` (and any tool whose response payload exceeds Node's stdio highWaterMark, ~8KB on macOS/Linux) hung indefinitely in Claude Desktop. Sibling tools returning smaller payloads (`imap_get_subscription_summary`, `imap_list_unsubscribe_candidates`, `imap_about`) worked instantly. Local DB query for the same 17 rows completed in 1ms — confirming the hang was purely in the transport layer.

Root cause: the stdout filter installed at server startup (originally to silence stray npm-style version banners that would corrupt the JSON-RPC stream) only allowed `string` writes starting with `{`. When Node's stdout switches to Buffer writes for larger payloads, those Buffers were silently discarded — the client kept waiting for bytes that never arrived.

This bug has been latent since v2.6 (when the filter was first added). Pre-v2.17 nobody hit a tool whose response exceeded ~8KB; v2.17's `failedLinks` diagnostic and the row-level read tools finally pushed responses over the threshold.

#### 🐛 Fixed

- **`process.stdout.write` filter now passes Buffers and Uint8Arrays through unconditionally.** String writes still gate on JSON-RPC shape (`{…}` or bare newline) so the original anti-chatter intent is preserved. Library chatter (npm banners, dotenv config dumps) still gets dropped — only large structured responses are unblocked.
- Added a comment block at the filter call site documenting the bug + fix history so the next person who touches it knows why the filter exists and what it does/doesn't allow.

#### 🧪 Acceptance criteria (per #137)

After installing 2.17.3:

- `imap_get_unsubscribe_links(userId="colin")` returns 17 rows in under 1 second.
- `imap_get_unsubscribe_links(senderEmail="citizenship@sableinternational.com", userId="colin")` returns exactly 1 row.
- No regression in `imap_get_subscription_summary` or `imap_list_unsubscribe_candidates`.
- No regression in `imap_extract_unsubscribe_links` (the `failedLinks` array on a real failure is now well above 8KB and previously may have hit the same bug).

#### 🛡️ Backward compatibility

- No schema, no API, no behavior changes for existing-working calls.
- Pure transport-layer fix — strictly unblocks responses that were silently dropped.

## [2.17.2] - 2026-05-02

### Patch — fix subscription tools' silent FK failure on `userId` (#130)

The v2.17.1 `failedLinks` diagnostic worked exactly as designed and surfaced the actual underlying bug: `imap_extract_unsubscribe_links` was failing 100% of stores with `FOREIGN KEY constraint failed` because the tool layer accepted the caller-supplied `userId` (often a username like `"colin"`) and inserted it directly into tables whose FK references `users.user_id` (a UUID like `cabcbc4f-…`). Every insert violated the FK; every error was caught and reported in `failedLinks` but no row was ever stored. Downstream `imap_get_unsubscribe_links`, `imap_list_unsubscribe_candidates`, `imap_get_subscription_summary`, and the entire `unsubscribe-cleanup` skill workflow returned empty.

This bug has been latent since v2.6 — pre-v2.17.1 the errors were swallowed to stderr and were invisible. v2.17.1's `failedLinks` made it diagnosable.

#### 🐛 Fixed

- **`db.resolveUserId(input)` helper** — accepts either a canonical `user_id` (UUID) or a `username`, returns the canonical UUID. Single point of truth for caller-supplied user identifiers.
- **All 8 subscription tools now resolve `userId` at the tool boundary** before any DB write or read:
  - `imap_extract_unsubscribe_links`
  - `imap_get_subscription_summary`
  - `imap_mark_subscription_unsubscribed`
  - `imap_update_subscription_category`
  - `imap_update_subscription_notes`
  - `imap_get_unsubscribe_links`
  - `imap_list_unsubscribe_candidates`
  - `imap_execute_unsubscribe`
- **Unknown user → structured error** — passing a `userId` that matches neither a UUID nor a username throws `UnknownUserError`, which `withErrorHandling` converts to a clean error envelope with the actionable hint *"Pass a valid user_id (UUID) or a username that exists in the users table. Call imap_list_users to see valid values."*
- **Tool descriptions updated** — all subscription tools now document that `userId` accepts either form.

#### 🧪 Acceptance criteria (per #130)

After installing 2.17.2, the same reproduction that produced the bug report should succeed:

```
imap_extract_unsubscribe_links(folder="INBOX", limit=200)
  → linksFound: 17, linksStored: 17, errors: 0   (no failedLinks field)
imap_get_unsubscribe_links(userId="colin")
  → 17 rows returned
imap_list_unsubscribe_candidates(userId="colin")
  → 5 candidates (one per distinct sender)
```

#### 🛡️ Backward compatibility

- No schema changes (DB stays at 1.11.0).
- `userId` parameter accepts a strict superset of what it did before — any UUID that worked previously still works; usernames now also work.
- All other tool surfaces unchanged.

## [2.17.1] - 2026-05-01

### Patch — fix stale hardcoded version strings

The `imap_about` tool reported `version: '2.6.0'` regardless of the actual package version — a hardcoded string in `src/tools/meta-tools.ts` that hadn't been touched since the v2.6 era. Two more occurrences in `src/index.ts` (the McpServer constructor in normal startup + the manifest-emit path) had been kept up to date manually but immediately drifted again with each release.

This patch makes `package.json` the single source of truth.

#### 🐛 Fixed

- **`imap_about` returns the actual running version**, not a fossilized constant. Handler now reads `PACKAGE_VERSION` from a new `src/utils/package-info.ts` module that loads `package.json` at module init.
- **`McpServer` `serverInfo.version`** (both startup paths in `src/index.ts`) reads from the same module. Bumping `package.json` is now the only step required to make the new version visible everywhere.

#### 🛠️ Changed

- New `src/utils/package-info.ts` exports `PACKAGE_NAME` and `PACKAGE_VERSION`. Falls back to safe defaults (`imap-mcp-pro` / `0.0.0`) if `package.json` can't be read — never crashes startup.
- `imap_about.service.packageName` now reads from `package.json` rather than being a hardcoded literal.

#### 🛡️ Backward compatibility

No tool surface, schema, or behavior changes. Pure release-hygiene patch.

- **`imap_extract_unsubscribe_links` now surfaces per-message error reasons** (Issue #130). The tool was reporting `errors: N` with no detail; the actual error went to server stderr only. Response now includes a `failedLinks: [{uid, from, reason}]` array (omitted when empty). Diagnostic-only — does not change which messages succeed or fail. Root-cause fix for the underlying store-path failure is tracked in #130 part 2 and depends on the data this surfacing makes visible.

#### 🚧 Known issues (not fixed in this patch)

- `src/web/server.ts` has three more hardcoded version strings (2.9.0, 2.12.0). The embedded web UI is not exercised by the `.mcpb` distribution; will be fixed when the web UI gets a broader review.
- `imap_extract_unsubscribe_links` body-fetching path can exceed the MCP transport timeout on large folders (#131). The `imap_search_cache` cache-based path is the recommended alternative; the body-fetch path needs a time/row budget and partial-result return.

## [2.17.0] - 2026-05-01

### Local message cache + first auto-installed skill

This release lands the first piece of the v3.0 bulk-operations effort: a local SQLite header cache that makes sender enumeration, domain lookups, and "top N senders" queries return in milliseconds against folders with thousands of messages, plus the auto-install mechanism that delivers a Claude skill alongside the MCP server. Together they enable the `unsubscribe-cleanup` workflow without needing the user to hand-copy any skill files.

Tool count: 93 → 95.

#### ✨ Added

- **`imap_sync_folder_cache`** — populate the local `messages_cache` table for one folder. Idempotent: subsequent calls fetch only UIDs since the last sync. UIDVALIDITY change triggers a full resync automatically. Returns `{ rowsAdded, rowsAfter, durationMs, uidValidity, uidValidityChanged }`. Reads remote (IMAP) and writes the local cache; annotated `READ_REMOTE` because the user-facing effect is reading messages — the cache is an implementation detail.
- **`imap_search_cache`** — fast SQL-backed search against the local cache. Three modes:
  - `by_domain` — rows where `from_domain` matches (case-insensitive).
  - `by_address` — rows where `from_address` matches exactly.
  - `group_by_sender` — top-N senders ranked by message count, with `list_unsubscribe_present` flag for quick newsletter identification.
  - Optional `since` filter accepts relative ("90d", "24h") or ISO date.
  - Cache miss returns an explicit structured `cache_miss` error — no silent IMAP fallback. The skill orchestrates the order.
- **Auto-installed skills** (`SkillsInstallerService`). On startup, the server copies bundled skills from inside its package to `~/.claude/skills/imap-mcp-pro/<skill-name>/`. Idempotent: skips when versions match, updates when the bundle is newer, preserves on-disk content when its version is ahead of the bundle. Disable via `IMAP_MCP_SKIP_SKILLS_INSTALL=1`.
- **`unsubscribe-cleanup` skill** (v0.1.0) bundled inside the `.mcpb`. Wraps `imap_sync_folder_cache` + `imap_search_cache` + the existing PR #45 unsubscribe pipeline (`imap_list_unsubscribe_candidates`, `imap_get_unsubscribe_links`, `imap_execute_unsubscribe`, `imap_mark_subscription_unsubscribed`) into a confirmation-gated workflow. Source of truth lives in `Temple-of-Epiphany/claude-skills-library`; this `.mcpb` ships a vendored snapshot.

#### 🛠️ Changed

- **Schema migration `1.10.0 → 1.11.0`** — adds `messages_cache` table with indexes on `(account_id, from_domain)`, `(account_id, from_address)`, and `(account_id, date_received)`. Reversible via the matching `.down.sql`. FK to `accounts` cascades on account delete.
- **`scripts/postbuild.mjs`** — now also copies `skills/` → `dist/skills/` so the bundle ends up inside the `.mcpb` archive (no `dxt/build.mjs` change needed; existing `dist/` staging carries the skills along).
- **`ImapService.fetchHeadersForCache`** — new public method used by the cache. Opens the folder, reads UIDVALIDITY/UIDNEXT, optionally fetches an envelope + flags + `List-Unsubscribe` header for a UID range. Pass `uidRange = null` to skip the fetch and just inspect mailbox status.

#### 🐛 Fixed

- **Windows `.mcpb` build** (Issue #122). The `npm run build` script used a Unix shell chain (`mkdir -p && cp ...`) that errored on Windows `cmd.exe` with "The syntax of the command is incorrect." `tsc` compiled fine but schema files never copied to `dist/database/`, then `DatabaseService` threw `Schema file not found`. Replaced with `scripts/postbuild.mjs` — small Node script using `node:fs/promises` for cross-platform file ops. Every Windows `.mcpb` artifact build had failed since the workflow was added.

#### 🧪 Validated

- **Cache primitive** verified against `colin@bitterfield.com` INBOX (1537 messages):
  - Cold sync: 1537 rows in 1.72s (target < 60s — beat by 35×)
  - Warm re-sync: 0 new rows in 196ms (UIDVALIDITY + delta logic confirmed)
  - `group_by_sender` warm: 20 ranked rows in 4ms (target < 200ms — beat by 50×)
  - `by_domain` lookup: 5 rows in 1ms
- **Cache primitive** verified against `cbitterfield@gmail.com` INBOX with same 5/5 pass — top senders correctly enumerated across 100+ msg/sender clusters.
- **Skills installer** smoke test: fresh install / no-op re-install / update on older / preserve on newer / skip env-var — 5/5 pass.

#### 📦 Distribution

- Build matrix dropped `macos-x64` (macos-13 runner pool queue-starved through 2026; Apple Silicon transition complete). Future tagged releases produce 3 `.mcpb` artifacts: `macos-arm64`, `windows-x64`, `linux-x64`. macOS Intel users: run the `linux-x64` `.mcpb` under Rosetta or build from source.
- Node ≥ 22.5 still required (`node:sqlite` baseline from v2.16.0).

#### 🛡️ Backward compatibility

- Existing tools untouched. **No transparent cache rewrite of `imap_search_emails` / `imap_get_email`** in this release — those still go straight to IMAP. The skill orchestrates the order: call `imap_sync_folder_cache` first, then use `imap_search_cache`. Transparent integration is deferred to a future release once cache-staleness behavior is fully understood.
- All env vars from v2.16.0 continue to work.
- Schema migration `1.11.0` is purely additive (one new table); existing tables unchanged.

#### 🚧 MVP cuts (deferred to v2.18.0+)

These were intentionally scoped out of v2.17.0 to ship the cache thesis end-to-end:

- Cross-folder participants index, attachments table, FTS5, threading columns (full Track B / #119)
- Cache mutation write-through on `imap_mark_as_read` etc. (cache silently goes stale until next `imap_sync_folder_cache` call)
- Multi-folder sync (`imap_sync_account_cache` — currently one folder per call)
- Full skill installer per #120: SHA-based user-edit preservation, periodic 1–4 hr TTL re-sync, configurable install path, `imap_get_skills_manifest` tool for remote consumers

#### 🔗 Issues / PRs

- #122 (Windows build fix) → PR #123 — merged
- #124 (v2.17.0 MVP umbrella) — closed by this release
- #125 (cache scaffold + implementation + skill installer) — merged
- #126 (drop macos-x64 from matrix) — merged
- claude-skills-library #7 (`unsubscribe-cleanup` skill content) → PR #10 — merged
- #117, #119, #120, #121 — remain open as v3.0 roadmap

## [2.16.0] - 2026-04-30

### Hardened Claude Desktop install path

This release makes the `.mcpb` extension actually install and run inside Claude Desktop on macOS — the v2.15.0 build was blocked by macOS library validation rejecting our locally-built `better_sqlite3.node` (different Apple Team ID from Anthropic's). Switching to `node:sqlite` removes the native binding entirely; the runtime now inherits Claude Desktop's process signature and loads cleanly.

Tool count: 91 → 93.

#### 🛠️ Changed

- **`better-sqlite3` → `node:sqlite`** (Node 22.5+ built-in). Same SQLite file format → existing `~/.imap-mcp/data.db` opens transparently with no migration required. The native binding ships inside Node itself, sidestepping the library-validation rejection that affects any third-party `.node` in a hardened/notarized macOS app. Issue #117 (long-running bulk-operation persistence) leans on this.
  - `database-service.ts` — `import { DatabaseSync } from 'node:sqlite'` replaces `import Database from 'better-sqlite3'`. All 33 SQL `@param` placeholders converted to `$param` (node:sqlite doesn't accept the `@`-prefix).
  - `migration-service.ts` — `db.transaction(fn)` (better-sqlite3 specific) replaced with a manual `BEGIN / COMMIT / ROLLBACK` helper.
  - `results-service.ts`, `append-retry-service.ts` — BLOB-read sites now coerce `Uint8Array` (node:sqlite return type for BLOB) to `Buffer` before `.toString('hex')`.
  - `attachment-staging-service.ts`, `database-service.ts` — `stmt.all() as T[]` casts updated to `as unknown as T[]` for the stricter `Record<string, SQLOutputValue>[]` return type.
  - `dxt/build.mjs` — `npm rebuild better-sqlite3 --runtime=electron --target=...` step removed (no native deps to rebuild).
  - `better-sqlite3` and `@types/better-sqlite3` removed from dependencies.

- **DXT manifest spec compliance** — multiple validation errors when installing the v2.15.0 `.mcpb`:
  - `dxt_version: "0.1"` → `manifest_version: "0.3"` (current spec).
  - `tools[]` entries no longer include `inputSchema` (DXT spec only allows `name` + `description`; full schemas are served via runtime `tools/list`).
  - `user_config.log_level` no longer uses `enum` (the `string`/`number`/`boolean`/`directory`/`file` types are the only valid `type` values; enums are surfaced via description).
  - `dxt/build.mjs` updated accordingly.

- **MCP tool annotations** for all 91 → 93 tools. Drives Claude Desktop's "Tool Permissions" UI: tools appear under **Read-only** vs **Write/delete** groups based on `readOnlyHint` and `destructiveHint`; tools that hit external systems (IMAP/SMTP/UserCheck/DNS) also carry `openWorldHint: true`.
  - New `src/tools/annotations.ts` — central table mapping every tool name to `{ readOnlyHint, destructiveHint, idempotentHint?, openWorldHint? }`.
  - `src/tools/index.ts` transparently injects annotations on every `server.registerTool` call — no churn across the 12 tool files.

- **Build script bundle pruning** — `dxt/build.mjs` now drops `electron` and `@electron/*` from the bundled `node_modules` (kept as a devDep for native-binding rebuild experiments). Bundle size: 33 MB.

#### 🐛 Fixed

- **Circuit breaker false-positive OPEN state** (Issue #116). Hostinger and other providers that aggressively close idle IMAP connections were tripping the breaker via the `client.on('error')` socket-event handler — even though the auto-reconnect path absorbed every event. Fix: don't increment the breaker on transient socket events; only on hard failures (auth, IMAP-disabled, all-retries-exhausted).
- **Circuit breaker / metrics inconsistency** — `recordCircuitBreakerFailure` now also bumps `metadata.metrics.failedOperations` and `totalOperations` so a tripped breaker always correlates with a non-zero failure count in `imap_get_metrics` output.
- **`imap_append_message` (PR from WP4 in v2.15.0) — already shipped, noting here for completeness:** ImapFlow's `append(path, content, flags?, idate?)` takes flags + idate as positional args, not as a single options object. The wrapper had been silently failing for every prior caller.

#### ✨ Added

- **`imap_get_circuit_breaker`** — read-only diagnostic returning the per-account breaker state, failure count, threshold, last-failure reason, and timeout. Use to understand why operations are being blocked when `imap_get_metrics` shows zero failures.
- **`imap_reset_circuit_breaker`** — destructive tool that manually resets the breaker to CLOSED with zero counters. Useful when the 60s `setTimeout` HALF_OPEN transition feels too slow.
- **MCP tool annotations** — all 93 tools categorized; Claude Desktop's Tool Permissions UI now groups them automatically.

#### 📦 Distribution

- `.mcpb` install path verified end-to-end on macOS arm64. Server reports `serverInfo: { name: "imap-mcp-pro", version: "2.16.0" }` to Claude Desktop, all 93 tools are listed via `tools/list`, and tool calls succeed against a live `~/.imap-mcp/data.db`.

#### 🛡️ Backward compatibility

- No schema changes (DB stays at 1.10.0).
- All env vars from v2.15.0 continue to work.
- All tool surfaces preserved; +2 new diagnostic tools.

## [2.15.0] - 2026-04-30

### v2.0 Reliability & Attachments — full ship

Completes the v2.0 spec (tracker #97). Four work packages, all merged:

- **WP4** Sent Folder Placement (#98 / PR #110)
- **WP3** SMTP Send Hardening (#99 / PR #111)
- **WP1** Attachment-by-Reference (#100 / PR #112)
- **WP2** Attachment Staging API (#101 / PR #113)

Tool surface: **80 → 91** (+11). Schema: **1.7.0 → 1.10.0** (3 reversible migrations).

#### ✨ Added

**Sent Folder Placement (WP4, PR #110)**
- `imap_send_email` now appends sent messages to the user's IMAP Sent folder by default. Resolution chain: cache → SPECIAL-USE `\Sent` (RFC 6154) → provider preset (Gmail / Outlook / iCloud / Fastmail / Yahoo / Hostinger / Zoho / GMX / ProtonMail / Mailbox.org / Posteo) → fallback name probe → optional auto-create → failed.
- New params on `imap_send_email`: `appendToSent` (default `true`), `sentFolderOverride`, `forceAppendToSent`, `isReply`.
- Bcc preserved in the Sent copy per RFC 5322 §3.6.3 (via `MailComposer` with `keepBcc=true`); SMTP delivery path still strips Bcc as required.
- Gmail special-case: APPEND auto-skipped because Gmail server-copies sent messages (override with `forceAppendToSent`).
- Structured `result` codes: `sent_and_archived`, `sent_not_archived`, `send_failed`. APPEND failure does **not** fail the SMTP send.
- Durable APPEND retry queue: failed APPENDs queued AES-256-GCM encrypted, retried every 5 min for 24 h, surfaced via `imap_list_unarchived_sends`.
- New tools: `imap_test_sent_folder`, `imap_list_unarchived_sends`.

**SMTP Send Hardening (WP3, PR #111)**
- Pooled SMTP transports via nodemailer pool, keyed by accountId; configurable max-connections / idle-timeout / max-lifetime / health-check.
- Retry classifier with 4 categories: transient / permanent / authentication / configuration. Exponential backoff with jitter, default 3 attempts / 1 s base / 30 s cap. Auth failures explicitly do **not** retry.
- Provider-aware error guidance for the common auth-failure modes (Gmail app passwords, Outlook modern auth, Yahoo / iCloud / Fastmail app passwords, ProtonMail Bridge).
- Per-account SMTP metrics: send total, success/failure, retry counts split by category, durations, last-error.
- New tools: `imap_test_smtp` (TLS info, EHLO capabilities, AUTH methods, RTT, optional verbose transcript), `imap_get_smtp_metrics`, `imap_reset_smtp_metrics`.

**Attachment-by-Reference (WP1, PR #112)**
- New `imap_send_email` params: `attachmentPaths` (string[]), `attachmentContentTypes` (string[]), `attachmentFilenames` (string[]). Server reads, validates, encodes — no base64 in the JSON payload.
- Validation gate: absolute path required; literal `..` segments rejected before realpath; `fs.realpath` then containment check inside allowed dirs (allowed dirs themselves realpath'd up front to handle e.g. macOS `/tmp` → `/private/tmp` symlinks); regular-file + readable + per-file size cap + aggregate size cap.
- Multi-tenant per-user override: `users.allowed_attachment_dirs` column (CSV) takes precedence over the global `IMAP_MCP_ALLOWED_ATTACHMENT_DIRS`.
- MIME detection via `mime-types`; filenames sanitized per RFC 2183 (separators → `_`, leading dots stripped, control chars dropped, capped at 255 bytes).
- Existing base64 `content` workflow unchanged.

**Attachment Staging API (WP2, PR #113)**
- 4-step chunked upload: `imap_attachment_stage_init` → `imap_attachment_stage_append × N` → `imap_attachment_stage_finalize` → `imap_send_email stagedAttachmentIds=[...]`. Or `imap_attachment_stage_cancel` to discard.
- Out-of-order chunks reassemble correctly; duplicate `chunkIndex` is idempotent.
- Storage: `{stagingDir}/{userId}/{stagingId}/chunk-NNNNNN.bin`; finalize streams through SHA-256 and concatenates into `assembled.bin`.
- Per-user disk quota enforced at init (`IMAP_MCP_MAX_STAGING_BYTES_PER_USER`, default 500 MiB). Default 1-hour TTL, configurable per session.
- 15-min GC sweep drops expired sessions; consumed sessions cleaned on send success.
- New tools: `imap_attachment_stage_init`, `imap_attachment_stage_append`, `imap_attachment_stage_finalize`, `imap_attachment_stage_cancel`, `imap_list_staged_attachments`.

#### 🛠️ Changed

- `imap_send_email` returns a structured `result` field: `sent_and_archived` / `sent_not_archived` / `send_failed` / `attachment_validation_failed` / `staged_attachments_not_found` / `staged_attachments_unavailable` / `staged_attachments_unauthorized`. Existing callers that only checked `success: true` still work but now also have actionable diagnostic info on failure paths.
- `imap_send_email`'s `attachments[]` legacy form is unchanged; new `attachmentPaths`, `stagedAttachmentIds`, and additional/optional params are additive.

#### 🐛 Fixed

- **`imap_append_message` had been silently failing** with "Command failed" since it was added (PR #52). The wrapper passed `{ flags, internalDate }` as a single object to ImapFlow's `client.append()` whose API takes `(path, content, flags, idate)` as **positional args**. Surfaced during WP4 verification against a real IMAP server. Affects every prior caller of `imap_append_message`.

#### 📊 Schema migrations (1.7.0 → 1.10.0, all reversible)

- `1.7.0 → 1.8.0` — `sent_folder_cache` + `append_retry_queue` (WP4)
- `1.8.0 → 1.9.0` — `users.allowed_attachment_dirs` column (WP1)
- `1.9.0 → 1.10.0` — `attachment_staging` table (WP2)

#### 🛡️ Backward compatibility

No breaking changes. Existing tool invocations without the new params behave identically (defaults preserve prior behavior; e.g., `appendToSent` defaults to `true` but Gmail auto-skips so no unexpected duplicates). All 17 `IMAP_MCP_*` env vars from earlier releases continue to work; new ones are additive.

#### 🧪 Verification

Each WP shipped with a live-data harness that ran against real IMAP/SMTP accounts. Results captured in the per-PR descriptions:
- WP4: 4/4 against Hostinger + Gmail
- WP3: 7/7 (classifier table + provider lookup + backoff + live `testSmtp` + pool reuse + auth-no-retry)
- WP1: 15/15 (validator gate cases)
- WP2: 8/8 (10 MiB chunked upload SHA-256 match, out-of-order, duplicate, quota, cancel, GC, multi-user)

## [2.14.0] - 2026-04-29

### Anthropic SDK Alignment & Claude Desktop Extension (.mcpb)

Major initiative aligning the server with the official `@modelcontextprotocol/sdk` (Node) and shipping a Claude Desktop Extension (`.mcpb`). End users can now install via Settings → Extensions and configure through a native settings panel — no terminal or JSON config required. Tracker: #102.

#### ✨ Added

- **Claude Desktop Extension packaging** (#106, closes #79)
  - `dxt/manifest.template.json` — DXT 0.1 manifest with `server.type: "node"`, full `user_config` panel (data dir, log level, allowed attachment dirs, encryption key, max attachment size, auto-create sent folder, user ID), and 81-tool catalog merged at build time.
  - `dxt/build.mjs` — 8-step build script: build → stage → prune → rebuild native deps → assets → tools manifest → zip → SHA-256.
  - `dxt/icon.png` — 256×256 derived from existing `AppIcon.icns`.
  - Build artifact: `dxt/build/imap-mcp-pro-{version}-{platform}.mcpb`.
  - Build verified on macOS arm64 (35.84 MB archive).
- **Configuration surface refactor** (#104)
  - `src/config/server-config.ts` — Zod schema for 32 fields across 8 groups, every field with type, description, default, and validation bounds.
  - `src/config/loader.ts` — multi-source loader (CLI > env > file > defaults), YAML/TOML/JSON config files, provenance tracking per leaf.
  - `src/config/cli.ts` — short-circuit dispatcher with documented exit codes.
  - New CLI flags: `--print-config-schema`, `--validate-config`, `--print-tools-manifest`.
- **Three-stage startup hardening** (#105, closes #80)
  - `src/startup.ts` — `timeStage()` orchestrator with structured ISO-timestamped stderr logs.
  - Pre-handshake budget enforced at 2s (verified 12 ms on reference hardware).
  - Documented exit codes (1=CONFIG, 2=DATABASE, 3=DEPENDENCY, 4=PERMISSION).
  - Explicit MCP capability negotiation: `{ tools: { listChanged: false } }`.
- **SDK upgrade** (#103) — `@modelcontextprotocol/sdk@^1.15.1 → ^1.22.0`. Brings `registerTool` accepting `ZodType<object>`, SEP-986 tool name format, SEP-1319 typecheck fixes, SEP-1034/1330 elicitation defaults.
- **Audit deliverable** — `docs/sdk_audit_2026-04-29.md` with full inventory of imports, tool catalog, env vars, and pre-handshake hot-spots.
- **Documentation** (#107)
  - `EXAMPLES.md` — seven worked Claude conversation transcripts.
  - `docs/ARCHITECTURE.md` — contributor reference: layout, startup stages, response-shape policy, tool-add recipe, migration recipe.
  - `README.md` — Claude Desktop Extension install instructions, troubleshooting section with per-platform log paths, doc index.

#### 🔧 Changed

- `src/index.ts` refactored to use the three-stage startup orchestrator. All existing behavior preserved; structured logs added.
- `dotenv.config()` still runs before config loader so local `.env` files continue to populate `process.env`.

#### 🛡️ Backward compatibility

Every `IMAP_MCP_*` env var documented before this release maps to a `ServerConfig` field via `ENV_VAR_MAPPING`. Also `MCP_USER_ID` and `CLAUDE_DESKTOP_EXTENSION`. **No breaking changes for existing users.** Verified by running `--validate-config` against existing setups. Migration guide: see `MIGRATION.md`.

#### ⚠️ Known cap

SDK pin held at `1.22.0` (not the latest `1.29.0`) — versions `1.23.0+` introduced Zod v3/v4 dual-support conditional types that overflow TypeScript's type-checker recursion with our 80-tool registration surface. Bisected; documented in the SDK audit. Path forward: migrate this project to Zod v4, or add explicit type annotations at each `registerTool` call site. Tracked as a post-release follow-up.

#### 🧪 Testing

- Build clean (`npm run build`)
- Server starts under SDK 1.22, all 81 tools register, handshake completes, SIGTERM clean
- All four config sources (default/file/env/cli) round-trip correctly with provenance
- Bad enum config exits with code 1 and clear error
- `.mcpb` archive structure validated (`unzip -l`); server runs from extracted layout
- Migration system applied 1.2.0 → 1.7.0 cleanly on a real database

## [2.11.0] - 2025-11-07

### Automated Unsubscribe Execution

This minor release adds automated unsubscribe execution capabilities, completing the subscription management workflow started in v2.10.0. Addresses Issue #47.

#### ✨ Features

**Automated Unsubscribe Execution (#47)**
- Complete unsubscribe execution service with multiple protocol support:
  - HTTP GET: Simple link-based unsubscribe
  - HTTP POST: RFC 8058 One-Click unsubscribe (form-based)
  - Mailto: Email-based unsubscribe requests via SMTP
  - Auto-detection of appropriate method based on link format
- Security and reliability features:
  - URL validation with protocol checking (HTTP/HTTPS only)
  - Domain blacklist for known malicious domains
  - Rate limiting (10 requests per minute) to prevent abuse
  - Request timeout (30 seconds default) to prevent hanging
  - Dry-run mode for testing without actual execution
- Database enhancements:
  - 3 new tracking columns in `subscription_summary` table:
    - `unsubscribe_attempted_at`: Timestamp of last attempt
    - `unsubscribe_result`: Result status (success, failed, error)
    - `unsubscribe_error`: Error details if applicable
  - Database version 1.2.0
  - Schema migration script: `schema_update_1.1.0_TO_1.2.0.sql`
- Two new MCP tools:
  - `imap_list_unsubscribe_candidates`: List all subscriptions with unsubscribe links, with filtering and sorting
  - `imap_execute_unsubscribe`: Execute unsubscribe for one or multiple senders with result tracking
- Implementation in:
  - `src/services/unsubscribe-executor-service.ts`: Core execution logic (410 lines)
  - `src/services/database-service.ts`: Database tracking method
  - `src/tools/subscription-tools.ts`: New MCP tools
  - `src/database/schema.sql`: Enhanced schema v1.2.0

#### 🔧 Improvements

**Installation & Updates**
- Enhanced Makefile to automatically apply schema migrations during updates
- Detects current database version and applies appropriate migration scripts
- Build script updated to include all schema migration files in distribution

#### 🐛 Bug Fixes

**Type System**
- Fixed Account vs ImapAccount type conversion for SMTP operations
- Added proper decrypted account handling for mailto unsubscribe
- Corrected EmailComposer interface usage with required 'from' field

## [2.10.0] - 2025-11-07

### Subscription Management System

This minor release introduces comprehensive subscription management with unsubscribe link extraction, aggregated subscription tracking, and categorization. Part of Issue #45 Phase 4.

#### ✨ Features

**Subscription Management (#45 Phase 4, #15)**
- Automatic unsubscribe link extraction from emails
  - RFC 2369 List-Unsubscribe header parsing
  - RFC 8058 List-Unsubscribe-Post (One-Click) support
  - HTML body link extraction with pattern matching
  - Plain text body link extraction as fallback
- Database schema enhancements:
  - `unsubscribe_links` table: Stores individual email unsubscribe links with full context
  - `subscription_summary` table: Aggregates subscriptions by sender with statistics
  - Database version 1.1.0 with migration support
  - Schema migration script: `schema_update_1.0.0_TO_1.1.0.sql`
- Six new MCP tools:
  - `imap_extract_unsubscribe_links`: Scan folder for unsubscribe links (processes 100+ emails)
  - `imap_get_subscription_summary`: View all subscriptions with stats and categories
  - `imap_mark_subscription_unsubscribed`: Track unsubscribe status with timestamps
  - `imap_update_subscription_category`: Categorize subscriptions (marketing, newsletter, promotional, transactional, other)
  - `imap_update_subscription_notes`: Add notes about subscriptions
  - `imap_get_unsubscribe_links`: Get detailed unsubscribe link history
- Intelligent email categorization:
  - Automatic detection of marketing, newsletters, promotional, and transactional emails
  - Based on sender address, subject line, and common patterns
- Subscription statistics:
  - Total email count per sender
  - First seen / Last seen timestamps
  - Unsubscribe status tracking
  - Category breakdown
- Multiple unsubscribe methods supported:
  - HTTP/HTTPS links
  - Mailto links
  - Both (hybrid approach)
- Implementation in:
  - `src/services/unsubscribe-service.ts`: Core extraction logic (356 lines)
  - `src/services/database-service.ts`: Database operations for subscriptions
  - `src/tools/subscription-tools.ts`: MCP tool implementations
  - `src/database/schema.sql`: Enhanced schema v1.1.0
  - `src/types/database-types.ts`: New SubscriptionSummary interface

#### 🔧 Database Changes

- Schema version updated from 1.0.0 to 1.1.0
- New tables: `subscription_summary` with comprehensive indexing
- Migration script provided for existing installations
- Backwards compatible with existing data

## [2.9.0] - 2025-11-06

### Email Confidence Scoring System

This minor release introduces a comprehensive anti-spoofing detection system that analyzes email headers to calculate confidence scores and identify potential phishing attempts.

#### ✨ Features

**Email Confidence Scoring (#42)**
- Comprehensive anti-spoofing detection through header-only analysis
- Confidence scoring from -100 (likely spoofed) to +100 (highly legitimate)
- Three new MCP tools:
  - `imap_score_email_confidence`: Analyze single email for spoofing indicators
  - `imap_bulk_score_emails`: Process 100+ emails in < 5 seconds with headers-only analysis
  - `imap_analyze_folder_confidence`: Get folder-wide confidence statistics
- Advanced detection rules:
  - Free email providers + financial keywords (-40 points)
  - Suspicious TLDs (.tk, .ml, .xyz, etc.) (-15 points)
  - Reply-To domain mismatch (-20 points)
  - Typosquatting detection with character substitution patterns (-30 points)
  - Display name spoofing detection (-25 points)
  - Urgency + financial keyword combinations (-20 points)
  - SPF authentication validation (+15 pass, -20 fail)
  - DKIM signature verification (+20 pass, -25 fail)
  - DMARC policy validation (+25 pass, -30 fail)
  - Full authentication suite bonus (+10 for all three passing)
  - Message-ID validation (+10 for valid, -10 missing, -15 for mismatch)
  - Return-Path validation (-15 for mismatch)
  - Corporate domain bonus (+10 for non-free providers)
  - Known legitimate domain bonus (+20 for well-known brands)
- Detailed score breakdowns with auditable rule explanations
- Performance-optimized for bulk operations using headers-only fetching
- Implementation in src/services/confidence-scoring-service.ts:1-570 and src/tools/scoring-tools.ts:1-270

## [2.8.1] - 2025-11-06

### Web UI & Provider Configuration Fixes

This patch release addresses several critical Web UI bugs, adds headers-only email fetching, and improves the installation system.

#### ✨ Features

**Headers-Only Email Fetching (#46)**
- Added `headersOnly` parameter to `imap_get_email` MCP tool
- Fetch email metadata without downloading body content
- Saves bandwidth and conserves LLM context space
- Useful for bulk email analysis, thread tracking, sender verification
- Implementation in src/services/imap-service.ts:521-552 and src/tools/email-tools.ts:58-81

**System Info Display (#40)**
- Web UI footer now displays current username instead of UUID
- Shows database schema version and size
- /api/system-info endpoint returns human-readable username
- Implementation in src/web/server.ts:620-651

#### 🐛 Bug Fixes

**Web UI Settings Panel**
- Fixed settings button functionality - viewSettings() was referencing non-existent 'addAccountForm' element
- Corrected element ID to 'credentialsForm' for proper panel hiding/showing (public/js/app.js:865-877)
- Settings panel now opens correctly when clicking the settings button

**SMTP Configuration Consistency**
- Fixed SMTP settings field name inconsistency between two code paths
- Standardized to use 'secure' field instead of mixed 'tls'/'secure' usage
- Line 186-191: Changed from `tls` to `secure` for account creation
- Line 610-635: Removed conditional checks so provider settings ALWAYS populate fields
- SMTP settings now save correctly in the Web UI

**Hostinger Email Provider**
- Corrected default SMTP settings: smtp.hostinger.com, Port 465, TLS enabled
- Changed imapSecurity from 'SSL' to 'TLS' (src/providers/email-providers.ts:255)
- Changed smtpSecurity from 'SSL' to 'TLS' (src/providers/email-providers.ts:258)

#### 🔧 Improvements

**Intelligent Installation System**
- `make install` now detects existing installations automatically
- Checks for both package.json and data.db presence
- Runs `make update-internal` instead of fresh install when detected
- Preserves database while updating code (Makefile:106-123)

**Update Process Enhancement**
- Created new `update-internal` Makefile target (lines 147-200)
- Stops service before update
- Creates timestamped backup of installation directory
- Updates files: dist/, node_modules/, public/, package.json
- Preserves database and configuration
- Applies database schema updates via DatabaseService
- Restarts service after update
- Shows version change and backup location

**Documentation**
- Added comprehensive environment variables section to README (lines 202-242)
- Documented: MCP_USER_ID, PORT, NODE_ENV, IMAP_MCP_VERSION
- Included multi-user configuration examples
- Explained data isolation per user

#### 📝 Files Modified
- `Makefile` - Intelligent install detection and update-internal target
- `public/js/app.js` - Fixed viewSettings() and SMTP field consistency
- `src/providers/email-providers.ts` - Corrected Hostinger TLS settings
- `README.md` - Added environment variables documentation
- `CHANGELOG.md` - This file

#### ⚠️ Breaking Changes

**None** - All changes are backward compatible.

#### 🎯 Impact

- Settings panel is now accessible in Web UI
- SMTP configuration saves correctly for all providers
- Hostinger users get correct default settings
- Updates preserve user data and apply schema changes
- Better documentation for multi-tenant deployments

---

## [2.6.0] - 2025-11-05

### Phase 2 - SQLite3 Integration & Multi-Tenant Architecture

This release completes the SQLite3 integration (Issue #6), replacing the JSON-based AccountManager with a proper database layer featuring AES-256-GCM encryption, multi-tenant user management, and MSP (Managed Service Provider) support.

#### ✨ New Features

**SQLite3 Database Layer**
- ✅ **Complete migration from AccountManager to DatabaseService**
  - Better-sqlite3 integration for robust persistence
  - AES-256-GCM encryption at rest with integrity protection (auth tags)
  - Secure encryption key storage with 0o600 permissions (~/.imap-mcp/.encryption-key)
  - Automatic encryption/decryption on all database operations
  - Transactional integrity for multi-row operations

**Multi-Tenant User Management (MSP Architecture)**
- ✅ **9 new user and account management MCP tools:**
  - `imap_create_user` - Create new user
  - `imap_list_users` - List all users
  - `imap_get_user` - Get user details by username
  - `imap_db_add_account` - Add encrypted IMAP account to database
  - `imap_db_list_accounts` - List accounts for user
  - `imap_db_get_account` - Get decrypted account details
  - `imap_db_remove_account` - Remove account from database
  - `imap_share_account` - Share account with another user (MSP feature)
  - `imap_unshare_account` - Revoke account access
- ✅ **Role-based access control:**
  - Owner, Admin, User, and ReadOnly roles
  - Account sharing with granular permissions
  - User activation/deactivation support
- ✅ **Organization support:**
  - Multi-organization architecture for MSPs
  - Isolate accounts by organization

**Database Schema**
- `users` table: User profiles with org assignment and role management
- `accounts` table: Encrypted IMAP account credentials with SMTP support
- `account_shares` table: Many-to-many relationship for account sharing
- Foreign key constraints for referential integrity
- Optimized indexes for common queries

#### 🔧 Technical Improvements

**Updated Services:**
- All MCP tools now use DatabaseService instead of AccountManager
- `src/tools/account-tools.ts` - Converted to use encrypted database storage
- `src/tools/email-tools.ts` - Updated to fetch accounts from database
- `src/tools/folder-tools.ts` - Updated signature for database integration
- `src/tools/user-tools.ts` - NEW: Complete user management toolset

**Security Enhancements:**
- AES-256-GCM encryption with unique IV per encrypted field
- Integrity protection via authentication tags
- Secure key generation and storage
- No plaintext credentials in memory or logs

**Code Organization:**
- `src/services/database-service.ts` - Centralized database operations
- Consistent error handling across all database operations
- Type-safe database queries with TypeScript

#### 📊 Tool Count

**Total MCP Tools: 41** (was 32)
- User management: 9 tools
- Account management: 5 tools (updated to use DatabaseService)
- Email operations: 18 tools (updated signatures)
- Folder operations: 6 tools (updated signatures)
- Meta/discovery: 3 tools

#### ⚠️ Deprecation Notices

**AccountManager Deprecated:**
- `imap_add_account` - DEPRECATED: Use `imap_db_add_account` instead
- Legacy tool creates default user automatically for backward compatibility
- AccountManager class will be removed in v3.0.0

#### 🔒 Security

- All IMAP account passwords encrypted at rest with AES-256-GCM
- All SMTP passwords encrypted at rest with AES-256-GCM
- Encryption key protected with restrictive file permissions (0o600)
- Automatic decryption only when needed for IMAP/SMTP operations

#### 🐛 Bug Fixes

- Fixed account retrieval to use encrypted database storage
- Fixed email sending to properly convert database accounts to ImapAccount format
- Fixed reply/forward operations to work with DatabaseService

#### ⚠️ Breaking Changes

**None** - Backward compatibility maintained:
- Legacy `imap_add_account` still works (creates default user automatically)
- Existing tools accept same parameters
- Migration of old accounts can be done manually by re-entering credentials

#### 🎯 What's Next

Phase 2 complete! Next priorities:
- Phase 3: Level 3 reliability features testing
- Phase 4: Rules engine and SPAM detection (Issues #1, #2, #3)
- Phase 5: Testing & DevOps (test suite, installation system)

---

## [2.5.1] - 2025-11-05

### Phase 1 Critical Fixes - Stability & Reliability

This release addresses three critical issues identified in the security audit, significantly improving server stability and preventing resource exhaustion.

#### 🔴 Critical Fixes

**Issue #20: Missing Error Handling in MCP Tools**
- ✅ **Added comprehensive error handling wrapper to all 32 MCP tools**
  - Prevents server crashes from uncaught exceptions
  - Returns standardized error responses in JSON format
  - Logs errors for debugging while maintaining server stability
  - Custom error classes for better error categorization
- **Implementation**: Created `withErrorHandling()` wrapper utility
- **Custom Errors**: `AccountNotFoundError`, `ConnectionError`, `AuthenticationError`, `OperationError`
- **Impact**: Zero server crashes from tool errors

**Issue #22: Unbounded Memory Growth**
- ✅ **Implemented LRU (Least Recently Used) cache for operation metrics**
  - Limits metrics storage to 1,000 entries (configurable)
  - Automatically evicts least recently used metrics
  - Prevents indefinite memory growth from long-running services
- ✅ **Added size limit to operation queue**
  - Maximum 1,000 queued operations
  - FIFO eviction when queue is full
  - Prevents memory exhaustion during connection outages
- **Implementation**: New `LRUCache`, `TTLCache`, and `HybridCache` utilities
- **Memory Impact**: Bounded memory usage with predictable growth

**Issue #21: Incomplete Operation Queue**
- ✅ **Implemented operation queue processor**
  - Processes queued operations every 5 seconds
  - Prioritizes operations (high priority first, older first)
  - Automatic retry with exponential backoff (max 3 retries)
  - Executes operations when connections become available
- ✅ **Added queue management methods**
  - `queueOperation()`: Queue operations during outages
  - `processQueue()`: Process pending operations
  - `executeQueuedOperation()`: Dynamic operation execution
  - `destroy()`: Cleanup on shutdown
- **Impact**: Operations no longer lost during connection issues

#### 🔧 Technical Improvements

**New Utilities Created:**
- `src/utils/error-handler.ts` - Error handling and validation utilities
- `src/utils/memory-manager.ts` - LRU/TTL cache implementations

**Code Quality:**
- All MCP tools now have consistent error handling
- Improved logging for debugging and monitoring
- Better resource cleanup on service shutdown

#### 🐛 Bug Fixes

- Fixed potential memory leaks from unbounded metrics collection
- Fixed lost operations when connections were unavailable
- Fixed server crashes from unhandled promise rejections in tools

#### ⚠️ Breaking Changes

**None** - All changes are backward compatible. Existing integrations continue to work without modification.

#### 📊 Metrics

- **Error Handling**: 32/32 tools protected (100%)
- **Memory Management**: Bounded growth implemented (Issue #22 resolved)
- **Queue Processing**: Fully functional processor (Issue #21 resolved)
- **Server Stability**: Crash-resistant MCP tools (Issue #20 resolved)

#### 🎯 What's Next

Phase 1 critical fixes complete! Next priorities:
- Phase 2: Complete SQLite3 integration (Issue #6)
- Phase 3: Feature development (rules engine, SPAM detection)
- Phase 4: Testing & DevOps (test suite, installation system)

---

## [2.5.0] - 2025-11-05

### ImapFlow Migration & Security Improvements (Issue #27)

This release migrates from the unmaintained `node-imap` library to the modern `imapflow` library, bringing significant improvements in reliability, security, and maintainability.

#### ✨ Major Changes

**ImapFlow Migration**
- **Replaced `node-imap` (unmaintained since 2019) with `imapflow` (actively maintained)**
  - Native TypeScript support with better type safety
  - Promise/async-await API (vs callback-based)
  - Built-in connection pooling and keepalive
  - Better RFC compliance
  - Improved error handling and diagnostics

**Security Improvements**
- **Resolved all 3 HIGH severity npm vulnerabilities** from node-imap
  - Fixed path traversal vulnerability
  - Fixed ReDoS vulnerability
  - Eliminated unmaintained dependency risks

**Code Simplifications**
- **Removed ~200 lines of manual keepalive logic** - ImapFlow handles this automatically
- **Simplified connection management** - No more callback-to-promise wrappers
- **Cleaner error handling** - Native promise rejections instead of event-based errors
- **Better mailbox locking** - Prevents concurrent access issues

#### 🔧 Technical Improvements

**Preserved Features (Level 1-3 Reliability)**
- ✅ Exponential backoff retry logic (Level 2)
- ✅ Circuit breaker pattern (Level 3)
- ✅ Operation metrics tracking (Level 3)
- ✅ Connection state management
- ✅ All 32 MCP tools remain fully functional

**Updated Type Definitions**
- Updated `CircuitBreakerState` type for better state tracking
- Updated `ConnectionMetrics` type for cleaner metrics
- Added proper type conversions for ImapFlow's Set-based flags

**Performance Enhancements**
- More efficient UID handling (comma-separated strings vs arrays)
- Better memory management with native async iterators
- Reduced overhead from removed manual keepalive implementation

#### 🐛 Bug Fixes

- Fixed email flag handling (Set<string> → string[] conversion)
- Fixed email address parsing from mailparser (AddressObject handling)
- Fixed bulk operation return types for consistency
- Fixed metrics tracking for operation latencies

#### 📦 Dependencies

**Added:**
- `imapflow@1.0.172` - Modern IMAP client

**Removed:**
- `node-imap@0.8.19` - Unmaintained, security vulnerabilities
- `@types/node-imap` - No longer needed

#### ⚠️ Breaking Changes

**None** - This is a drop-in replacement. All 32 MCP tools maintain the same API contracts.

#### 🔄 Migration Notes

For developers extending this codebase:
- Connection methods now return Promises (no callback parameter)
- Folder attributes are now properly typed as string[]
- Email UIDs should be passed as comma-separated strings for bulk operations
- ImapFlow's `search()` can return `false` if no results (handled automatically)

#### 👏 Credits

Migration performed by Claude Code following best practices for dependency updates with comprehensive testing and validation.

## [2.4.0] - 2025-11-05

### Service Discovery & Folder Management (Issues #16, #19)

This release adds self-documenting capabilities and complete folder lifecycle management.

#### ✨ New Features

**Service Discovery & Meta Tools (Issue #16)**
- **imap_about Tool**: Returns comprehensive service metadata
  - Service name, description, and version
  - License model (Dual-License)
  - Repository URLs and documentation links
  - Feature highlights (Level 1-3 reliability, bulk operations, etc.)
  - Total tool count and categorization
  - Attribution and contributor information
- **imap_list_tools Tool**: Returns detailed manifest of all available tools
  - Lists all 32 MCP tools with descriptions
  - Filterable by category (account, email, bulk, folder, sending, metrics, meta)
  - Shows parameters for each tool
  - Categorized by function for easy discovery

**Folder Management Operations (Issue #19)**
- **imap_create_folder Tool**: Create new folders/mailboxes
  - Supports hierarchy using "/" delimiter (e.g., "Archive/2024")
  - Full error handling for invalid folder names
- **imap_delete_folder Tool**: Delete existing folders/mailboxes
  - Removes folders completely from IMAP server
  - Validates folder exists before deletion
- **imap_rename_folder Tool**: Rename folders/mailboxes
  - Maintains folder hierarchy
  - Updates all folder references atomically

#### 🎯 Enhanced Claude Integration

**Claude can now answer questions like:**
- "Tell me about the IMAP MCP service"
- "What version is the IMAP MCP service?"
- "What functions are available in IMAP MCP?"
- "Show me all bulk operation tools"
- "List email sending tools"

**Claude can now manage folders:**
- "Create a new folder called Projects"
- "Rename the Old folder to Archive"
- "Delete the Spam folder"

#### 🛠️ Technical Improvements
- New file: `src/tools/meta-tools.ts` for service discovery
- Added folder management methods to `ImapService`:
  - `createFolder(accountId, folderName)`
  - `deleteFolder(accountId, folderName)`
  - `renameFolder(accountId, oldName, newName)`
- Updated MCP server name from 'imap-mcp-server' to 'imap-mcp-pro'
- Updated test-tools.js to verify 32 total tools (up from 27)
- All operations use retry wrapper and circuit breaker pattern

#### 📊 Tool Count
- **Total Tools**: 32 (up from 27)
- **New Tools**: 5
  - `imap_about` - Service information and metadata
  - `imap_list_tools` - Tool discovery and listing
  - `imap_create_folder` - Create new folders
  - `imap_delete_folder` - Delete folders
  - `imap_rename_folder` - Rename folders

#### 📝 Files Modified
- `src/tools/meta-tools.ts` - NEW: Meta/discovery tools
- `src/tools/folder-tools.ts` - Added 3 new folder management tools
- `src/services/imap-service.ts` - Added folder management methods
- `src/tools/index.ts` - Registered meta tools
- `src/index.ts` - Updated server name and version
- `package.json` - Version bump to 2.4.0
- `test-tools.js` - Updated to test 32 tools
- `CHANGELOG.md` - This file

#### 🎉 Benefits
- **Self-Documenting**: Service describes itself to Claude
- **Version Awareness**: Claude always knows current version
- **Discovery**: Users explore capabilities through conversation
- **Complete Folder Management**: Full lifecycle operations (create, delete, rename)
- **Organization**: Users can create custom folder structures
- **Cleanup**: Delete unused folders
- **Flexibility**: Rename folders as needs change

#### GitHub
- Closes Issue #16: https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues/16
- Closes Issue #19: https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues/19
- Addresses Issue #11: Version Query Tool (via imap_about)

---

## [2.2.0] - 2025-01-05

### Web UI Connection Testing (Issue #5)

This release significantly improves the user experience during account setup by adding comprehensive connection testing with detailed feedback.

#### ✨ New Features
- **Test Connection Button**: Now visible on all account forms (new and edit)
- **Detailed Success Information**: Shows folder count, connection time, server details, and TLS status
- **Smart Error Messages**: Context-aware error messages with actionable troubleshooting tips
- **Real-time Feedback**: Test connection without leaving the setup form

#### 🎯 Enhanced Connection Test Display

**Success Display Shows:**
- 📊 Number of folders found
- ⏱️ Connection time in milliseconds
- 🖥️ Server host and port
- 🔒 TLS enabled/disabled status

**Error Display Shows:**
- Clear error message
- Helpful troubleshooting tips based on error type:
  - **Authentication failures**: Suggests app-specific passwords
  - **Timeouts**: Recommends checking host/port/firewall
  - **Connection refused**: Suggests verifying server and IMAP settings
  - **SSL/TLS errors**: Recommends toggling TLS settings
  - **DNS errors**: Suggests checking hostname spelling

#### 🛠️ Technical Improvements
- Enhanced `/api/test-connection` endpoint with detailed response
- Connection time measurement
- Error categorization with regex matching
- Improved UI with better visual hierarchy

#### 🎨 UI Enhancements
- Test button always visible (previously only in edit mode)
- Redesigned success/error display with icons and structure
- Better spacing and readability
- Responsive layout for all screen sizes

#### 📝 Files Modified
- `src/web/server.ts` - Enhanced API endpoint with details and helpful errors
- `public/index.html` - Improved test result display UI
- `public/js/app.js` - Updated frontend logic to show details
- `CHANGELOG.md` - This file

#### 🎉 Benefits
- **Better UX**: Immediate feedback on credential correctness
- **Faster Setup**: Test before saving reduces trial-and-error
- **Self-Service Troubleshooting**: Users can diagnose common issues independently
- **Reduced Support Burden**: Clear, actionable error messages

#### GitHub
- Closes Issue #5: https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues/5

---

## [2.1.0] - 2025-01-05

### Unified Bulk Operations Architecture (Issue #4)

This release implements a unified architecture where single operations call bulk operations internally, eliminating code duplication and establishing a consistent pattern.

#### ♻️ Refactored Operations
- **markAsRead**: Now calls `bulkMarkEmails([uid], 'read')` internally
- **markAsUnread**: Now calls `bulkMarkEmails([uid], 'unread')` internally
- **deleteEmail**: Now calls `bulkDeleteEmails([uid], true)` internally

#### ✨ New Copy/Move Operations
- **bulkCopyEmails**: Copy multiple emails to another folder efficiently
- **bulkMoveEmails**: Move multiple emails (copy + mark deleted) efficiently
- **copyEmail**: Single email copy wrapper (calls bulk internally)
- **moveEmail**: Single email move wrapper (calls bulk internally)

#### 🛠️ New MCP Tools (4)
- `imap_copy_email` - Copy single email to another folder
- `imap_bulk_copy_emails` - Copy multiple emails to another folder
- `imap_move_email` - Move single email to another folder
- `imap_bulk_move_emails` - Move multiple emails to another folder

Total Tools: **27** (up from 23)

#### 🎯 Benefits
- **Less Code Duplication**: ~30 lines removed from single operations
- **Consistent Behavior**: All operations use same retry/circuit breaker logic
- **Easier Maintenance**: Changes in one place affect both single and bulk operations
- **New Functionality**: Copy/move operations for better email management
- **MSP-Ready**: Architecture supports multi-tenant account hierarchies

#### 🧪 Testing
- Added `test-tools.js` script to verify all 27 tools register correctly
- Build passes without TypeScript errors
- All tools tested and verified

#### 📝 Files Modified
- `src/services/imap-service.ts` - Refactored operations + new copy/move methods
- `src/tools/email-tools.ts` - Added 4 new MCP tools
- `test-tools.js` - New test script (27 tools expected)
- `README.md` - Updated tool documentation
- `CHANGELOG.md` - This file

#### GitHub
- Closes Issue #4: https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues/4

---

## [2.0.0] - 2025-01-05

### Major Release - IMAP MCP Pro

This major release transforms the project into an enterprise-grade commercial product with extensive reliability and monitoring features.

#### 🏢 Commercial Release
- **Rebranded** as IMAP MCP Pro
- **Transferred** to Temple of Epiphany organization
- **Dual-License Model** implemented:
  - FREE for non-commercial use (personal, educational, non-profit)
  - PAID commercial license for business use
- **Contact**: colin.bitterfield@templeofepiphany.com for commercial licensing

#### ⚡ Level 1: Enhanced Connectivity
- **Enhanced Keepalive**: RFC 2177 compliant NOOP commands every 29 minutes
- **Connection Monitoring**: Real-time connection health tracking
- **Connection Validation**: Proactive connection state verification
- **Error Handlers**: Improved error detection and handling

#### 🔄 Level 2: Advanced Reliability
- **Automatic Reconnection**: Exponential backoff strategy (1s → 2s → 4s → 8s → 60s max)
- **Retry Logic**: Transparent retry wrapper for all operations (max 5 attempts, configurable)
- **Health Checks**: Periodic NOOP every 29 minutes to prevent RFC 9051 timeout
- **Connection State Machine**: Complete state tracking (DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING → ERROR)
- **Bulk Operations**:
  - `imap_bulk_delete_emails` - Delete hundreds/thousands of emails efficiently
  - `imap_bulk_get_emails` - Fetch multiple emails (headers/body/full modes)
  - `imap_bulk_mark_emails` - Mark emails as read/unread/flagged/unflagged

#### 🛡️ Level 3: Production-Grade Resilience
- **Circuit Breaker Pattern**: Prevents cascading failures
  - Opens after 5 failures (configurable)
  - HALF_OPEN state for recovery testing
  - Closes after 2 successes (configurable)
  - Rolling window failure tracking (2-minute default)
- **Operation Queue**: Queues operations during outages
  - 1000 operation max (configurable)
  - Priority queue support
  - Automatic replay when connection restored
  - 3 retries per operation (configurable)
- **Comprehensive Metrics**: Production monitoring
  - Per-connection metrics (operations, success rate, latency, uptime %)
  - Per-operation metrics (count, avg/min/max latency, success rate)
  - MCP tools: `imap_get_metrics`, `imap_get_operation_metrics`, `imap_reset_metrics`
- **Graceful Degradation**: Service resilience
  - Read-only mode when writes fail
  - Result caching (5-minute TTL, configurable)
  - Fallback to last known good data
  - Max degradation time (1 hour default)

#### 🧪 Testing & Validation
- **Test Script**: `test-tools.js` for verifying all 23 MCP tools
- **Tool Categories**: Account, Email, Bulk, Sending, Folder, Metrics
- **Automated Verification**: Exit codes for CI/CD integration

#### 📚 Documentation
- **Launchctl Setup Guide**: Complete macOS service integration (`docs/launchctl-setup.md`)
- **Level 1 Documentation**: Enhanced keepalive details (`docs/timeout-fixes-level1.md`)
- **Example Configurations**: Sample plist file for launchd
- **README Updates**: Comprehensive enterprise feature documentation

#### 🏗️ Architecture Improvements
- **TypeScript Types**: Complete type definitions for all Level 1-3 features
- **Code Organization**: 1126 lines of production-grade ImapService
- **Error Handling**: Enhanced error detection and recovery
- **Logging**: Stderr-based logging (stdout reserved for MCP protocol)

### Changed
- **Package Name**: `@temple-of-epiphany/imap-mcp-pro`
- **Repository**: `https://github.com/Temple-of-Epiphany/imap-mcp-pro`
- **Version**: Bumped to 2.0.0 for major release
- **License**: Changed from MIT to Dual-License model

### Added - MCP Tools
- `imap_bulk_delete_emails` - Bulk email deletion
- `imap_bulk_get_emails` - Bulk email fetching
- `imap_bulk_mark_emails` - Bulk email marking
- `imap_get_metrics` - Connection health metrics
- `imap_get_operation_metrics` - Operation statistics
- `imap_reset_metrics` - Reset metric tracking

Total Tools: **23** (up from 17)

### Technical Details

#### Configuration Options
All new features are configurable per account:

```json
{
  "keepalive": {
    "interval": 10000,
    "idleInterval": 1740000,
    "forceNoop": true
  },
  "retry": {
    "maxAttempts": 5,
    "initialDelay": 1000,
    "maxDelay": 60000,
    "backoffMultiplier": 2
  },
  "circuitBreaker": {
    "failureThreshold": 5,
    "successThreshold": 2,
    "timeout": 60000,
    "monitoringWindow": 120000
  },
  "operationQueue": {
    "maxSize": 1000,
    "maxRetries": 3,
    "processingInterval": 5000,
    "enablePriority": true
  },
  "degradation": {
    "enableReadOnlyMode": true,
    "enableCaching": true,
    "cacheTimeout": 300000,
    "fallbackToLastKnown": true,
    "maxDegradationTime": 3600000
  }
}
```

#### Pull Requests
- [#6](https://github.com/nikolausm/imap-mcp-server/pull/6) - Bulk delete operations
- [#7](https://github.com/nikolausm/imap-mcp-server/pull/7) - Launchctl documentation
- [#8](https://github.com/nikolausm/imap-mcp-server/pull/8) - Level 1 timeout fixes
- [#9](https://github.com/nikolausm/imap-mcp-server/pull/9) - Level 2 comprehensive features
- [#10](https://github.com/nikolausm/imap-mcp-server/pull/10) - Complete suite (submitted to upstream)
- [#11](https://github.com/nikolausm/imap-mcp-server/pull/11) - Test script (submitted to upstream)

### Attribution
Based on the original IMAP MCP Server by Michael Nikolaus (MIT License).
Extensive enterprise enhancements by Temple of Epiphany.

---

## [1.0.0] - 2024-12-XX (Original)

### Original Features (MIT Licensed Base)
- Basic IMAP connection management
- Account management with encrypted storage
- Email operations (search, read, mark, delete)
- SMTP email sending
- Folder management
- Web-based setup wizard
- 15+ email provider presets
- MCP integration with Claude Desktop

**Original Author**: Michael Nikolaus
**Original Repository**: https://github.com/nikolausm/imap-mcp-server
**Original License**: MIT License

---

## Upcoming Features

See [Issues](https://github.com/Temple-of-Epiphany/imap-mcp-pro/issues) for planned features:

- **#1**: Unified bulk operations architecture
- **#2**: Web UI connection testing
- **#3**: SPAM detection API integration

---

## License

This project uses a **Dual-License Model**:
- **Non-Commercial**: FREE for personal, educational, and non-profit use
- **Commercial**: PAID license required for business use

See [LICENSE](LICENSE) for complete terms.

**Contact**: colin.bitterfield@templeofepiphany.com

---

**Note**: This CHANGELOG starts at version 2.0.0 (IMAP MCP Pro). For history prior to the fork and commercial release, see the [original repository](https://github.com/nikolausm/imap-mcp-server).
