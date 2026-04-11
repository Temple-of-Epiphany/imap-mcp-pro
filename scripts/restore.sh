#!/bin/bash
# restore.sh - IMAP MCP Pro Database Restore Script
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-10
# Date Updated: 2026-04-10
# Version: 1.0.0
#
# Restores ~/.imap-mcp/ from a backup zip created by backup.sh.
# Stops the service before restore and restarts it after.
#
# Usage: ./scripts/restore.sh /path/to/backup.zip

set -euo pipefail

BACKUP="${1:-}"
DATA_DIR="$HOME/.imap-mcp"
PLIST="$HOME/Library/LaunchAgents/com.templeofepiphany.imap-mcp-pro.plist"

[ -n "$BACKUP" ]     || { echo "Usage: $0 <backup.zip>" >&2; exit 1; }
[ -f "$BACKUP" ]     || { echo "ERROR: Backup file not found: $BACKUP" >&2; exit 1; }

echo "Restoring from: $BACKUP"
echo ""
read -rp "WARNING: This will replace ~/.imap-mcp/ completely. Continue? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# Stop service
echo "Stopping service..."
launchctl unload "$PLIST" 2>/dev/null && echo "  Service stopped." || echo "  Service was not running."
sleep 1

# Extract to temp dir
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

echo "Extracting backup..."
ditto -x -k "$BACKUP" "$TMP"

# Replace data dir
echo "Restoring files..."
mkdir -p "$DATA_DIR"
# Remove existing files
rm -f "$DATA_DIR/data.db" "$DATA_DIR/.encryption-key" "$DATA_DIR/.key"
# Copy all files from backup
cp -p "$TMP/"* "$DATA_DIR/" 2>/dev/null || true
cp -p "$TMP/".* "$DATA_DIR/" 2>/dev/null || true

echo "  Restored: $(ls -1 "$DATA_DIR" | wc -l | tr -d ' ') file(s) to $DATA_DIR"

# Restart service
echo "Restarting service..."
if [ -f "$PLIST" ]; then
    launchctl load "$PLIST" && echo "  Service started." || echo "  WARNING: Failed to start service."
else
    echo "  No LaunchAgent plist found — service not restarted."
fi

echo ""
echo "Restore complete."
