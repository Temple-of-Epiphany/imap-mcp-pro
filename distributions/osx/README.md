# IMAP MCP Pro - macOS Distribution

**Version:** 1.0.0
**Author:** Colin Bitterfield
**Contact:** colin.bitterfield@templeofepiphany.com
**Date Created:** 2026-04-09
**Date Updated:** 2026-04-09

Builds a signed, notarized macOS installer package (.pkg) and disk image (.dmg) for IMAP MCP Pro. The package bundles its own Node.js runtime (v22 LTS universal binary for arm64 and x86_64) so users do not need to install Node.js separately.

---

## Requirements

### Build Machine

- macOS 13 (Ventura) or later
- **Xcode Command Line Tools:** `xcode-select --install`
- **Swift:** Included with Xcode CLT (Swift 5.9+)
- **Node.js:** Any version, for running the TypeScript build step (`npm run build`)
- `pkgbuild`, `productbuild`, `lipo`, `hdiutil` — all included with Xcode CLT

### For Signing and Notarizing (required for distribution)

- **Apple Developer Program** membership
- **Developer ID Application** certificate installed in your keychain
- **Developer ID Installer** certificate installed in your keychain
- App-specific password from [appleid.apple.com](https://appleid.apple.com)

---

## Quick Start

```bash
# Navigate to the distribution directory
cd distributions/osx

# Build the unsigned package (works without Apple Developer credentials)
make build

# Sign the package (requires Developer ID certificates)
make sign

# Notarize the signed package (requires Apple ID credentials)
make notarize

# Create the distributable DMG
make dmg

# Or run the full pipeline in one step
make release
```

---

## Available Make Targets

| Target     | Description                                      |
|------------|--------------------------------------------------|
| `help`     | Show this help (default)                         |
| `build`    | Build the unsigned .pkg                          |
| `pkg`      | Alias for `build`                                |
| `sign`     | Code sign the .app bundle and .pkg               |
| `notarize` | Submit to Apple notarization and staple ticket   |
| `dmg`      | Create .dmg containing the .pkg                  |
| `release`  | Full pipeline: build + sign + notarize + dmg     |
| `clean`    | Remove all build artifacts (`build/` directory)  |

---

## Environment Variables

Set these in your shell or in a `.env` file at `distributions/osx/.env` (gitignored):

| Variable                  | Required for | Description                                           |
|---------------------------|--------------|-------------------------------------------------------|
| `DEVELOPER_ID_APP`        | sign         | "Developer ID Application: Your Name (TEAMID)"        |
| `DEVELOPER_ID_INSTALLER`  | sign         | "Developer ID Installer: Your Name (TEAMID)"          |
| `APPLE_ID`                | notarize     | Your Apple ID email address                           |
| `TEAM_ID`                 | notarize     | 10-character Apple Developer Team ID                  |
| `NOTARIZE_PASSWORD`       | notarize     | App-specific password from appleid.apple.com          |

Example `.env` file:

```bash
DEVELOPER_ID_APP="Developer ID Application: Colin Bitterfield (G3FY7T45K8)"
DEVELOPER_ID_INSTALLER="Developer ID Installer: Colin Bitterfield (G3FY7T45K8)"
APPLE_ID="colin.bitterfield@templeofepiphany.com"
TEAM_ID="G3FY7T45K8"
NOTARIZE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

**Never commit the `.env` file.** It is listed in `.gitignore`.

---

## Certificate Setup (One-Time)

### 1. Create Certificates in Xcode

1. Open Xcode > Settings (or Preferences) > Accounts
2. Select your Apple ID and click "Manage Certificates"
3. Click the `+` button and create:
   - **Developer ID Application**
   - **Developer ID Installer**
4. The certificates are installed in your login keychain automatically

### 2. Find Your Certificate Names

```bash
security find-certificate -a -c "Developer ID" | grep "alis"
```

Copy the exact names for use in the environment variables.

### 3. Find Your Team ID

```bash
# From the certificate subject
security find-certificate -c "Developer ID Application" | grep "alis" | head -1
# Or log into developer.apple.com > Account > Membership Details
```

---

## Setting Up Keychain Credentials for Notarytool

To avoid passing credentials as environment variables (recommended for local development):

```bash
xcrun notarytool store-credentials "imap-mcp-pro-notarize" \
    --apple-id "colin.bitterfield@templeofepiphany.com" \
    --team-id  "G3FY7T45K8" \
    --password "xxxx-xxxx-xxxx-xxxx"
```

The password is an **app-specific password**, not your Apple ID password:

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in > Security > App-Specific Passwords
3. Click "Generate Password" and label it "imap-mcp-pro-notarize"

Once the keychain profile is set up, `notarize.sh` will use it automatically without needing `APPLE_ID`, `TEAM_ID`, or `NOTARIZE_PASSWORD` in the environment.

---

## Build Outputs

After `make build`:

```
build/
├── cache/                          Node.js tarballs (cached between builds)
├── node-arm64/                     Extracted arm64 Node.js
├── node-x64/                       Extracted x64 Node.js
├── payload/
│   ├── server/                     Server payload (dist/, node_modules/, public/)
│   │   └── runtime/node/           Bundled universal Node.js
│   └── control/                    Control app payload
│       └── apps/ImapMCPControl.app
├── ImapMCPControl.app              Built .app bundle
└── output/
    ├── imap-mcp-pro-server.pkg     Server component package
    ├── imap-mcp-control.pkg        Menu bar app component package
    ├── IMAP-MCP-Pro-<VER>.pkg      Final product package
    └── IMAP-MCP-Pro-<VER>.dmg      Distributable DMG (after make dmg)
```

---

## GitHub Actions

The workflow at `.github/workflows/build-pkg.yml` automates the full release pipeline:

### Triggers

- **Tag push:** Pushing a tag matching `v*` (e.g., `v2.13.1`) triggers a full build + sign + notarize + release
- **Manual dispatch:** Run from GitHub Actions UI, with option to skip notarization for testing

### Required GitHub Secrets

Set these in your repository Settings > Secrets and Variables > Actions:

| Secret                        | Description                                              |
|-------------------------------|----------------------------------------------------------|
| `DEVELOPER_ID_CERT_P12`       | Base64-encoded .p12 file with both Developer ID certs    |
| `DEVELOPER_ID_CERT_PASSWORD`  | Password used when exporting the .p12                    |
| `DEVELOPER_ID_APP`            | Developer ID Application certificate name                |
| `DEVELOPER_ID_INSTALLER`      | Developer ID Installer certificate name                  |
| `APPLE_ID`                    | Apple ID email                                           |
| `TEAM_ID`                     | Apple Developer Team ID                                  |
| `NOTARIZE_PASSWORD`           | App-specific password for notarization                   |

### Exporting the .p12 for CI

```bash
# Export both Developer ID certs from Keychain Access:
# 1. Open Keychain Access
# 2. Select "Developer ID Application" AND "Developer ID Installer" certs (with private keys)
# 3. File > Export Items > Save as .p12 > set a strong password
# 4. Encode for GitHub Secret:
base64 -i developer_id_certs.p12 | pbcopy
# Paste into the DEVELOPER_ID_CERT_P12 secret
```

### Creating a Release

```bash
# Tag the commit and push
git tag v2.13.1
git push origin v2.13.1
```

GitHub Actions will automatically build, sign, notarize, create the DMG, and upload both the `.pkg` and `.dmg` to the GitHub Release.

---

## What Gets Installed

When a user runs the installer, it installs to the user's home directory (no admin password required):

| Component                    | Location                                        |
|------------------------------|-------------------------------------------------|
| Server (dist/, node_modules) | `~/.local/share/imap-mcp-pro/`                  |
| Bundled Node.js runtime      | `~/.local/share/imap-mcp-pro/runtime/node/`     |
| Web UI assets (public/)      | `~/.local/share/imap-mcp-pro/public/`           |
| Logs                         | `~/.local/share/imap-mcp-pro/logs/`             |
| LaunchAgent plist            | `~/Library/LaunchAgents/com.templeofepiphany.imap-mcp-pro.plist` |
| Menu bar app                 | `~/Applications/ImapMCPControl.app`             |

The LaunchAgent auto-starts the web server at login. The web UI is accessible at `http://localhost:4500` by default.

---

## Troubleshooting

### Swift build fails

```bash
# Verify Swift is available
swift --version

# Verify Xcode CLT are installed
xcode-select -p

# If Xcode CLT missing:
xcode-select --install
```

### Node.js download fails

```bash
# Check your internet connection, then retry
make clean && make build
# Downloads are cached in build/cache/ — partial downloads are auto-retried
```

### Signing fails: "certificate not found"

```bash
# List installed Developer ID certificates
security find-certificate -a -c "Developer ID"
# Ensure the exact name matches your DEVELOPER_ID_APP / DEVELOPER_ID_INSTALLER values
```

### Notarization fails

```bash
# Check the full notarization log (submission ID is shown in output)
xcrun notarytool log SUBMISSION_ID --keychain-profile "imap-mcp-pro-notarize"
```

### Service does not start after installation

```bash
# Check LaunchAgent status
launchctl list | grep imap-mcp-pro

# View logs
tail -f ~/.local/share/imap-mcp-pro/logs/web-ui-error.log

# Manual start
launchctl load ~/Library/LaunchAgents/com.templeofepiphany.imap-mcp-pro.plist
```
