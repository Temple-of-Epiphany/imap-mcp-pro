# Makefile - IMAP MCP Pro macOS Distribution Build
#
# Author: Colin Bitterfield
# Email: colin.bitterfield@templeofepiphany.com
# Date Created: 2026-04-09
# Date Updated: 2026-04-09
# Version: 1.0.0
#
# Targets:
#   help       Display this help (default)
#   build      Build the .pkg (downloads Node.js, builds Swift app, assembles)
#   sign       Code sign the .app and .pkg (requires Developer ID certificates)
#   notarize   Submit to Apple notarization and staple ticket
#   pkg        Alias for build
#   dmg        Create DMG containing the .pkg
#   release    Full pipeline: build + sign + notarize + dmg
#   uninstall  Remove IMAP MCP Pro from the local machine
#   clean      Remove all build artifacts

SCRIPT_DIR := $(shell pwd)/scripts
VERSION    := $(shell node -p "require('../../package.json').version" 2>/dev/null || echo "unknown")
OUTPUT_DIR := $(shell pwd)/build/output

.PHONY: help build sign notarize pkg dmg release uninstall clean

# Default target
help:
	@echo ""
	@echo "  IMAP MCP Pro - macOS Distribution Build"
	@echo "  Version: $(VERSION)"
	@echo ""
	@echo "  Targets:"
	@echo "    make build      Build the unsigned .pkg"
	@echo "                    (downloads Node.js v22, builds Swift app)"
	@echo ""
	@echo "    make sign       Code sign the .app and .pkg"
	@echo "                    Requires: DEVELOPER_ID_APP, DEVELOPER_ID_INSTALLER"
	@echo ""
	@echo "    make notarize   Submit signed .pkg to Apple for notarization"
	@echo "                    Requires: keychain profile 'imap-mcp-pro-notarize'"
	@echo "                    OR: APPLE_ID, TEAM_ID, NOTARIZE_PASSWORD env vars"
	@echo ""
	@echo "    make dmg        Package the .pkg into a distributable .dmg"
	@echo ""
	@echo "    make pkg        Alias for 'make build'"
	@echo ""
	@echo "    make release    Full pipeline: build → sign → notarize → dmg"
	@echo ""
	@echo "    make uninstall  Remove IMAP MCP Pro from this machine"
	@echo "                    (prompts before deleting account data)"
	@echo ""
	@echo "    make clean      Remove build/ directory"
	@echo ""
	@echo "  Environment variables:"
	@echo "    DEVELOPER_ID_APP        Developer ID Application certificate name"
	@echo "    DEVELOPER_ID_INSTALLER  Developer ID Installer certificate name"
	@echo "    APPLE_ID                Apple ID for notarization"
	@echo "    TEAM_ID                 Apple Developer Team ID"
	@echo "    NOTARIZE_PASSWORD       App-specific password for notarization"
	@echo ""
	@echo "  Output: build/output/IMAP-MCP-Pro-$(VERSION).pkg"
	@echo "          build/output/IMAP-MCP-Pro-$(VERSION).dmg"
	@echo ""

build:
	@echo "Building IMAP MCP Pro $(VERSION) macOS package..."
	@bash $(SCRIPT_DIR)/build.sh

pkg: build

sign:
	@echo "Signing IMAP MCP Pro $(VERSION)..."
	@bash $(SCRIPT_DIR)/sign.sh

notarize:
	@echo "Notarizing IMAP MCP Pro $(VERSION)..."
	@bash $(SCRIPT_DIR)/notarize.sh

dmg:
	@echo "Creating DMG for IMAP MCP Pro $(VERSION)..."
	@bash $(SCRIPT_DIR)/create-dmg.sh

release: build sign notarize dmg
	@echo ""
	@echo "======================================================"
	@echo "  Release build complete: v$(VERSION)"
	@echo "======================================================"
	@ls -lh $(OUTPUT_DIR)/ 2>/dev/null || true
	@echo ""
	@echo "Upload to GitHub Release:"
	@echo "  gh release create v$(VERSION) \\"
	@echo "    $(OUTPUT_DIR)/IMAP-MCP-Pro-$(VERSION).dmg \\"
	@echo "    $(OUTPUT_DIR)/IMAP-MCP-Pro-$(VERSION).pkg \\"
	@echo "    --title \"IMAP MCP Pro v$(VERSION)\""
	@echo ""

uninstall:
	@echo "Uninstalling IMAP MCP Pro from this machine..."
	@bash $(SCRIPT_DIR)/uninstall.sh

clean:
	@echo "Removing build artifacts..."
	find build/ -type d -exec chmod u+w {} + 2>/dev/null || true
	find build/ -type f -exec chmod u+w {} + 2>/dev/null || true
	rm -rf build/
	@echo "Clean complete."
