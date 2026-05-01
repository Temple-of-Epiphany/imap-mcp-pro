#!/bin/bash
# setup-backup-cron.sh - IMAP MCP Pro Backup Configuration Setup
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-17
# Date Updated: 2026-04-17
# Version: 0.1.0
#
# Interactively configures automatic encrypted backups and an optional cron job.
# Called at the end of a fresh install (CLI or PKG).
#
# Usage:
#   ./scripts/setup-backup-cron.sh                  # interactive
#   ./scripts/setup-backup-cron.sh --non-interactive # skip, used during upgrade

set -euo pipefail

# ---------------------------------------------------------------
# Paths
# ---------------------------------------------------------------
DATA_DIR="$HOME/.imap-mcp"
BACKUP_CONFIG="$DATA_DIR/backup-config.env"
BACKUP_RUNNER="$DATA_DIR/backup-runner.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"

# ---------------------------------------------------------------
# Non-interactive mode: exit cleanly
# ---------------------------------------------------------------
if [[ "${1:-}" == "--non-interactive" ]]; then
  exit 0
fi

# ---------------------------------------------------------------
# Banner
# ---------------------------------------------------------------
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║           IMAP MCP Pro — Backup Recommendation           ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                          ║"
echo "║  Your email account data and encryption key are stored   ║"
echo "║  in ~/.imap-mcp/  — if this directory is lost or        ║"
echo "║  corrupted you will need to re-add all accounts.        ║"
echo "║                                                          ║"
echo "║  Regular backups are strongly recommended.               ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------
# Ask whether to set up automatic backups
# ---------------------------------------------------------------
printf "Would you like to set up automatic encrypted backups? [Y/n] "
read -r SETUP_BACKUP
SETUP_BACKUP="${SETUP_BACKUP:-Y}"

if [[ ! "$SETUP_BACKUP" =~ ^[Yy] ]]; then
  echo ""
  echo "Skipping backup setup."
  echo "You can run 'make backup' manually at any time, or re-run:"
  echo "  bash scripts/setup-backup-cron.sh"
  echo ""
  exit 0
fi

# ---------------------------------------------------------------
# Backup directory
# ---------------------------------------------------------------
DEFAULT_BACKUP_DIR="$HOME/Documents"
echo ""
printf "Backup directory [%s]: " "$DEFAULT_BACKUP_DIR"
read -r BACKUP_DIR_INPUT
BACKUP_DIR="${BACKUP_DIR_INPUT:-$DEFAULT_BACKUP_DIR}"

# Expand ~ if the user typed it literally
BACKUP_DIR="${BACKUP_DIR/#\~/$HOME}"

if [ ! -d "$BACKUP_DIR" ]; then
  printf "Directory '%s' does not exist. Create it? [Y/n] " "$BACKUP_DIR"
  read -r CREATE_DIR
  if [[ "${CREATE_DIR:-Y}" =~ ^[Yy] ]]; then
    mkdir -p "$BACKUP_DIR"
    echo "Created: $BACKUP_DIR"
  else
    echo "Backup setup cancelled — directory does not exist."
    exit 1
  fi
fi

# ---------------------------------------------------------------
# Backup password
# ---------------------------------------------------------------
echo ""
echo "Set a password to encrypt the backup ZIP."
echo "(Store this somewhere safe — you need it to restore.)"
echo ""

while true; do
  printf "Backup password: "
  read -rs BACKUP_PASSWORD
  echo ""

  if [ -z "$BACKUP_PASSWORD" ]; then
    echo "Password cannot be empty. Please try again."
    continue
  fi

  printf "Confirm password: "
  read -rs BACKUP_PASSWORD_CONFIRM
  echo ""

  if [ "$BACKUP_PASSWORD" = "$BACKUP_PASSWORD_CONFIRM" ]; then
    break
  else
    echo "Passwords do not match. Please try again."
    echo ""
  fi
done

# ---------------------------------------------------------------
# Cron schedule
# ---------------------------------------------------------------
echo ""
echo "How often should backups run?"
echo "  1) Daily at 2:00 AM   (recommended)"
echo "  2) Weekly on Sunday at 2:00 AM"
echo "  3) Custom cron expression"
echo "  4) No cron — I will run backups manually"
echo ""
printf "Choice [1]: "
read -r SCHEDULE_CHOICE
SCHEDULE_CHOICE="${SCHEDULE_CHOICE:-1}"

