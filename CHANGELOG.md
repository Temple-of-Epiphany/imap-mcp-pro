# Changelog

All notable changes to IMAP MCP Pro will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

#### 🚧 Known stale (not fixed in this patch)

- `src/web/server.ts` has three more hardcoded version strings (2.9.0, 2.12.0). The embedded web UI is not exercised by the `.mcpb` distribution; will be fixed when the web UI gets a broader review.

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
