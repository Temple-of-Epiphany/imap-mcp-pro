#!/bin/bash
# sign.sh - IMAP MCP Pro macOS Code Signing Script
#
# Author: Colin Bitterfield
# Email: colin@bitterfield.com
# Date Created: 2026-04-09
# Date Updated: 2026-04-09
# Version: 1.0.0
#
# Signs the .app bundle and the final .pkg using Apple Developer ID certificates.
#
# Required environment variables (or set in .env):
#   DEVELOPER_ID_APP        - e.g. "Developer ID Application: Colin Bitterfield (TEAMID)"
#   DEVELOPER_ID_INSTALLER  - e.g. "Developer ID Installer: Colin Bitterfield (TEAMID)"
#
# Certificate setup (one-time):
#   1. Open Xcode > Settings > Accounts > Manage Certificates
#   2. Create "Developer ID Application" and "Developer ID Installer" certificates
#   3. Download from developer.apple.com if needed
#   4. Set DEVELOPER_ID_APP and DEVELOPER_ID_INSTALLER in your shell or .env
#
# Usage: ./scripts/sign.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSX_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$(dirname "$OSX_DIR")")"
BUILD_DIR="$OSX_DIR/build"
OUTPUT_DIR="$BUILD_DIR/output"
APP_BUNDLE="$BUILD_DIR/ImapMCPControl.app"

log_step() { echo ""; echo "===> $1"; }
log_ok()   { echo "     OK: $1"; }
die()      { echo "" >&2; echo "ERROR: $1" >&2; exit 1; }

# ---------------------------------------------------------------
# Load .env if present (for local development)
# ---------------------------------------------------------------
if [ -f "$OSX_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$OSX_DIR/.env"
    set +a
    echo "Loaded .env"
fi

# ---------------------------------------------------------------
# Validate required environment variables
# ---------------------------------------------------------------
log_step "Checking signing certificates"

if [ -z "${DEVELOPER_ID_APP:-}" ]; then
    die "DEVELOPER_ID_APP is not set.\n\nSet it to your Developer ID Application certificate name, e.g.:\n  export DEVELOPER_ID_APP=\"Developer ID Application: Your Name (TEAMID)\"\n\nSee README.md for setup instructions."
fi

if [ -z "${DEVELOPER_ID_INSTALLER:-}" ]; then
    die "DEVELOPER_ID_INSTALLER is not set.\n\nSet it to your Developer ID Installer certificate name, e.g.:\n  export DEVELOPER_ID_INSTALLER=\"Developer ID Installer: Your Name (TEAMID)\"\n\nSee README.md for setup instructions."
fi

# Verify certificates exist in keychain
security find-certificate -c "$DEVELOPER_ID_APP" >/dev/null 2>&1 \
    || die "Certificate not found in keychain: $DEVELOPER_ID_APP\n\nEnsure the certificate is installed in your keychain."

security find-certificate -c "$DEVELOPER_ID_INSTALLER" >/dev/null 2>&1 \
    || die "Certificate not found in keychain: $DEVELOPER_ID_INSTALLER\n\nEnsure the certificate is installed in your keychain."

log_ok "Certificates found."

# ---------------------------------------------------------------
# Determine version
# ---------------------------------------------------------------
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
FINAL_PKG="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}.pkg"
SIGNED_PKG="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}-signed.pkg"

# ---------------------------------------------------------------
# Verify build artifacts exist
# ---------------------------------------------------------------
log_step "Verifying build artifacts"
[ -d "$APP_BUNDLE" ] || die "App bundle not found: $APP_BUNDLE\n  Run: make build"
[ -f "$FINAL_PKG"  ] || die "Product package not found: $FINAL_PKG\n  Run: make build"
log_ok "Build artifacts found."

# ---------------------------------------------------------------
# Sign the .app bundle
# ---------------------------------------------------------------
log_step "Signing ImapMCPControl.app"
codesign \
    --force \
    --deep \
    --strict \
    --timestamp \
    --options runtime \
    --sign "$DEVELOPER_ID_APP" \
    "$APP_BUNDLE"
log_ok "App bundle signed."

# Verify app signature
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" \
    || die "App signature verification failed."
log_ok "App signature verified."

# ---------------------------------------------------------------
# Sign the bundled node binary inside the payload
# ---------------------------------------------------------------
log_step "Signing bundled Node.js binary"
NODE_BINARY="$BUILD_DIR/payload/server/runtime/node/bin/node"
if [ -f "$NODE_BINARY" ]; then
    codesign \
        --force \
        --timestamp \
        --options runtime \
        --sign "$DEVELOPER_ID_APP" \
        "$NODE_BINARY"
    log_ok "Node binary signed: $NODE_BINARY"
else
    echo "     WARN: Node binary not found at $NODE_BINARY — skipping."
fi

# ---------------------------------------------------------------
# Sign the product package
# ---------------------------------------------------------------
log_step "Signing product package"
productsign \
    --sign "$DEVELOPER_ID_INSTALLER" \
    --timestamp \
    "$FINAL_PKG" \
    "$SIGNED_PKG"
log_ok "Signed package: $SIGNED_PKG"

# Replace unsigned with signed
mv "$SIGNED_PKG" "$FINAL_PKG"
log_ok "Replaced unsigned package with signed version."

# Verify package signature
pkgutil --check-signature "$FINAL_PKG" \
    || die "Package signature verification failed."
log_ok "Package signature verified."

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo "======================================================"
echo "  Signing Complete"
echo "======================================================"
echo "  App    : $APP_BUNDLE"
echo "  Package: $FINAL_PKG"
echo "======================================================"
echo ""
echo "Next step: ./scripts/notarize.sh"
echo ""