case "$SCHEDULE_CHOICE" in
  1) CRON_SCHEDULE="0 2 * * *"    ; SCHEDULE_LABEL="daily at 2:00 AM" ;;
  2) CRON_SCHEDULE="0 2 * * 0"    ; SCHEDULE_LABEL="weekly on Sunday at 2:00 AM" ;;
  3)
    printf "Enter cron expression (e.g. '0 3 * * *'): "
    read -r CRON_SCHEDULE
    SCHEDULE_LABEL="custom: $CRON_SCHEDULE"
    ;;
  4)
    CRON_SCHEDULE=""
    SCHEDULE_LABEL="manual only"
    ;;
  *)
    CRON_SCHEDULE="0 2 * * *"
    SCHEDULE_LABEL="daily at 2:00 AM (default)"
    ;;
esac

# ---------------------------------------------------------------
# Save backup config
# ---------------------------------------------------------------
mkdir -p "$DATA_DIR"

cat > "$BACKUP_CONFIG" <<EOF
# IMAP MCP Pro Backup Configuration
# Generated: $(date)
# WARNING: This file contains your backup password. Permissions are set to 600.

BACKUP_DIR=$BACKUP_DIR
BACKUP_PASSWORD=$BACKUP_PASSWORD
CRON_SCHEDULE=$CRON_SCHEDULE
EOF

chmod 600 "$BACKUP_CONFIG"
echo ""
echo "✓ Backup config saved: $BACKUP_CONFIG (mode 600)"

# ---------------------------------------------------------------
# Create the cron runner script
# ---------------------------------------------------------------
cat > "$BACKUP_RUNNER" <<EOF
#!/bin/bash
# IMAP MCP Pro - Automatic Backup Runner
# Generated by setup-backup-cron.sh — do not edit manually.
# To reconfigure run: bash $SCRIPT_DIR/setup-backup-cron.sh

set -euo pipefail

CONFIG="$BACKUP_CONFIG"

[ -f "\$CONFIG" ] || { echo "ERROR: Backup config not found: \$CONFIG" >&2; exit 1; }

# shellcheck source=/dev/null
source "\$CONFIG"

exec bash "$BACKUP_SCRIPT" --password "\$BACKUP_PASSWORD" "\$BACKUP_DIR"
EOF

chmod 700 "$BACKUP_RUNNER"
echo "✓ Backup runner created: $BACKUP_RUNNER"

# ---------------------------------------------------------------
# Install cron job (if requested)
# ---------------------------------------------------------------
if [ -n "$CRON_SCHEDULE" ]; then
  CRON_LINE="$CRON_SCHEDULE \"$BACKUP_RUNNER\" >> \"$DATA_DIR/backup.log\" 2>&1"
  CRON_MARKER="# imap-mcp-pro-backup"

  # Remove any existing imap-mcp-pro backup cron entry, then add new one
  ( crontab -l 2>/dev/null | grep -v "$CRON_MARKER" ; \
    echo "$CRON_LINE $CRON_MARKER" ) | crontab -

  echo "✓ Cron job installed: $SCHEDULE_LABEL"
  echo "  Log: $DATA_DIR/backup.log"
else
  echo "  No cron job installed (manual mode)."
fi

# ---------------------------------------------------------------
# Run initial backup now
# ---------------------------------------------------------------
echo ""
printf "Run an initial backup now? [Y/n] "
read -r DO_INITIAL
DO_INITIAL="${DO_INITIAL:-Y}"

if [[ "$DO_INITIAL" =~ ^[Yy] ]]; then
  echo ""
  bash "$BACKUP_SCRIPT" --password "$BACKUP_PASSWORD" "$BACKUP_DIR"
else
  echo ""
  echo "Skipped initial backup."
  echo "Run manually: make backup"
fi

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║                  Backup Setup Complete                   ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  Destination : %-42s ║\n" "$BACKUP_DIR"
printf "║  Schedule    : %-42s ║\n" "$SCHEDULE_LABEL"
printf "║  Encrypted   : %-42s ║\n" "yes (zip with password)"
echo "║                                                          ║"
echo "║  IMPORTANT: Store your backup password safely.           ║"
echo "║  Without it you cannot restore from backup.             ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "To restore:  bash scripts/restore.sh --password YOUR_PASSWORD /path/to/backup.zip"
echo "To reconfigure: bash scripts/setup-backup-cron.sh"
echo ""
