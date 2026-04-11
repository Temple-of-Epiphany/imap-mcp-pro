#!/bin/bash
# backup.sh - IMAP MCP Pro Database Backup Script
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-10
# Date Updated: 2026-04-10
# Version: 1.0.0
#
# Backs up ~/.imap-mcp/ (database + encryption keys) to a timestamped zip file.
# The backup includes data.db, .encryption-key, and .key — all required for restore.
#
# Usage:
#   ./scripts/backup.sh                        # saves to ~/imap-mcp-pro-backup-YYYY-MM-DD.zip
#   ./scripts/backup.sh /path/to/backup.zip    # saves to specified path

set -euo pipefail

DATA_DIR="$HOME/.imap-mcp"
DATE=$(date +%Y-%m-%d)
DEFAULT_DEST="$HOME/imap-mcp-pro-backup-${DATE}.zip"
DEST="${1:-$DEFAULT_DEST}"

[ -d "$DATA_DIR" ] || { echo "ERROR: Data directory not found: $DATA_DIR" >&2; exit 1; }
[ -f "$DATA_DIR/data.db" ] || { echo "ERROR: Database not found: $DATA_DIR/data.db" >&2; exit 1; }

echo "Backing up $DATA_DIR..."
echo "  Database : $DATA_DIR/data.db ($(du -sh "$DATA_DIR/data.db" | cut -f1))"
echo "  Keys     : $(ls "$DATA_DIR"/.*key 2>/dev/null | wc -l | tr -d ' ') key file(s)"

# Use ditto for zip — preserves permissions and metadata
ditto -c -k --sequesterRsrc "$DATA_DIR" "$DEST"

echo ""
echo "Backup saved: $DEST ($(du -sh "$DEST" | cut -f1))"
echo ""
echo "To restore: ./scripts/restore.sh $DEST"
