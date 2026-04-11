#!/bin/bash
# build.sh - IMAP MCP Pro macOS Distribution Build Script
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-09
# Date Updated: 2026-04-09
# Version: 1.0.0
#
# Builds the IMAP MCP Pro macOS distribution package.
# Steps:
#   1. Verify required tools
#   2. Determine version from package.json
#   3. Build the TypeScript project
#   4. Download and assemble universal Node.js runtime
#   5. Build the Swift menu bar app
#   6. Assemble payload directories
#   7. Build component packages (pkgbuild)
#   8. Build final product package (productbuild)
#
# Usage: ./scripts/build.sh
# Run from: distributions/osx/

set -euo pipefail

# ---------------------------------------------------------------
# Paths
# ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSX_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$(dirname "$OSX_DIR")")"
BUILD_DIR="$OSX_DIR/build"
CACHE_DIR="$BUILD_DIR/cache"
PAYLOAD_SERVER_DIR="$BUILD_DIR/payload/server"
PAYLOAD_CONTROL_DIR="$BUILD_DIR/payload/control"
OUTPUT_DIR="$BUILD_DIR/output"

# ---------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------
NODE_VERSION="22.14.0"
NODE_ARM64_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_X64_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz"
NODE_ARM64_TAR="$CACHE_DIR/node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_X64_TAR="$CACHE_DIR/node-v${NODE_VERSION}-darwin-x64.tar.gz"

# ---------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------
log_step() {
    echo ""
    echo "===> $1"
}

log_ok() {
    echo "     OK: $1"
}

log_warn() {
    echo "     WARN: $1" >&2
}

die() {
    echo "" >&2
    echo "ERROR: $1" >&2
    exit 1
}

require_tool() {
    command -v "$1" >/dev/null 2>&1 || die "Required tool not found: $1. $2"
}

# ---------------------------------------------------------------
# Step 1: Check required tools
# ---------------------------------------------------------------
log_step "Checking required tools"
require_tool swift "Install Xcode or Xcode Command Line Tools."
require_tool pkgbuild "Install Xcode Command Line Tools: xcode-select --install"
require_tool productbuild "Install Xcode Command Line Tools: xcode-select --install"
require_tool lipo "Install Xcode Command Line Tools."
require_tool curl "Install curl."
require_tool node "Install Node.js for the build step."
log_ok "All required tools found."

# ---------------------------------------------------------------
# Step 2: Determine version
# ---------------------------------------------------------------
log_step "Reading version from package.json"
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
echo "     Version: $VERSION"

# ---------------------------------------------------------------
# Step 3: Build the TypeScript project
# ---------------------------------------------------------------
log_step "Building TypeScript project"
cd "$PROJECT_DIR"
if [ ! -d "$PROJECT_DIR/dist" ] || [ "$PROJECT_DIR/src" -nt "$PROJECT_DIR/dist" ]; then
    npm run build
    log_ok "TypeScript build complete."
else
    log_ok "dist/ is up to date, skipping rebuild. Run 'npm run build' to force."
fi
cd "$OSX_DIR"

# ---------------------------------------------------------------
# Step 4: Create build directories
# ---------------------------------------------------------------
log_step "Creating build directories"
mkdir -p "$CACHE_DIR"
mkdir -p "$PAYLOAD_SERVER_DIR/runtime/node/bin"
mkdir -p "$PAYLOAD_SERVER_DIR/runtime/node/lib"
mkdir -p "$PAYLOAD_SERVER_DIR/logs"
mkdir -p "$PAYLOAD_CONTROL_DIR/apps"
mkdir -p "$OUTPUT_DIR"
log_ok "Directories created."

# ---------------------------------------------------------------
# Step 5: Download Node.js universal binary
# ---------------------------------------------------------------
log_step "Preparing bundled Node.js v${NODE_VERSION} (universal)"

# Download arm64 tarball (cached)
if [ ! -f "$NODE_ARM64_TAR" ]; then
    echo "     Downloading arm64 tarball..."
    curl -fL --progress-bar -o "$NODE_ARM64_TAR" "$NODE_ARM64_URL" \
        || die "Failed to download arm64 Node.js from $NODE_ARM64_URL"
