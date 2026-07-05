#!/usr/bin/env bash
#
# update-extension.sh — install the latest released .mcpb into the Claude
# Desktop extensions directory (issue #272).
#
# The Claude Desktop extension is a *local* .mcpb (not installed from the
# Anthropic directory), so Claude Desktop never auto-updates it and it drifts
# behind the Web UI / registry. `make install` / `make update` only manage the
# launchd Web UI service, not this extension. This script closes that gap by
# fetching the latest RELEASED artifact, verifying its checksum, and swapping it
# in atomically with a recoverable backup.
#
# Usage:
#   scripts/update-extension.sh
#   VERSION=2.31.0 scripts/update-extension.sh
#   EXT_DIR="/custom/path" scripts/update-extension.sh
#
# Env:
#   VERSION  Release version to install (default: latest GitHub release tag).
#   EXT_DIR  Installed-extension directory (default: macOS Claude path).
#   REPO     GitHub repo (default: Temple-of-Epiphany/imap-mcp-pro).
#
# Requires: gh (authenticated), unzip, shasum, node.
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-07-05
# Date Updated: 2026-07-05
# Version: 1.0.0
#
# Changelog:
#   1.0.0 (2026-07-05): Initial version — download+verify+stage+swap latest .mcpb.

set -euo pipefail

REPO="${REPO:-Temple-of-Epiphany/imap-mcp-pro}"
EXT_ID="local.mcpb.colin-bitterfield.imap-mcp-pro"
DEFAULT_EXT_DIR="${HOME}/Library/Application Support/Claude/Claude Extensions/${EXT_ID}"
EXT_DIR="${EXT_DIR:-$DEFAULT_EXT_DIR}"

err() { echo "error: $*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || err "gh CLI not found — install it and run 'gh auth login'"
command -v unzip >/dev/null 2>&1 || err "unzip not found"
command -v shasum >/dev/null 2>&1 || err "shasum not found"
command -v node >/dev/null 2>&1 || err "node not found"

# Resolve the target version (default: latest release tag, minus the leading 'v').
if [ -z "${VERSION:-}" ]; then
  TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName 2>/dev/null)" \
    || err "could not resolve the latest release from $REPO (is gh authenticated?)"
else
  TAG="v${VERSION#v}"
fi
VER="${TAG#v}"
MCPB="imap-mcp-pro-${VER}.mcpb"

echo "Repo:      $REPO"
echo "Target:    $TAG ($MCPB)"
echo "Extension: $EXT_DIR"

CUR="none"
if [ -f "$EXT_DIR/manifest.json" ]; then
  CUR="$(node -p "require('$EXT_DIR/manifest.json').version" 2>/dev/null || echo unknown)"
fi
echo "Installed: $CUR"
if [ "$CUR" = "$VER" ]; then
  echo "Already at $VER — nothing to do. (Set VERSION= to force a specific build.)"
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/imap-mcp-ext.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "==> downloading release asset"
gh release download "$TAG" --repo "$REPO" \
  --pattern "$MCPB" --pattern "${MCPB}.sha256" --dir "$TMP" --clobber \
  || err "download failed — does $TAG include $MCPB?"

echo "==> verifying checksum"
if [ -f "$TMP/${MCPB}.sha256" ]; then
  EXPECTED="$(awk '{print $1}' "$TMP/${MCPB}.sha256")"
  ACTUAL="$(shasum -a 256 "$TMP/$MCPB" | awk '{print $1}')"
  [ "$EXPECTED" = "$ACTUAL" ] || err "checksum mismatch (expected $EXPECTED, got $ACTUAL)"
  echo "    sha256 OK"
else
  echo "    warning: no .sha256 published for $TAG — skipping checksum verification" >&2
fi

echo "==> staging fresh extract"
STAGE="$TMP/stage"
mkdir -p "$STAGE"
unzip -q -o "$TMP/$MCPB" -d "$STAGE"
STAGED_VER="$(node -p "require('$STAGE/manifest.json').version" 2>/dev/null || echo unknown)"
[ "$STAGED_VER" = "$VER" ] || err "staged manifest version ($STAGED_VER) != target ($VER)"
[ -f "$STAGE/server/dist/skills/manifest.json" ] || err "staged bundle missing server/dist/skills/manifest.json"
echo "    staged $STAGED_VER, skills manifest present"

echo "==> installing (backup old -> .bak, then swap)"
mkdir -p "$(dirname "$EXT_DIR")"
if [ -d "$EXT_DIR" ]; then
  rm -rf "$EXT_DIR.bak"
  mv "$EXT_DIR" "$EXT_DIR.bak"
  echo "    previous $CUR backed up to $(basename "$EXT_DIR").bak"
fi
mv "$STAGE" "$EXT_DIR"

INSTALLED="$(node -p "require('$EXT_DIR/manifest.json').version" 2>/dev/null || echo unknown)"
[ "$INSTALLED" = "$VER" ] || err "post-install verification failed (found $INSTALLED)"

echo ""
echo "✓ Claude Desktop extension updated: $CUR -> $INSTALLED"
echo "  Quit and reopen Claude Desktop to load the new server process."
