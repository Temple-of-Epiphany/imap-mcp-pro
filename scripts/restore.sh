#!/bin/bash
# restore.sh - IMAP MCP Pro Database Restore Script
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-10
# Date Updated: 2026-04-17
# Version: 1.1.0
#
# Restores ~/.imap-mcp/ from a backup zip created by backup.sh.
# Stops the service before restore and restarts it after.
#
# Usage:
#   ./scripts/restore.sh /path/to/backup.zip
#   ./scripts/restore.sh --password SECRET /path/to/backup.zip

set -euo pipefail

# ---------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------
RESTORE_PASSWORD=""
BACKUP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)
      RESTORE_PASSWORD="$2"
      shift 2
      ;;
    *)
      BACKUP="$1"
      shift
      ;;
  esac
done

DATA_DIR="$HOME/.imap-mcp"
PLIST="$HOME/Library/LaunchAgents/com.templeofepiphany.imap-mcp-pro.plist"

[ -n "$BACKUP" ] || {
  echo "Usage: $0 [--password SECRET] <backup.zip>" >&2
  exit 1
}
[ -f "$BACKUP" ] || { echo "ERROR: Backup file not found: $BACKUP" >&2; exit 1; }

# ---------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------
echo "Restoring from: $BACKUP"
echo ""
read -rp "WARNING: This will replace ~/.imap-mcp/ completely. Continue? [y/N] " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

# ---------------------------------------------------------------
# Stop service
# ---------------------------------------------------------------
echo "Stopping service..."
launchctl unload "$PLIST" 2>/dev/null && echo "  Service stopped." || echo "  Service was not running."
sleep 1

# ---------------------------------------------------------------
# Extract to temp dir
# ---------------------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Extracting backup..."
if [ -n "$RESTORE_PASSWORD" ]; then
  unzip -P "$RESTORE_PASSWORD" -o "$BACKUP" -d "$TMP"
else
  # Try unencrypted first; if it fails the zip may be password-protected
  if ! unzip -o "$BACKUP" -d "$TMP" 2>/dev/null; then
    echo ""
    printf "Backup appears to be encrypted. Enter password: "
    read -rs RESTORE_PASSWORD
    echo ""
    unzip -P "$RESTORE_PASSWORD" -o "$BACKUP" -d "$TMP"
  fi
fi

# ---------------------------------------------------------------
# Restore files
# ---------------------------------------------------------------
echo "Restoring files..."
mkdir -p "$DATA_DIR"

rm -f "$DATA_DIR/data.db" "$DATA_DIR/.encryption-key"

[ -f "$TMP/data.db" ]          && cp -p "$TMP/data.db"          "$DATA_DIR/data.db"          && chmod 600 "$DATA_DIR/data.db"
[ -f "$TMP/.encryption-key" ]  && cp -p "$TMP/.encryption-key"  "$DATA_DIR/.encryption-key"  && chmod 600 "$DATA_DIR/.encryption-key"

echo "  Restored to: $DATA_DIR"
echo "  data.db          : $([ -f "$DATA_DIR/data.db" ]         && echo "OK" || echo "MISSING")"
echo "  .encryption-key  : $([ -f "$DATA_DIR/.encryption-key" ] && echo "OK" || echo "MISSING")"

# ---------------------------------------------------------------
# Restart service
# ---------------------------------------------------------------
echo ""
echo "Restarting service..."
if [ -f "$PLIST" ]; then
  launchctl load "$PLIST" && echo "  Service started." || echo "  WARNING: Failed to start service."
else
  echo "  No LaunchAgent plist found — service not restarted."
fi

echo ""
echo "Restore complete."