else
    log_ok "arm64 tarball already cached."
fi

# Download x64 tarball (cached)
if [ ! -f "$NODE_X64_TAR" ]; then
    echo "     Downloading x64 tarball..."
    curl -fL --progress-bar -o "$NODE_X64_TAR" "$NODE_X64_URL" \
        || die "Failed to download x64 Node.js from $NODE_X64_URL"
else
    log_ok "x64 tarball already cached."
fi

# Extract into temporary directories
NODE_ARM64_EXTRACT="$BUILD_DIR/node-arm64"
NODE_X64_EXTRACT="$BUILD_DIR/node-x64"
NODE_ARM64_ROOT="$NODE_ARM64_EXTRACT/node-v${NODE_VERSION}-darwin-arm64"
NODE_X64_ROOT="$NODE_X64_EXTRACT/node-v${NODE_VERSION}-darwin-x64"

if [ ! -d "$NODE_ARM64_ROOT" ]; then
    echo "     Extracting arm64..."
    mkdir -p "$NODE_ARM64_EXTRACT"
    tar -xzf "$NODE_ARM64_TAR" -C "$NODE_ARM64_EXTRACT"
fi

if [ ! -d "$NODE_X64_ROOT" ]; then
    echo "     Extracting x64..."
    mkdir -p "$NODE_X64_EXTRACT"
    tar -xzf "$NODE_X64_TAR" -C "$NODE_X64_EXTRACT"
fi

# Create universal 'node' binary with lipo
RUNTIME_BIN="$PAYLOAD_SERVER_DIR/runtime/node/bin"
echo "     Creating universal node binary..."
lipo -create \
    "$NODE_ARM64_ROOT/bin/node" \
    "$NODE_X64_ROOT/bin/node" \
    -output "$RUNTIME_BIN/node"
chmod +x "$RUNTIME_BIN/node"
log_ok "Universal node binary created."

# Copy npm and npx (shell scripts, no arch concern — use arm64 source)
cp "$NODE_ARM64_ROOT/bin/npm"  "$RUNTIME_BIN/npm"  2>/dev/null || true
cp "$NODE_ARM64_ROOT/bin/npx"  "$RUNTIME_BIN/npx"  2>/dev/null || true
chmod +x "$RUNTIME_BIN/npm" "$RUNTIME_BIN/npx" 2>/dev/null || true

# Copy lib/node_modules (npm and corepack internals — use arm64 source, JS only)
cp -r "$NODE_ARM64_ROOT/lib/node_modules" "$PAYLOAD_SERVER_DIR/runtime/node/lib/" 2>/dev/null || true

# Verify the binary architecture
echo "     Verifying universal binary:"
lipo -info "$RUNTIME_BIN/node"

# Quick smoke test
"$RUNTIME_BIN/node" -e "console.log('Node ' + process.version + ' OK')"
log_ok "Node.js runtime bundled and verified."

# ---------------------------------------------------------------
# Step 6: Assemble server payload
# ---------------------------------------------------------------
log_step "Assembling server payload"

SERVER_DEST="$PAYLOAD_SERVER_DIR"

# Copy compiled TypeScript output
echo "     Copying dist/..."
rm -rf "$SERVER_DEST/dist"
cp -r "$PROJECT_DIR/dist" "$SERVER_DEST/dist"

# Copy production node_modules
echo "     Copying node_modules/..."
rm -rf "$SERVER_DEST/node_modules"
cp -r "$PROJECT_DIR/node_modules" "$SERVER_DEST/node_modules"

# Copy public web assets
echo "     Copying public/..."
rm -rf "$SERVER_DEST/public"
cp -r "$PROJECT_DIR/public" "$SERVER_DEST/public"

# Copy templates if present
if [ -d "$PROJECT_DIR/templates" ]; then
    echo "     Copying templates/..."
    rm -rf "$SERVER_DEST/templates"
    cp -r "$PROJECT_DIR/templates" "$SERVER_DEST/templates"
fi

