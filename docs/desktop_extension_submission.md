# Claude Desktop Extension — Submission Dossier

**Version:** 1.0.0
**Author:** Colin Bitterfield
**Date Created:** 2026-07-05
**Date Updated:** 2026-07-05
**Purpose:** Paste-ready answers + readiness checklist for the Anthropic Desktop
Extensions directory submission (Google Form: https://forms.gle/tyiAZvch1kDADKoP9,
reviewed by Anthropic for quality + security).

## Pre-submission checklist

- [x] Manifest current-spec (`manifest_version` 0.3), valid `server`/`mcp_config`, installs cleanly
- [x] `display_name`, `description`, `long_description`, `icon`
- [x] `author` (name/email/url), `homepage`, `documentation`, `support`, `repository`
- [x] `license`: PolyForm-Noncommercial-1.0.0 (source-available)
- [x] `privacy_policies` → `PRIVACY.md` live on `main`
- [x] All tools carry human titles + read/destructive/openWorld hints (runtime `tools/list`)
- [x] Export destination lockable from the UI (`allowed_export_dirs`, v2.32.0)
- [x] Released `.mcpb` + SHA-256 attached to the GitHub release
- [x] **Tested on macOS** (primary — validated)
- [ ] **Tested on Windows** (in progress — the submission candidate is v2.32.3+)
- [ ] ~~Linux~~ — **out of scope for this submission** (declared platforms narrowed to `darwin`/`win32`; runtime is pure-JS so it still runs on Linux, just not part of the tested/declared matrix yet)

> `compatibility.platforms` is now `["darwin", "win32"]` — matches what's tested.
> Add `linux` back after a smoke test if/when we want to declare it.

## Field answers (adapt to the live form)

| Field | Answer |
|-------|--------|
| Extension name | `imap-mcp-pro` |
| Display name | IMAP MCP Pro |
| One-line description | Production-grade IMAP & SMTP email integration for Claude Desktop — connect any IMAP account to search, read, organize, send, and export mail locally. |
| Author / org | Colin Bitterfield / Temple of Epiphany |
| Contact email | colin.bitterfield@templeofepiphany.com |
| Repository | https://github.com/Temple-of-Epiphany/imap-mcp-pro |
| Latest `.mcpb` | https://github.com/Temple-of-Epiphany/imap-mcp-pro/releases/latest |
| License | PolyForm-Noncommercial-1.0.0 (source-available) |
| Privacy policy | https://github.com/Temple-of-Epiphany/imap-mcp-pro/blob/main/PRIVACY.md |
| Platforms | macOS + Windows |
| Category | Productivity / Email |

## Security & data-handling summary (for the review)

- **Local-only.** All IMAP/SMTP traffic goes directly from the user's machine to
  their mail server; no data is sent to any third party. No telemetry.
- **Credentials** are stored with AES-256-GCM field-level encryption; the
  encryption key and SQLite DB are owner-only (`0600`), data dir `0700`.
- **Transport**: TLS 1.2+ / STARTTLS / implicit TLS (993), certificate validation.
- **Filesystem writes** are confined: attachment reads and direct exports are
  allow-listed (`allowed_attachment_dirs`, `allowed_export_dirs`), never inside
  the server's own data dir, symlink-escape guarded.
- **Multi-tenant ready**: per-user data trees for MSP use; the outbox boundary is
  preserved even with direct export.
- **Tool hints**: every destructive/write tool is flagged (`destructiveHint`) so
  Claude Desktop's permission UI groups them correctly.

## Next steps

1. Validate the `.mcpb` on Windows and Linux (or narrow platforms).
2. When ready, drive the Google Form in-browser (needs the submitter's Google
   login); paste from the table above and attach/link the latest release `.mcpb`.
