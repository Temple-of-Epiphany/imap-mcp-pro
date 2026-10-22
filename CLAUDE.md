<!-- github-operations:project-instructions:begin -->
# CLAUDE.md — Project Instructions

> **Auto-generated** by the `github-operations` skill on 2026-10-22.
> Regenerate with: `gh-skill generate-project-instructions --refresh`
> Source: `~/.claude/skills/github-operations/scripts/generate-project-instructions.sh`

**Project:** Temple-of-Epiphany/imap-mcp-pro
**Skill version:** github-operations v3.18.1
**Target client:** both

---

## Skill bindings

This project delegates GitHub-related operations to the `github-operations`
skill. It activates on any mention of "github" (any case), any `git`
subcommand and any `gh` subcommand; nobody needs to name it. Its Hard Rules
are listed in `~/.claude/skills/github-operations/SKILL.md`. The most
load-bearing for daily work:

- **Hard Rule 7** — PR-first by default; commits go through worktrees + branches
- **Hard Rule 11** — 3rd-party GitHub Actions must be SHA-pinned
- **Hard Rule 12** — no `.env` in CI; secrets via `${{ secrets.* }}`
- **Hard Rule 18** — never `git push --force`; use `--force-with-lease`
- **Hard Rule 26** — every code change starts with a GitHub issue (see below)

For interactive logins (e.g. `gh auth login`, `gcloud auth login`), type
`! <command>` in the prompt — output lands in the conversation.

---

## Hard Rule 26: Issue-required workflow

**Issue mode:** every code change

**Every code change starts with a GitHub issue.** No exceptions for
size or scope. The workflow:

1. User asks for a code change.
2. Claude creates a GitHub issue describing the request (`gh issue create
   --body-file` per Hard Rule 1).
3. Claude opens a worktree + branch via
   `~/.claude/skills/github-operations/scripts/worktree-new.sh <issue#>`.
