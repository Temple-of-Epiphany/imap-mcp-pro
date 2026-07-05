# update-extension.sh — Specification

**Version:** 1.0.0
**Author:** Colin Bitterfield
**Email:** colin.bitterfield@templeofepiphany.com
**Date Created:** 2026-07-05
**Date Updated:** 2026-07-05
**Artifact:** `scripts/update-extension.sh` (invoked via `make update-extension`)
**Tracker:** #272

## Purpose

Install the latest **released** IMAP MCP Pro `.mcpb` into the Claude Desktop
extensions directory in one command.

The Claude Desktop extension is a *local* `.mcpb` (ID
`local.mcpb.colin-bitterfield.imap-mcp-pro`), not installed from the Anthropic
directory. Claude Desktop only auto-updates directory-sourced extensions, so the
local install silently drifts behind the Web UI / registry. `make install` and
`make update` manage only the launchd Web UI service and never touch this
extension. This script closes that gap until the Anthropic directory submission
lands (after which Desktop handles updates itself).

## Invocation

```
make update-extension                 # latest release
make update-extension VERSION=2.31.0  # a specific release
make update-extension EXT_DIR="/path" # non-default install location
```

Direct: `scripts/update-extension.sh` with the same behavior via `VERSION` /
`EXT_DIR` / `REPO` environment variables.

## Inputs

| Var | Default | Meaning |
|-----|---------|---------|
| `VERSION` | latest GitHub release tag | Release version to install (leading `v` optional) |
| `EXT_DIR` | `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.colin-bitterfield.imap-mcp-pro` | Installed-extension directory |
| `REPO` | `Temple-of-Epiphany/imap-mcp-pro` | Source GitHub repo |

## Requirements

`gh` (authenticated), `unzip`, `shasum`, `node`. macOS default path; other
platforms supply `EXT_DIR`.

## Behavior

1. Resolve target tag (`gh release view` for latest, or `v$VERSION`).
2. Short-circuit if the installed `manifest.json` version already equals the
   target (idempotent). `VERSION=` forces a specific build check.
3. `gh release download` the `.mcpb` and `.sha256` into a temp dir.
4. Verify the SHA-256 (hard-fail on mismatch; warn only if no checksum asset).
5. Stage-extract the `.mcpb`; assert the staged `manifest.json` version matches
   the target and `server/dist/skills/manifest.json` is present.
6. Back up the current install to a single `<EXT_DIR>.bak` (previous one
   removed), then swap the staged tree into place.
7. Verify the installed `manifest.json` version, then print a "quit & reopen
   Claude Desktop" reminder (the running MCP process reloads only on restart).

Temp files are removed on exit via a trap.

## Failure modes

- Missing tool / unauthenticated `gh` → hard error before any change.
- Unresolvable release, missing `.mcpb`, checksum mismatch, staged-version
  mismatch, or missing skills manifest → hard error **before** the swap, so the
  existing install is untouched.

## Recovery

The previous version remains at `<EXT_DIR>.bak`. To roll back:
`rm -rf "<EXT_DIR>" && mv "<EXT_DIR>.bak" "<EXT_DIR>"`, then restart Claude
Desktop.

## Out of scope

- The launchd Web UI service (`make update`).
- Automatic Claude Desktop restart (must be manual).
- Directory-sourced auto-updates (handled by Claude Desktop once listed).
