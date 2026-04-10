#!/bin/bash
# create-dmg.sh - IMAP MCP Pro macOS DMG Creation Script
#
# Author: Colin Bitterfield
# Email: colin@bitterfield.com
# Date Created: 2026-04-09
# Date Updated: 2026-04-09
# Version: 1.0.0
#
# Creates a distributable DMG containing the signed (and optionally notarized) .pkg.
# The DMG itself does not require notarization when it only contains a signed .pkg.
#
# Output: build/output/IMAP-MCP-Pro-<VERSION>.dmg
#
# Usage: ./scripts/create-dmg.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSX_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$(dirname "$OSX_DIR")")"
BUILD_DIR="$OSX_DIR/build"
OUTPUT_DIR="$BUILD_DIR/output"
DMG_STAGING_DIR="$BUILD_DIR/dmg-staging"

log_step() { echo ""; echo "===> $1"; }
log_ok()   { echo "     OK: $1"; }
die()      { echo "" >&2; echo "ERROR: $1" >&2; exit 1; }

# ---------------------------------------------------------------
# Determine version and file paths
# ---------------------------------------------------------------
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
PKG_FILE="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}.pkg"
DMG_FILE="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}.dmg"
DMG_VOLUME_NAME="IMAP MCP Pro ${VERSION}"
TMP_DMG="$BUILD_DIR/tmp-imap-mcp-pro.dmg"

# ---------------------------------------------------------------
# Verify the package exists
# ---------------------------------------------------------------
log_step "Verifying package"
[ -f "$PKG_FILE" ] || die "Package not found: $PKG_FILE\n  Run: make build (and optionally make sign && make notarize)"
log_ok "Package found: $PKG_FILE"
echo "     Size: $(du -sh "$PKG_FILE" | cut -f1)"

# ---------------------------------------------------------------
# Prepare DMG staging directory
# ---------------------------------------------------------------
log_step "Preparing DMG staging directory"
rm -rf "$DMG_STAGING_DIR"
mkdir -p "$DMG_STAGING_DIR"

# Copy the package into the staging area
cp "$PKG_FILE" "$DMG_STAGING_DIR/IMAP-MCP-Pro-${VERSION}.pkg"

# Add a simple README to guide users
cat > "$DMG_STAGING_DIR/README.txt" <<README
IMAP MCP Pro v${VERSION}
========================

To install:
  1. Double-click "IMAP-MCP-Pro-${VERSION}.pkg"
  2. Follow the on-screen instructions
  3. After installation, a menu bar icon will appear

Documentation & Support:
  https://github.com/Temple-of-Epiphany/imap-mcp-pro

Requirements:
  - macOS 13 (Ventura) or later
  - 500 MB free disk space
README

log_ok "Staging directory ready."

# ---------------------------------------------------------------
# Calculate DMG size (package size + 20% headroom)
# ---------------------------------------------------------------
log_step "Calculating DMG size"
PKG_SIZE_KB=$(du -sk "$DMG_STAGING_DIR" | cut -f1)
DMG_SIZE_KB=$(( PKG_SIZE_KB * 120 / 100 + 2048 ))  # +20% headroom + 2MB minimum buffer
echo "     Payload size : ${PKG_SIZE_KB} KB"
echo "     DMG size     : ${DMG_SIZE_KB} KB"

# ---------------------------------------------------------------
# Remove any existing DMG files
# ---------------------------------------------------------------
rm -f "$DMG_FILE" "$TMP_DMG"

# ---------------------------------------------------------------
# Create the DMG
# ---------------------------------------------------------------
log_step "Creating DMG: $DMG_FILE"

hdiutil create \
    -srcfolder "$DMG_STAGING_DIR" \
    -volname "$DMG_VOLUME_NAME" \
    -fs HFS+ \
    -fsargs "-c c=16,a=16,b=16" \
    -format UDRW \
    -size "${DMG_SIZE_KB}k" \
    "$TMP_DMG"

log_ok "Writable DMG image created."

# Convert to compressed, read-only final DMG
hdiutil convert "$TMP_DMG" \
    -format UDZO \
    -imagekey zlib-level=9 \
    -o "$DMG_FILE"

log_ok "Compressed read-only DMG created."

# Clean up temporary writable image
rm -f "$TMP_DMG"
log_ok "Temporary image removed."

# ---------------------------------------------------------------
# Verify the DMG
# ---------------------------------------------------------------
log_step "Verifying DMG"
hdiutil verify "$DMG_FILE"
log_ok "DMG verification passed."

# Show contents
echo ""
echo "     DMG contents:"
hdiutil attach "$DMG_FILE" -nobrowse -quiet
MOUNT_POINT=$(hdiutil info | grep "/Volumes/$DMG_VOLUME_NAME" | awk '{print $NF}' 2>/dev/null || echo "")
if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    ls -lh "$MOUNT_POINT/" | sed 's/^/       /'
    hdiutil detach "$MOUNT_POINT" -quiet
fi

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
DMG_SIZE=$(du -sh "$DMG_FILE" | cut -f1)
echo ""
echo "======================================================"
echo "  DMG Creation Complete"
echo "======================================================"
echo "  Version : $VERSION"
echo "  DMG     : $DMG_FILE"
echo "  Size    : $DMG_SIZE"
echo "======================================================"
echo ""
echo "The DMG is ready for distribution via GitHub Releases."
echo "  Upload: gh release upload v${VERSION} \"$DMG_FILE\""
echo ""