4. While work proceeds, Claude posts progress comments on the issue
   (Started → Progress → Resolution per the skill's Issue Lifecycle pattern).
5. PR title and body reference the issue (`Closes #N`).
6. After merge, the issue auto-closes; Claude posts the final Resolution
   comment with file list and verification.

If the user asks for code without an issue, Claude **creates the issue
first** rather than starting work directly.

---

## NIST 800-53r5 Moderate baseline

**Status:** applied

This repo is audited against the NIST 800-53r5 Moderate baseline. The
audit is in `~/.claude/skills/github-operations/scripts/nist-audit.sh`
and runs automatically on first-access per session. Controls covered:

| Control | Description |
|---|---|
| AC-3, AC-6 | Access enforcement, least privilege (branch protection, admin count) |
| CM-2, CM-3, CM-6 | CODEOWNERS / SECURITY.md / CHANGELOG.md present, PR review required, secret scanning enabled |
| IA-2 | Org-wide 2FA |
| RA-5, SI-2 | Dependabot alerts + security updates |
| SC-8, SC-12 | HTTPS-only, optional signed commits |
| SI-3 | CodeQL/Semgrep/Snyk SAST workflow present |
| SI-7 | All workflow actions SHA-pinned |
| SA-15 | CHANGELOG.md with release entries |

Failing controls must be remediated via `nist-remediate.sh` or
explicitly waived in `~/.claude/github-operations/config.yaml` under
`repos."Temple-of-Epiphany/imap-mcp-pro".nist_audit.waived_controls` with a reason.

**Credential exposure (CM-6):** local gitleaks pre-commit hook + history scan (gitleaks-scan.sh); native secret scanning where the plan allows

---

## Engineering wiki

**Status:** maintained

**Wiki:** https://github.com/Temple-of-Epiphany/imap-mcp-pro/wiki

The `engineering-wiki` skill governs documentation for this project. On
every PR that changes documented surface area (API contracts, schema,
naming, runbooks, architecture), Claude opens a companion wiki-update
issue before merge per Hard Rule 24. Wiki check scope:

- Data formats / identifiers — IDs, slugs, status enums
- API contracts — endpoints, request/response fields
- Schema / database — tables, columns, indexes, constraints
- Auth / security — roles, groups, permissions, token behavior
- Infrastructure / deploy — config, monitoring, deploy steps
- Naming conventions — new names/labels/patterns
- Architecture decisions — choices others should know

Use `wiki-check.sh --create-update-issue --pr <N>` to open the companion
issue.

---

## Static analysis & secret scanning (SAST)

**Tool in use:** Aikido

**Aikido** is the SAST tool of record for this project, invoked through
the `aikido:scan` skill (which calls the Aikido MCP server).

Workflow:
1. After Claude generates, adds, or modifies any code file, it runs the
   `aikido:scan` skill on the changed paths before committing, so findings
   are fixed before review rather than after.
2. If Aikido reports SAST or secret findings, Claude fixes them and
   re-scans before opening the PR.
3. The scan result is posted as a comment on the issue.

If the MCP server is unavailable, fall back to:
- `gitleaks-scan.sh --mode staged` for credentials
- Aikido CLI: `aikido scan` (if installed)

---

## Library maintenance

**Cadence:** monthly outdated sweep + Dependabot

On the first session of each calendar month, Claude runs the outdated
check for each dependency manifest this repo actually has (detected on
2026-10-22: Node.js (`package.json`), GitHub Actions (SHA-pinned, `.github/workflows/`)) before any new work:

| Manifest | Command |
|---|---|
| Node.js (`package.json`) | `npm outdated && npm audit` |
| GitHub Actions (SHA-pinned, `.github/workflows/`) | for each `uses: owner/action@SHA # vX`, compare the SHA to `gh api repos/<owner>/<action>/git/ref/tags/<vX> --jq .object.sha` |

Findings produce one issue per major version drift, labeled
`dependencies` and `p2`. Dependabot handles automated security bumps
(NIST SI-2); this manual sweep catches abandoned/unmaintained libraries.

**Maintenance signals to flag:** last commit >12 months ago, no
releases >18 months, archived repo, deprecated notice in README.

---

## Secrets

- This repo deploys nothing and holds no deploy secrets. Hard Rules 12 and 13 have no object here; if a deploy is added, re-run `--refresh` and answer the secrets questions again
- No `.env` files committed; only `.env.example` with placeholders

---

## Re-run the project setup

If any answer changes (wiki added, NIST opt-in flipped, SAST tool
swapped, secrets source or environments changed, a manifest added):

```bash
~/.claude/skills/github-operations/scripts/generate-project-instructions.sh --refresh
```

This re-prompts and rewrites this file. The previous version is backed
up to `CLAUDE.md.bak` (one backup retained per project preferences).
<!-- github-operations:project-instructions:end -->

---

# Project Guidance (IMAP MCP Pro)

This section provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an IMAP MCP (Model Context Protocol) server built with TypeScript that provides comprehensive IMAP email integration with secure account management and connection pooling.

## Common Development Commands

- Build the project: `npm run build`
- Run in development mode: `npm run dev`
- Start the compiled server: `npm start`
- Install dependencies: `npm install`

## Architecture

### Core Components

1. **MCP Server (`src/index.ts`)**: The main entry point that sets up the MCP server using the McpServer class from the MCP SDK.

2. **Services**:
   - `ImapService`: Manages IMAP connections, email operations, and folder management with connection pooling
   - `DatabaseService`: Handles secure account/user storage (SQLite) with AES-256-GCM encryption and multi-tenant support

3. **Tools**: MCP tools are organized into three categories:
   - `account-tools.ts`: Account management (add, remove, list, connect, disconnect)
   - `email-tools.ts`: Email operations (search, read, mark, delete)
   - `folder-tools.ts`: Folder operations (list, status, unread counts)

### Key Design Decisions

- Uses `node-imap` for IMAP protocol implementation
- Implements connection pooling to efficiently manage multiple IMAP connections
- Stores encrypted credentials in `~/.imap-mcp/accounts.json`
- All MCP tools return JSON-formatted text responses
- TypeScript for type safety with comprehensive type definitions in `src/types/`

## Adding New Features

When adding new IMAP operations:
1. Add the operation to the appropriate service (`ImapService`)
2. Create or update the corresponding tool in the tools directory
3. Ensure proper error handling and connection management
4. Update types if needed in `src/types/index.ts`

## Important Constraints

- Later this library will be used for MSP services so each master account will have it's own subordinate email accounts. Security will need to be maintained. Do not make coding choices that will preclude this in the future.
- We are only going to test/install released versions. Either with a make install or a make update.

## IMAP4rev2 Compliance (RFC 9051)

This project implements IMAP4rev2 (RFC 9051) via the ImapFlow library. The full RFC is located at `rfc/rfc9051.txt`.

### Current Implementation Status

#### ✅ Implemented Core Commands
- **Connection**: LOGIN, LOGOUT, CAPABILITY, NOOP
- **Mailbox Selection**: SELECT, EXAMINE
- **Mailbox Management**: LIST (with SPECIAL-USE, LIST-STATUS support)
- **Message Operations**: SEARCH, FETCH, STORE (flags), COPY, MOVE
- **Deletion**: Message deletion with EXPUNGE
- **Authentication**: TLS/STARTTLS, AUTHENTICATE, PLAIN
- **Extensions**: IDLE, UIDPLUS, ESEARCH, NAMESPACE (via ImapFlow)

#### ✅ Mailbox Management & Message Append (Issue #50 — COMPLETE)
- **STATUS**: `imap_get_mailbox_status` (+ `imap_folder_status`)
- **CREATE**: `imap_create_folder`
- **DELETE**: `imap_delete_folder`
- **RENAME**: `imap_rename_folder`
- **APPEND**: `imap_append_message`
- **SUBSCRIBE / UNSUBSCRIBE**: `imap_subscribe_mailbox` / `imap_unsubscribe_mailbox` (+ `imap_list_subscribed_mailboxes`)
- A structural compliance regression suite (`src/tools/rfc9051-compliance.test.ts`, Issue #57) asserts each required command stays wired to a tool + ImapService method.

#### ⚠️ Available via ImapFlow (no dedicated MCP tool)
- **UNSELECT**, **ENABLE**

### IMAP4rev2 Built-in Extensions

The following are part of IMAP4rev2 base (no capability negotiation needed):
- NAMESPACE (RFC 2342) - ✅ Available via ImapFlow
- UNSELECT (RFC 3691) - ✅ Available via ImapFlow
- UIDPLUS (RFC 4315) - ✅ Available via ImapFlow
- ESEARCH (RFC 4731) - ✅ Supported
- SEARCHRES (RFC 5182) - ✅ Available via ImapFlow
- ENABLE (RFC 5161) - ✅ Available via ImapFlow
- IDLE (RFC 2177) - ✅ Available via ImapFlow
- SASL-IR (RFC 4959) - ✅ Available via ImapFlow
- LIST-EXTENDED (RFC 5258) - ✅ Available via ImapFlow
- LIST-STATUS (RFC 5819) - ✅ Available via ImapFlow
- MOVE (RFC 6851) - ✅ Implemented
- LITERAL- (RFC 7888) - ✅ Available via ImapFlow
- BINARY (RFC 3516) - ✅ Available via ImapFlow
- SPECIAL-USE (RFC 6154) - ✅ Supported
- STATUS=SIZE - ✅ Available via ImapFlow
- STATUS=DELETED - ✅ Available via ImapFlow

### Standard Flags (System Flags)
- `\Seen` - ✅ Implemented (mark read/unread)
- `\Answered` - ✅ Implemented (`imap_bulk_mark_emails` answered/unanswered; Issue #48)
- `\Flagged` - ✅ Implemented (flag/unflag)
- `\Deleted` - ✅ Implemented (delete operations)
- `\Draft` - ❌ Not yet implemented

### Recommended Keywords (SHOULD Support per RFC)
- `$Forwarded` - ❌ Not implemented
- `$MDNSent` - ❌ Not implemented
- `$Junk` - ❌ Not implemented
- `$NotJunk` - ❌ Not implemented
- `$Phishing` - ❌ Not implemented

### Special-Use Mailbox Attributes
These are recognized when present but not enforced:
- `\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`, `\Trash`

### Security & TLS Compliance
- ✅ TLS 1.2+ via ImapFlow
- ✅ STARTTLS support
- ✅ Implicit TLS (port 993)
- ✅ Certificate validation
- ✅ Encrypted credential storage (AES-256-GCM)
- ✅ PLAIN SASL authentication
- ⚠️ Additional SASL mechanisms (SCRAM, GSSAPI) - via ImapFlow if server supports

### Compliance Roadmap

- **Issue #48** ✅: Priority flags (`imap_set/get_email_priority`) and `\Answered` support — DONE.
- **Issue #49** ✅: CAPABILITY query tool (`imap_get_capabilities`) — DONE.
- **Issue #50** ✅: Required commands (CREATE, DELETE, RENAME, APPEND, SUBSCRIBE/UNSUBSCRIBE, STATUS) — DONE.
- **Issue #57** ✅: RFC 9051 compliance regression suite (`src/tools/rfc9051-compliance.test.ts`) — DONE.
- Remaining (optional, not required for core compliance): Draft-flag tool surface and the recommended keywords ($Forwarded/$Junk/etc.) can be set today via `imap_add_keyword`.

### References
- RFC 9051 (IMAP4rev2): `rfc/rfc9051.txt`
- ImapFlow Documentation: https://imapflow.com/
- Related Issues: #48, #49, #50
- Check specification document when large modifications or replacements of code happen.
