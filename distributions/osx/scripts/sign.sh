#!/bin/bash
# sign.sh - IMAP MCP Pro macOS Code Signing Script
#
# Author: Colin Bitterfield
# Email: colin@bitterfield.com
# Date Created: 2026-04-09
# Date Updated: 2026-04-10
# Version: 1.1.0
#
# Signs all payload binaries FIRST, then rebuilds .pkg files from the signed
# payload, then productsigns the final package.
#
# Required environment variables (or set in .env):
#   DEVELOPER_ID_APP        - e.g. "Developer ID Application: Colin Bitterfield (G3FY7T45K8)"
#   DEVELOPER_ID_INSTALLER  - e.g. "Developer ID Installer: Colin Bitterfield (G3FY7T45K8)"
#
# Usage: ./scripts/sign.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSX_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$(dirname "$OSX_DIR")")"
BUILD_DIR="$OSX_DIR/build"
OUTPUT_DIR="$BUILD_DIR/output"
APP_BUNDLE="$BUILD_DIR/ImapMCPControl.app"
PAYLOAD_SERVER_DIR="$BUILD_DIR/payload/server"
PAYLOAD_CONTROL_DIR="$BUILD_DIR/payload/control"

log_step() { echo ""; echo "===> $1"; }
log_ok()   { echo "     OK: $1"; }
log_warn() { echo "     WARN: $1"; }
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
# Determine version
# ---------------------------------------------------------------
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
echo "Signing IMAP MCP Pro ${VERSION}..."

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
# Verify build artifacts exist
# ---------------------------------------------------------------
log_step "Verifying build artifacts"
[ -d "$APP_BUNDLE" ]           || die "App bundle not found: $APP_BUNDLE\n  Run: make build"
[ -d "$PAYLOAD_SERVER_DIR" ]   || die "Server payload not found: $PAYLOAD_SERVER_DIR\n  Run: make build"
[ -d "$PAYLOAD_CONTROL_DIR" ]  || die "Control payload not found: $PAYLOAD_CONTROL_DIR\n  Run: make build"
log_ok "Build artifacts found."

# ---------------------------------------------------------------
# Step 1: Sign the .app bundle (in build/, not payload yet)
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

codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" \
    || die "App signature verification failed."
log_ok "App signature verified."

# ---------------------------------------------------------------
# Step 2: Sync signed .app into control payload
# (replace the unsigned copy pkgbuild would have used)
# ---------------------------------------------------------------
log_step "Syncing signed .app into control payload"
rm -rf "$PAYLOAD_CONTROL_DIR/apps/ImapMCPControl.app"
cp -r "$APP_BUNDLE" "$PAYLOAD_CONTROL_DIR/apps/ImapMCPControl.app"
log_ok "Signed .app staged in control payload."

# ---------------------------------------------------------------
# Step 3: Sign bundled Node.js runtime binary
# ---------------------------------------------------------------
log_step "Signing bundled Node.js binary"
NODE_BINARY="$PAYLOAD_SERVER_DIR/runtime/node/bin/node"
if [ -f "$NODE_BINARY" ]; then
    codesign \
        --force \
        --timestamp \
        --options runtime \
        --sign "$DEVELOPER_ID_APP" \
        "$NODE_BINARY"
    log_ok "Node binary signed."
else
    log_warn "Node binary not found at $NODE_BINARY — skipping."
fi

# ---------------------------------------------------------------
# Step 4: Sign native binaries in node_modules
# Notarization requires all Mach-O binaries in the payload to be
# signed with a valid Developer ID and have a hardened runtime.
# ---------------------------------------------------------------
log_step "Signing native binaries in node_modules"

sign_binary() {
    local bin="$1"
    if [ -f "$bin" ] && file "$bin" | grep -qE "Mach-O|mach-o"; then
        codesign \
            --force \
            --timestamp \
            --options runtime \
            --sign "$DEVELOPER_ID_APP" \
            "$bin" 2>/dev/null && echo "     Signed: ${bin#$PAYLOAD_SERVER_DIR/}" || \
            log_warn "Failed to sign: ${bin#$PAYLOAD_SERVER_DIR/}"
    fi
}

# Sign all .node native addon files
while IFS= read -r -d '' f; do
    sign_binary "$f"
done < <(find "$PAYLOAD_SERVER_DIR/node_modules" -name "*.node" -print0 2>/dev/null)

# Sign esbuild and other standalone native executables (not .node, not scripts)
while IFS= read -r -d '' f; do
    # Skip symlinks (they point to real files already handled or handled below)
    [ -L "$f" ] && continue
    sign_binary "$f"
done < <(find "$PAYLOAD_SERVER_DIR/node_modules" \
    \( -path "*/esbuild/bin/esbuild" \
    -o -path "*/@esbuild/darwin-*/bin/esbuild" \
    \) -print0 2>/dev/null)

log_ok "Native binary signing complete."

# ---------------------------------------------------------------
# Step 5: Rebuild component packages from signed payload
# (the pkgs built during 'make build' had unsigned content)
# ---------------------------------------------------------------
log_step "Rebuilding component packages with signed payload"

INSTALL_DEST="$HOME/.local/share/imap-mcp-pro"
SERVER_PKG="$OUTPUT_DIR/imap-mcp-pro-server.pkg"
CONTROL_PKG="$OUTPUT_DIR/imap-mcp-control.pkg"
FINAL_PKG="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}.pkg"

pkgbuild \
    --root "$PAYLOAD_SERVER_DIR" \
    --identifier "com.templeofepiphany.imap-mcp-pro.server" \
    --version "$VERSION" \
    --install-location "$INSTALL_DEST" \
    --scripts "$OSX_DIR/pkg/scripts" \
    "$SERVER_PKG"
log_ok "Server component package rebuilt."

pkgbuild \
    --root "$PAYLOAD_CONTROL_DIR" \
    --identifier "com.templeofepiphany.imap-mcp-pro.control" \
    --version "$VERSION" \
    --install-location "$INSTALL_DEST" \
    "$CONTROL_PKG"
log_ok "Control component package rebuilt."

productbuild \
    --distribution "$OSX_DIR/pkg/distribution.xml" \
    --resources "$OSX_DIR/pkg/resources" \
    --package-path "$OUTPUT_DIR" \
    "$FINAL_PKG"
log_ok "Product package rebuilt: $FINAL_PKG"

# ---------------------------------------------------------------
# Step 6: productsign the final package
# ---------------------------------------------------------------
log_step "Signing product package"
SIGNED_PKG="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}-signed.pkg"

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