# Copy package.json
cp "$PROJECT_DIR/package.json" "$SERVER_DEST/package.json"

log_ok "Server payload assembled (initial copy)."

# ---------------------------------------------------------------
# Step 6b: Rebuild native node addons against bundled Node.js
# The project's node_modules are compiled for the system Node
# version. If the bundled Node version differs (e.g. v22 vs v24),
# native .node files will fail to load. Rebuild them here using
# the bundled node binary so they match the runtime ABI.
# ---------------------------------------------------------------
log_step "Rebuilding native addons against bundled Node.js v${NODE_VERSION}"

# Select arch-specific node root for headers (node-gyp needs them)
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    NODE_BUILD_ROOT="$NODE_ARM64_ROOT"
else
    NODE_BUILD_ROOT="$NODE_X64_ROOT"
fi

echo "     Build arch : $ARCH"
echo "     Node headers: $NODE_BUILD_ROOT"

# Verify the bundled node can execute before we rely on it
if ! "$RUNTIME_BIN/node" --version >/dev/null 2>&1; then
    die "Bundled node binary failed smoke test: $RUNTIME_BIN/node"
fi

# Run npm rebuild inside the server payload using the bundled node.
# --nodedir tells node-gyp where to find the bundled node headers.
# We set PATH so any child node processes also use the bundled node.
#
# NOTE: We invoke npm-cli.js directly rather than the npm shebang wrapper,
# because the project's package.json ("type":"module") is an ancestor of
# the bundled node's bin/ directory — node would treat the CJS npm shebang
# script as ES module and fail with "require is not defined".
# npm-cli.js lives under lib/node_modules/npm/ which has its own CJS
# package.json, so it loads correctly.
NPM_CLI="$PAYLOAD_SERVER_DIR/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
(
    cd "$SERVER_DEST"
    export PATH="$RUNTIME_BIN:$PATH"
    "$RUNTIME_BIN/node" "$NPM_CLI" rebuild \
        --nodedir="$NODE_BUILD_ROOT" 2>&1 | sed 's/^/     /'
) || die "npm rebuild failed — native addons could not be compiled for bundled Node v${NODE_VERSION}"

echo "     Verifying better-sqlite3 loads with bundled node..."
"$RUNTIME_BIN/node" -e "require('$SERVER_DEST/node_modules/better-sqlite3')" \
    && log_ok "better-sqlite3 loads OK with bundled Node v${NODE_VERSION}." \
    || die "better-sqlite3 failed to load with bundled node after rebuild."

log_ok "Native addons rebuilt for bundled Node.js v${NODE_VERSION}."

# ---------------------------------------------------------------
# Step 7: Build Swift menu bar app
# ---------------------------------------------------------------
log_step "Building ImapMCPControl Swift app"
cd "$OSX_DIR/app"
swift build -c release 2>&1 | sed 's/^/     /'
SWIFT_BINARY="$OSX_DIR/app/.build/release/ImapMCPControl"
if [ ! -f "$SWIFT_BINARY" ]; then
    die "Swift build succeeded but binary not found at $SWIFT_BINARY"
fi
log_ok "Swift binary built: $SWIFT_BINARY"
cd "$OSX_DIR"

# ---------------------------------------------------------------
# Step 8: Generate app icon
# ---------------------------------------------------------------
log_step "Generating AppIcon.icns"
ICON_DIR="$BUILD_DIR/icon"
mkdir -p "$ICON_DIR"
swift "$SCRIPT_DIR/generate-icon.swift" "$ICON_DIR" 2>&1 | sed 's/^/     /'
if [ ! -f "$ICON_DIR/AppIcon.icns" ]; then
    log_warn "Icon generation failed — app will use default icon."
fi
log_ok "AppIcon.icns generated."

# ---------------------------------------------------------------
# Step 9: Assemble .app bundle
# ---------------------------------------------------------------
log_step "Assembling ImapMCPControl.app bundle"
APP_BUNDLE="$BUILD_DIR/ImapMCPControl.app"
APP_MACOS="$APP_BUNDLE/Contents/MacOS"
APP_RESOURCES="$APP_BUNDLE/Contents/Resources"
APP_CONTENTS="$APP_BUNDLE/Contents"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS"
mkdir -p "$APP_RESOURCES"

