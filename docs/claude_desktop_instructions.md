# Claude Desktop — Project Instructions: IMAP MCP Pro

**Version:** 1.0.0
**Author:** Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
**Date Created:** 2026-07-04
**Date Updated:** 2026-07-04

> **How to use this file:** In Claude Desktop, create (or open) a Project for
> IMAP MCP Pro and paste the section **"Instructions to paste"** below into the
> Project's custom instructions. It orients Claude to this codebase, its
> location on disk, and the conventions to follow when working on it.

---

## Instructions to paste

You are working on **IMAP MCP Pro**, a production TypeScript **MCP (Model Context
Protocol) server** that gives Claude full IMAP + SMTP email capabilities. It ships
as a Claude Desktop `.mcpb` extension and is published to the MCP Registry as
`io.github.Temple-of-Epiphany/imap-mcp-pro`.

**Project directory:** `/Users/colin/Projects/imap-mcp-pro`
(Short name `imap-mcp-pro`; GitHub: `Temple-of-Epiphany/imap-mcp-pro`.)

### What it is
- ~130 MCP tools across email search/read/send, folders, bulk operations,
  categories/scoring, subscriptions/unsubscribe, spam (UserCheck) + DNS firewall
  (Quad9), local cache (SQLite + FTS5), allow/deny lists, per-account signatures,
  and resumable bulk jobs.
- Pure-JS runtime: `node:sqlite` (no native modules), single universal `.mcpb`.
- Credentials encrypted at rest (AES-256-GCM, file-based key at
  `~/.imap-mcp/.encryption-key`, mode 600); data dir and DB are owner-only.
- License: **PolyForm Noncommercial 1.0.0** (source-available; commercial license
  available).

### Discovering the tool surface (don't guess)
- `docs/TOOL_CATALOG.md` — the full categorized tool list, **generated from the
  manifest on every build**. Treat it (and the runtime `imap_list_tools` tool) as
  authoritative; do not hand-maintain tool counts elsewhere.
- `imap_help` (a tool) returns categorized capabilities + copy-paste workflows.

### Common development commands
- Build: `npm run build`  ·  Tests: `npm test` (vitest, colocated `*.test.ts`)
- Dev server: `npm run dev`  ·  Web UI: `npm run web` (http://localhost:4500)
- Install/update the local service (released versions only): `make install` /
  `make update` (data-preserving; creates a backup each run).
- Migrations run automatically on startup via the `node:sqlite` migration ledger
  (`src/database/migrations-manifest.json` + `schema_update_X_TO_Y.sql`).

### Conventions (follow these)
- **Track all work in GitHub Issues** — never in TODO/summary files. Every code
  change starts from an issue; use the **github-operations** workflow for any
  git/gh work (branch → PR → squash-merge; `--repo Temple-of-Epiphany/imap-mcp-pro`).
- 2-space indentation. Match surrounding style.
- **Never hardcode versions** — read from `package.json` / `PACKAGE_VERSION`
  (`src/utils/package-info.ts`). The web UI and `imap_about` derive from it.
- Don't rename files for new versions; version in-file with a changelog.
- Update `README.md` and `CHANGELOG.md` as part of any user-facing change; a
  specification doc for scripts lives in `docs/` (read it before editing the
  artifact).
- Add a colocated `*.test.ts` for new logic; keep the suite green before merging.
- Only test/install **released** versions (`make install`/`make update`).

### Releasing (proven flow)
1. Bump `package.json` version + add a `CHANGELOG.md` entry.
2. Merge to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI (`.github/workflows/build-dxt.yml`) builds the universal `.mcpb`, attaches
   it to the GitHub Release, and publishes to the MCP Registry.
4. Verify the release + `isLatest: true` on the registry.

### Directory submission
This is a **Desktop Extension** (stdio `.mcpb`) — submit via
`clau.de/desktop-extention-submission` (no Team/Enterprise plan required).
Requirements met: every tool has a `title` + read/destructive hint; a privacy
policy (`PRIVACY.md` + manifest `privacy_policies`); descriptions are purely
descriptive (no "tell Claude how to behave" phrasing).

### Security / data model to preserve
- MSP multi-tenant is a design goal — keep per-user isolation; don't regress it.
- Keep credential storage encrypted; keep `~/.imap-mcp` owner-only.
- Prefer file/DB tools over shell; don't add native dependencies (breaks the
  single universal `.mcpb`).

---

## Notes for maintainers
- This document is a companion to the repo's `CLAUDE.md` (which is loaded by
  Claude **Code**). Claude **Desktop** does not auto-load `CLAUDE.md`, so this
  paste-ready block exists for Desktop Projects.
- Regenerate/refresh when conventions change; keep the version header current.
