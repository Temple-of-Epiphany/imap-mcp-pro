#!/bin/bash
# setup-notarize.sh - Set up Keychain profile for Apple Notarytool
#
# Author: Colin Bitterfield
# Email:  colin@bitterfield.com
# Date Created: 2026-04-09
# Date Updated: 2026-04-09
# Version: 1.0.0
#
# Stores Apple notarization credentials in the macOS Keychain under the
# profile name "imap-mcp-pro-notarize", which notarize.sh uses automatically.
#
# You will need an app-specific password from:
#   https://appleid.apple.com > Security > App-Specific Passwords
#   (Generate a new password labeled "imap-mcp-pro-notarize")
#
# Usage: ./scripts/setup-notarize.sh
#        ./scripts/setup-notarize.sh --password "xxxx-xxxx-xxxx-xxxx"

set -euo pipefail

APPLE_ID_DEFAULT="colin.bitterfield@templeofepiphany.com"
TEAM_ID_DEFAULT="G3FY7T45K8"
PROFILE_NAME="imap-mcp-pro-notarize"

# ---------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------
NOTARIZE_PASSWORD=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --password|-p)
            NOTARIZE_PASSWORD="$2"
            shift 2
            ;;
        --apple-id)
            APPLE_ID_DEFAULT="$2"
            shift 2
            ;;
        --team-id)
            TEAM_ID_DEFAULT="$2"
            shift 2
            ;;
        *)
            echo "Unknown argument: $1" >&2
            exit 1
            ;;
    esac
done

echo ""
echo "======================================================"
echo "  IMAP MCP Pro - Notarization Keychain Setup"
echo "======================================================"
echo ""
echo "  Profile name : $PROFILE_NAME"
echo "  Apple ID     : $APPLE_ID_DEFAULT"
echo "  Team ID      : $TEAM_ID_DEFAULT"
echo ""

# ---------------------------------------------------------------
# Check if already set up
# ---------------------------------------------------------------
if xcrun notarytool history --keychain-profile "$PROFILE_NAME" >/dev/null 2>&1; then
    echo "  Keychain profile '$PROFILE_NAME' already exists."
    echo ""
    read -r -p "  Overwrite it? [y/N] " REPLY
    if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
        echo "  Aborted."
        exit 0
    fi
fi

# ---------------------------------------------------------------
# Prompt for app-specific password if not provided
# ---------------------------------------------------------------
if [ -z "$NOTARIZE_PASSWORD" ]; then
    echo "  Get your app-specific password from:"
    echo "  https://appleid.apple.com > Security > App-Specific Passwords"
    echo "  (Generate a password labeled 'imap-mcp-pro-notarize')"
    echo ""
    read -r -s -p "  App-specific password: " NOTARIZE_PASSWORD
    echo ""
fi

if [ -z "$NOTARIZE_PASSWORD" ]; then
    echo "  ERROR: No password provided." >&2
    exit 1
fi

# ---------------------------------------------------------------
# Store credentials in Keychain
# ---------------------------------------------------------------
echo ""
echo "  Storing credentials in Keychain..."
xcrun notarytool store-credentials "$PROFILE_NAME" \
    --apple-id "$APPLE_ID_DEFAULT" \
    --team-id  "$TEAM_ID_DEFAULT" \
    --password "$NOTARIZE_PASSWORD"

# ---------------------------------------------------------------
# Verify the profile works
# ---------------------------------------------------------------
echo ""
echo "  Verifying keychain profile..."
if xcrun notarytool history --keychain-profile "$PROFILE_NAME" >/dev/null 2>&1; then
    echo ""
    echo "======================================================"
    echo "  Setup Complete"
    echo "======================================================"
    echo "  Profile '$PROFILE_NAME' is ready."
    echo "  Run './scripts/notarize.sh' to notarize the package."
    echo "======================================================"
    echo ""
else
    echo ""
    echo "  ERROR: Profile verification failed." >&2
    echo "  Check that your Apple ID, Team ID, and password are correct." >&2
    exit 1
fi
