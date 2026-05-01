#!/bin/bash
# backup.sh - IMAP MCP Pro Database Backup Script
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-10
# Date Updated: 2026-04-17
# Version: 1.1.0
#
# Backs up ~/.imap-mcp/ (database + encryption key) to a timestamped
# password-protected zip file.  Both files are required for restore.
#
# Usage:
#   ./scripts/backup.sh                             # unencrypted, ~/imap-mcp-pro-backup-YYYY-MM-DD.zip
#   ./scripts/backup.sh /path/to/dir               # unencrypted, saved to directory
#   ./scripts/backup.sh /path/to/backup.zip        # unencrypted, explicit path
#   ./scripts/backup.sh --password SECRET /dir     # encrypted zip
#   ./scripts/backup.sh --password SECRET out.zip  # encrypted zip, explicit path
#
# Environment variables (used by cron runner):
#   BACKUP_PASSWORD   password for zip encryption (overridden by --password flag)
#   BACKUP_DIR        destination directory (overridden by positional arg)

set -euo pipefail

# ---------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------
BACKUP_PASSWORD="${BACKUP_PASSWORD:-}"
DEST_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password)
      BACKUP_PASSWORD="$2"
      shift 2
      ;;
    *)
      DEST_ARG="$1"
      shift
      ;;
  esac
done

DATA_DIR="$HOME/.imap-mcp"
DATE=$(date +%Y-%m-%d_%H%M%S)
FILENAME="imap-mcp-pro-backup-${DATE}.zip"

# Resolve destination: arg can be a directory or a full path
if [ -n "$DEST_ARG" ]; then
  if [ -d "$DEST_ARG" ] || [[ "$DEST_ARG" != *.zip ]]; then
    # Treat as a directory
    DEST_DIR="${DEST_ARG%/}"
    DEST="$DEST_DIR/$FILENAME"
  else
    DEST="$DEST_ARG"
  fi
elif [ -n "${BACKUP_DIR:-}" ]; then
  DEST="$BACKUP_DIR/$FILENAME"
else
  DEST="$HOME/$FILENAME"
fi

# ---------------------------------------------------------------
# Validate
# ---------------------------------------------------------------
[ -d "$DATA_DIR" ] || { echo "ERROR: Data directory not found: $DATA_DIR" >&2; exit 1; }
[ -f "$DATA_DIR/data.db" ] || { echo "ERROR: Database not found: $DATA_DIR/data.db" >&2; exit 1; }
[ -f "$DATA_DIR/.encryption-key" ] || { echo "ERROR: Encryption key not found: $DATA_DIR/.encryption-key" >&2; exit 1; }

# Ensure destination directory exists
mkdir -p "$(dirname "$DEST")"

# ---------------------------------------------------------------
# Build zip
# ---------------------------------------------------------------
echo "Backing up IMAP MCP Pro data..."
echo "  Source   : $DATA_DIR"
echo "  Database : $DATA_DIR/data.db ($(du -sh "$DATA_DIR/data.db" | cut -f1))"
echo "  Key      : $DATA_DIR/.encryption-key"
echo "  Dest     : $DEST"
if [ -n "$BACKUP_PASSWORD" ]; then
  echo "  Encrypted: yes"
else
  echo "  Encrypted: no (no password set)"
fi
echo ""

# Remove existing file at destination if present
rm -f "$DEST"

# zip -j = junk paths (store files without directory prefix)
# Note: -P passes password on command line; acceptable for local backup on a personal machine.
if [ -n "$BACKUP_PASSWORD" ]; then
  zip -j -P "$BACKUP_PASSWORD" "$DEST" \
    "$DATA_DIR/data.db" \
    "$DATA_DIR/.encryption-key"
else
  zip -j "$DEST" \
    "$DATA_DIR/data.db" \
    "$DATA_DIR/.encryption-key"
fi

# Restrict permissions on the backup file
chmod 600 "$DEST"

echo "Backup saved : $DEST ($(du -sh "$DEST" | cut -f1))"
echo ""
if [ -n "$BACKUP_PASSWORD" ]; then
  echo "To restore: ./scripts/restore.sh --password YOUR_PASSWORD $DEST"
else
  echo "To restore: ./scripts/restore.sh $DEST"
fi
