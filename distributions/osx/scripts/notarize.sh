#!/bin/bash
# notarize.sh - IMAP MCP Pro macOS Notarization Script
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-09
# Date Updated: 2026-04-09
# Version: 1.0.0
#
# Submits the signed .pkg to Apple for notarization using notarytool,
# waits for the result, then staples the notarization ticket to the package.
#
# Prerequisites:
#   1. The package must be signed first (run sign.sh).
#   2. A keychain profile named "imap-mcp-pro-notarize" must be set up.
#
# One-time keychain profile setup:
#   xcrun notarytool store-credentials "imap-mcp-pro-notarize" \
#       --apple-id "colin.bitterfield@templeofepiphany.com" \
#       --team-id  "G3FY7T45K8" \
#       --password "xxxx-xxxx-xxxx-xxxx"   # App-specific password from appleid.apple.com
#
#   Or run: ./scripts/setup-notarize.sh
#
#   Get an app-specific password at: https://appleid.apple.com/account/manage
#   (Security > App-Specific Passwords > Generate Password)
#
# Required environment variables (alternative to keychain profile — for CI):
#   APPLE_ID          - Apple ID email
#   TEAM_ID           - 10-char Apple Developer Team ID
#   NOTARIZE_PASSWORD - App-specific password
#
# Usage: ./scripts/notarize.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSX_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$(dirname "$OSX_DIR")")"
BUILD_DIR="$OSX_DIR/build"
OUTPUT_DIR="$BUILD_DIR/output"
KEYCHAIN_PROFILE="imap-mcp-pro-notarize"

log_step() { echo ""; echo "===> $1"; }
log_ok()   { echo "     OK: $1"; }
die()      { echo "" >&2; echo "ERROR: $1" >&2; exit 1; }

# ---------------------------------------------------------------
# Load .env if present
# ---------------------------------------------------------------
if [ -f "$OSX_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$OSX_DIR/.env"
    set +a
    echo "Loaded .env"
fi

# ---------------------------------------------------------------
# Determine version and package path
# ---------------------------------------------------------------
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
FINAL_PKG="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}.pkg"

# ---------------------------------------------------------------
# Verify package exists and is signed
# ---------------------------------------------------------------
log_step "Verifying signed package"
[ -f "$FINAL_PKG" ] || die "Signed package not found: $FINAL_PKG\n  Run: make sign"

SPCTL_OUTPUT=$(spctl --assess --type install -v "$FINAL_PKG" 2>&1 || true)
if echo "$SPCTL_OUTPUT" | grep -q "accepted"; then
    log_ok "Package already accepted by Gatekeeper (may already be notarized)."
elif echo "$SPCTL_OUTPUT" | grep -q "source=Developer ID Installer"; then
    log_ok "Package is signed with Developer ID."
else
    echo "     INFO: spctl output: $SPCTL_OUTPUT"
fi

# Verify package signature
pkgutil --check-signature "$FINAL_PKG" | grep -E "Developer ID|Status" || true
log_ok "Package signature check complete."

# ---------------------------------------------------------------
# Choose authentication method
# ---------------------------------------------------------------
log_step "Configuring notarytool authentication"

USE_KEYCHAIN_PROFILE=true

# Check if keychain profile exists
if ! xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" >/dev/null 2>&1; then
    echo "     Keychain profile '$KEYCHAIN_PROFILE' not found."
    echo "     Falling back to environment variables."
    USE_KEYCHAIN_PROFILE=false
fi

if [ "$USE_KEYCHAIN_PROFILE" = false ]; then
    # Validate environment variables
    [ -n "${APPLE_ID:-}" ]          || die "APPLE_ID is not set and keychain profile not found.\n\nEither:\n  1. Run: xcrun notarytool store-credentials \"$KEYCHAIN_PROFILE\" --apple-id YOUR_ID --team-id YOUR_TEAM --password YOUR_APP_PASSWORD\n  2. Set APPLE_ID, TEAM_ID, and NOTARIZE_PASSWORD environment variables."
    [ -n "${TEAM_ID:-}" ]           || die "TEAM_ID is not set."
    [ -n "${NOTARIZE_PASSWORD:-}" ] || die "NOTARIZE_PASSWORD is not set."
    log_ok "Using environment variable credentials."
else
    log_ok "Using keychain profile: $KEYCHAIN_PROFILE"
fi

# ---------------------------------------------------------------
# Submit for notarization
# ---------------------------------------------------------------
log_step "Submitting package to Apple notarization service"
echo "     Package: $FINAL_PKG"
echo "     This may take several minutes..."
echo ""

SUBMISSION_OUTPUT_FILE="$BUILD_DIR/notarization-result.json"

if [ "$USE_KEYCHAIN_PROFILE" = true ]; then
    xcrun notarytool submit "$FINAL_PKG" \
        --keychain-profile "$KEYCHAIN_PROFILE" \
        --wait \
        --output-format json \
        | tee "$SUBMISSION_OUTPUT_FILE"
else
    xcrun notarytool submit "$FINAL_PKG" \
        --apple-id "$APPLE_ID" \
        --team-id  "$TEAM_ID" \
        --password "$NOTARIZE_PASSWORD" \
        --wait \
        --output-format json \
        | tee "$SUBMISSION_OUTPUT_FILE"
fi

# Parse result
NOTARIZE_STATUS=$(node -p "require('$SUBMISSION_OUTPUT_FILE').status" 2>/dev/null || echo "unknown")
SUBMISSION_ID=$(node -p "require('$SUBMISSION_OUTPUT_FILE').id" 2>/dev/null || echo "unknown")

echo ""
echo "     Submission ID : $SUBMISSION_ID"
echo "     Status        : $NOTARIZE_STATUS"

if [ "$NOTARIZE_STATUS" != "Accepted" ]; then
    echo ""
    echo "     Full notarization log:" >&2
    if [ "$USE_KEYCHAIN_PROFILE" = true ]; then
        xcrun notarytool log "$SUBMISSION_ID" \
            --keychain-profile "$KEYCHAIN_PROFILE" >&2 || true
    else
        xcrun notarytool log "$SUBMISSION_ID" \
            --apple-id "$APPLE_ID" \
            --team-id  "$TEAM_ID" \
            --password "$NOTARIZE_PASSWORD" >&2 || true
    fi
    die "Notarization failed with status: $NOTARIZE_STATUS"
fi

log_ok "Notarization accepted!"

# ---------------------------------------------------------------
# Staple the notarization ticket
# ---------------------------------------------------------------
log_step "Stapling notarization ticket to package"
xcrun stapler staple "$FINAL_PKG"
log_ok "Ticket stapled."

# Verify stapling
xcrun stapler validate "$FINAL_PKG" \
    || die "Stapler validation failed."
log_ok "Stapler validation passed."

# Verify Gatekeeper acceptance
spctl --assess --type install -v "$FINAL_PKG" 2>&1 \
    | grep -E "accepted|rejected" || true

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo "======================================================"
echo "  Notarization Complete"
echo "======================================================"
echo "  Package       : $FINAL_PKG"
echo "  Submission ID : $SUBMISSION_ID"
echo "  Status        : $NOTARIZE_STATUS (stapled)"
echo "======================================================"
echo ""
echo "Next step: ./scripts/create-dmg.sh"
echo ""