# Copy binary
cp "$SWIFT_BINARY" "$APP_MACOS/ImapMCPControl"
chmod +x "$APP_MACOS/ImapMCPControl"

# Copy icon
if [ -f "$ICON_DIR/AppIcon.icns" ]; then
    cp "$ICON_DIR/AppIcon.icns" "$APP_RESOURCES/AppIcon.icns"
fi

# Write Info.plist
cat > "$APP_CONTENTS/Info.plist" <<INFOPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.templeofepiphany.imap-mcp-pro.control</string>
    <key>CFBundleName</key>
    <string>ImapMCPControl</string>
    <key>CFBundleDisplayName</key>
    <string>IMAP MCP Control</string>
    <key>CFBundleExecutable</key>
    <string>ImapMCPControl</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright 2024-2026 Temple of Epiphany LLC. Licensed under Apache 2.0.</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
INFOPLIST

log_ok ".app bundle created: $APP_BUNDLE"

# Stage the app into the control payload (remove first to prevent double-nesting on rebuild)
rm -rf "$PAYLOAD_CONTROL_DIR/apps/ImapMCPControl.app"
cp -r "$APP_BUNDLE" "$PAYLOAD_CONTROL_DIR/apps/ImapMCPControl.app"
log_ok "App staged in control payload."

# ---------------------------------------------------------------
# Step 9: Build server component package
# ---------------------------------------------------------------
log_step "Building imap-mcp-pro-server.pkg"
SERVER_PKG="$OUTPUT_DIR/imap-mcp-pro-server.pkg"
# Relative path — distribution.xml uses enable_currentUserHome so the
# installer prepends $HOME. An absolute path would cause double-nesting.
INSTALL_DEST=".local/share/imap-mcp-pro"

pkgbuild \
    --root "$PAYLOAD_SERVER_DIR" \
    --identifier "com.templeofepiphany.imap-mcp-pro.server" \
    --version "$VERSION" \
    --install-location "$INSTALL_DEST" \
    --scripts "$OSX_DIR/pkg/scripts" \
    "$SERVER_PKG"

log_ok "Server component package: $SERVER_PKG"

# ---------------------------------------------------------------
# Step 10: Build control app component package
# ---------------------------------------------------------------
log_step "Building imap-mcp-control.pkg"
CONTROL_PKG="$OUTPUT_DIR/imap-mcp-control.pkg"

pkgbuild \
    --root "$PAYLOAD_CONTROL_DIR" \
    --identifier "com.templeofepiphany.imap-mcp-pro.control" \
    --version "$VERSION" \
    --install-location "$INSTALL_DEST" \
    "$CONTROL_PKG"

log_ok "Control app component package: $CONTROL_PKG"

# ---------------------------------------------------------------
# Step 11: Build final product package
# ---------------------------------------------------------------
log_step "Building IMAP-MCP-Pro-${VERSION}.pkg (product package)"
FINAL_PKG="$OUTPUT_DIR/IMAP-MCP-Pro-${VERSION}.pkg"

productbuild \
    --distribution "$OSX_DIR/pkg/distribution.xml" \
    --resources "$OSX_DIR/pkg/resources" \
    --package-path "$OUTPUT_DIR" \
    "$FINAL_PKG"

log_ok "Final product package: $FINAL_PKG"

# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
echo ""
echo "======================================================"
echo "  Build Complete"
echo "======================================================"
echo "  Version     : $VERSION"
echo "  Node.js     : v${NODE_VERSION} (universal arm64+x86_64)"
echo "  Output      : $FINAL_PKG"
echo "  Size        : $(du -sh "$FINAL_PKG" | cut -f1)"
echo "======================================================"
echo ""
echo "Next steps:"
echo "  Sign     : ./scripts/sign.sh"
echo "  Notarize : ./scripts/notarize.sh"
echo "  DMG      : ./scripts/create-dmg.sh"
echo "  Release  : make release"
echo ""
