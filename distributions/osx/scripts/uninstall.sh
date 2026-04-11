#!/bin/bash
# uninstall.sh - IMAP MCP Pro macOS Uninstall Script
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-10
# Date Updated: 2026-04-10
# Version: 1.0.0
#
# Removes IMAP MCP Pro from the system:
#   - Unloads and removes the LaunchAgent
#   - Removes the install directory (~/.local/share/imap-mcp-pro)
#   - Removes ImapMCPControl.app from ~/Applications
#   - Removes pkgutil receipt
#   - Optionally removes account data (~/.imap-mcp)
#   - Optionally removes Claude Desktop MCP entry
#
# Usage: ./scripts/uninstall.sh
#        Run as the user who installed it (not root).

set -euo pipefail

INSTALL_DIR="$HOME/.local/share/imap-mcp-pro"
PLIST_LABEL="com.templeofepiphany.imap-mcp-pro"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
APP_PATH="$HOME/Applications/ImapMCPControl.app"
DATA_DIR="$HOME/.imap-mcp"
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
BUNDLED_NODE="$INSTALL_DIR/runtime/node/bin/node"

log()  { echo "  $1"; }
die()  { echo "" >&2; echo "ERROR: $1" >&2; exit 1; }

echo ""
echo "======================================================"
echo "  IMAP MCP Pro Uninstall"
echo "======================================================"
echo ""

# Confirm
read -rp "  This will remove IMAP MCP Pro. Continue? [y/N] " CONFIRM || true
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "  Aborted."
    exit 0
fi
echo ""

# ---------------------------------------------------------------
# 1. Stop and unload LaunchAgent
# ---------------------------------------------------------------
echo "Stopping service..."
launchctl unload "$PLIST_FILE" 2>/dev/null && log "LaunchAgent unloaded." || log "LaunchAgent was not loaded."
rm -f "$PLIST_FILE" && log "Plist removed: $PLIST_FILE" || true

# ---------------------------------------------------------------
# 2. Remove ImapMCPControl.app
# ---------------------------------------------------------------
echo "Removing menu bar app..."
if [ -d "$APP_PATH" ]; then
    osascript -e "tell application \"ImapMCPControl\" to quit" 2>/dev/null || true
    sleep 1
    rm -rf "$APP_PATH"
    log "Removed: $APP_PATH"
else
    log "Not found (already removed): $APP_PATH"
fi

# ---------------------------------------------------------------
# 3. Remove install directory
# ---------------------------------------------------------------
echo "Removing install directory..."
if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    log "Removed: $INSTALL_DIR"
else
    log "Not found (already removed): $INSTALL_DIR"
fi

# ---------------------------------------------------------------
# 4. Remove pkgutil receipts
# ---------------------------------------------------------------
echo "Removing package receipts..."
for PKG_ID in \
    "com.templeofepiphany.imap-mcp-pro" \
    "com.templeofepiphany.imap-mcp-pro.server" \
    "com.templeofepiphany.imap-mcp-pro.control"; do
    if pkgutil --pkg-info "$PKG_ID" >/dev/null 2>&1; then
        sudo pkgutil --forget "$PKG_ID" 2>/dev/null && log "Forgot receipt: $PKG_ID" || log "Could not forget receipt: $PKG_ID (may need sudo)"
    fi
done

# ---------------------------------------------------------------
# 5. Optionally remove account data
# ---------------------------------------------------------------
echo ""
if [ -d "$DATA_DIR" ]; then
    read -rp "  Remove account data ($DATA_DIR)? This deletes all accounts and settings. [y/N] " REMOVE_DATA || true
    if [[ "$REMOVE_DATA" =~ ^[Yy]$ ]]; then
        rm -rf "$DATA_DIR"
        log "Removed: $DATA_DIR"
    else
        log "Kept: $DATA_DIR"
    fi
fi

# ---------------------------------------------------------------
# 6. Optionally remove Claude Desktop MCP entry
# ---------------------------------------------------------------
if [ -f "$CLAUDE_CONFIG" ]; then
    if grep -q "imap-mcp-pro" "$CLAUDE_CONFIG" 2>/dev/null; then
        echo ""
        read -rp "  Remove IMAP MCP Pro from Claude Desktop config? [y/N] " REMOVE_CLAUDE || true
        if [[ "$REMOVE_CLAUDE" =~ ^[Yy]$ ]]; then
            # Use system node to remove the entry from the JSON config
            NODE_BIN=$(command -v node 2>/dev/null || echo "")
            if [ -n "$NODE_BIN" ]; then
                "$NODE_BIN" -e "
const fs = require('fs');
const path = '$CLAUDE_CONFIG';
let config = JSON.parse(fs.readFileSync(path, 'utf8'));
if (config.mcpServers) {
    delete config.mcpServers['imap-mcp-pro'];
    delete config.mcpServers['imap'];  // legacy key
}
fs.writeFileSync(path, JSON.stringify(config, null, 2));
" && log "Removed imap-mcp-pro from Claude Desktop config." || log "Could not update Claude Desktop config automatically."
                log "Restart Claude Desktop to apply changes."
            else
                log "node not found — manually remove 'imap-mcp-pro' from: $CLAUDE_CONFIG"
            fi
        fi
    fi
fi

# ---------------------------------------------------------------
# Done
# ---------------------------------------------------------------
echo ""
echo "======================================================"
echo "  Uninstall Complete"
echo "======================================================"
echo ""
