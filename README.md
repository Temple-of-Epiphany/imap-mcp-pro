# IMAP MCP Pro

[![License: Dual — Personal Free / Commercial Paid](https://img.shields.io/badge/license-dual%20%E2%80%94%20personal%20free%20%2F%20commercial%20paid-blue)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Temple-of-Epiphany/imap-mcp-pro)](https://github.com/Temple-of-Epiphany/imap-mcp-pro/releases)

An enterprise-grade Model Context Protocol (MCP) server that provides production-ready IMAP email integration with advanced reliability features, comprehensive monitoring, and secure account management.

> **Professional Edition** — Enhanced fork with Level 1-3 reliability features, circuit breaker pattern, metrics, and bulk operations for commercial and large-scale deployments.

> ### 📜 License at a glance
>
> **Free** for personal, educational, and non-profit use.
> **Paid commercial license required** for any business, SaaS, revenue-generating, or multi-tenant deployment.
>
> Contact for commercial licensing: **colin.bitterfield@templeofepiphany.com**
> Full terms: [LICENSE](LICENSE) · [License section below](#license)

## Features

**95 MCP tools** across email/folder/account/category/scoring/subscription/dns-firewall/usercheck/staging/cache/diagnostics — every IMAP4rev2 (RFC 9051) operation we use is exposed.

### Core Features
- 🔐 **Secure Account Management**: Encrypted credential storage with AES-256 encryption
- 🚀 **Connection Pooling**: Efficient IMAP connection management
- 📧 **Comprehensive Email Operations**: Search, read, mark, delete emails
- ✉️ **Email Sending**: Send, reply, and forward emails via SMTP
- 📁 **Folder Management**: List folders, check status, get unread counts
- 🔄 **Multiple Account Support**: Manage multiple IMAP accounts simultaneously
- 🛡️ **Type-Safe**: Built with TypeScript for reliability
- 🌐 **Web-Based Setup Wizard**: Easy account configuration with provider presets
- 📱 **15+ Email Providers**: Pre-configured settings for Gmail, Outlook, Yahoo, and more
- 🔗 **Auto SMTP Configuration**: Automatic SMTP settings based on IMAP provider

### Local Message Cache + Auto-installed Skills (v2.17.0+)

- **Local SQLite header cache** for fast sender enumeration. `imap_sync_folder_cache` populates a per-folder cache; `imap_search_cache` runs `group_by_sender` / `by_domain` / `by_address` queries against it in milliseconds. Validated end-to-end against a 1500-message INBOX: cold sync 1.7s, warm group-by-sender 4ms.
- **UIDVALIDITY-aware delta sync**: subsequent syncs only fetch new UIDs. Mailbox renumbering is detected automatically and triggers a full resync.
- **Cache-miss is explicit**: `imap_search_cache` returns a structured `cache_miss` error when a folder has not been synced — no silent IMAP fallback. The skill orchestrates the order.
- **Auto-installed skills**: bundled Claude skills (`unsubscribe-cleanup` in v2.17.0) are copied to `~/.claude/skills/imap-mcp-pro/` on server startup. Idempotent: skips when versions match, updates when the bundle is newer, preserves on-disk content with a higher version. Disable via `IMAP_MCP_SKIP_SKILLS_INSTALL=1`.
- **Skill updates from public GitHub** (v2.17.4+): two new tools, `imap_check_skill_updates` and `imap_update_skills`, let you pull newer skill versions from this repo without reinstalling the `.mcpb`. No PAT needed — the default source is the MCP's own public repo. See [`docs/SKILLS.md`](docs/SKILLS.md) for the full guide including the trust model.

### v2.0 Reliability & Attachments (v2.15.0+)

- **Auto-Sent-folder placement**: every `imap_send_email` archives to the right Sent folder by provider (Gmail / Outlook / iCloud / Fastmail / Yahoo / Hostinger / Zoho / GMX / ProtonMail). Bcc preserved in the archive copy per RFC 5322 §3.6.3. Failures queue for background retry, not lost.
- **Pooled SMTP with classified retry**: nodemailer pool, exponential backoff for transient failures, immediate surface (no retry) for auth failures with provider-specific guidance (e.g. "Gmail requires an app password, generate at...").
- **Path-based attachments** (`attachmentPaths`): pass absolute file paths instead of base64. Server validates against an allowed-dirs whitelist (with per-user override), realpath + symlink-target check, size caps, RFC 2183 filename sanitization.
- **Chunked attachment uploads**: for clients without server filesystem access. 4-tool workflow (`stage_init` → `stage_append × N` → `stage_finalize` → `imap_send_email stagedAttachmentIds=[...]`). Out-of-order chunks reassemble; duplicate `chunkIndex` is idempotent; SHA-256 verification on finalize.
- **Diagnostic tools**: `imap_test_smtp`, `imap_test_sent_folder`, `imap_get_smtp_metrics`, `imap_list_unarchived_sends`, `imap_list_staged_attachments`.

### Enterprise Features (Pro Edition)

#### Level 1: Enhanced Connectivity
- ⚡ **Enhanced Keepalive**: RFC 2177 compliant NOOP commands every 29 minutes
- 🔌 **Connection Monitoring**: Real-time connection health tracking
- ✅ **Connection Validation**: Proactive connection state verification

#### Level 2: Advanced Reliability
- 🔄 **Automatic Reconnection**: Exponential backoff (1s → 2s → 4s → 8s → 60s max)
- ♻️ **Retry Logic**: Transparent retry wrapper for all operations (max 5 attempts)
- 🏥 **Health Checks**: Periodic NOOP every 29 minutes to prevent timeouts
- 📊 **Connection State Machine**: DISCONNECTED → CONNECTING → CONNECTED → RECONNECTING → ERROR
- ⚡ **Bulk Operations**: Efficient bulk delete, read, and mark operations

#### Level 3: Production-Grade Resilience
- 🛡️ **Circuit Breaker**: Prevents cascading failures (5 failures opens, 2 successes closes)
- 📦 **Operation Queue**: Queues operations during outages, replays when reconnected (1000 max)
- 📈 **Comprehensive Metrics**: Per-connection and per-operation metrics (ops, success rate, latency, uptime%)
- 🎯 **Graceful Degradation**: Read-only mode, result caching (5-min TTL), fallback to last known good data
- 🔍 **Enhanced Monitoring**: Real-time metrics via MCP tools (imap_get_metrics, imap_get_operation_metrics)

### Multi-Tenant / MSP Deployments

**🏢 Commercial License Available for MSPs**

IMAP MCP Pro supports multi-user configurations for Managed Service Providers (MSPs) with a commercial license:

- 👥 **User Isolation**: Complete data isolation between customers
- 🔐 **Per-Customer Authentication**: Separate credentials for each tenant
- 🛡️ **Role-Based Access Control**: Admin and user roles with granular permissions
- 📊 **Usage Tracking**: Per-customer API usage and metrics
- 🎛️ **Centralized Management**: Manage multiple customer deployments from single installation

**Configuration:**
```json
{
  "mcpServers": {
    "imap-customer-a": {
      "env": {
        "MCP_USER_ID": "customer-a"
      }
    },
    "imap-customer-b": {
      "env": {
        "MCP_USER_ID": "customer-b"
      }
    }
  }
}
```

**Contact for Commercial Licensing:**
- Email: colin.bitterfield@templeofepiphany.com
- Commercial license required for MSP/multi-tenant deployments
- Single-user deployments remain under Apache 2.0 license

## Installation

### Claude Desktop Extension (.mcpb) — Recommended for end users

The fastest path to a working setup is to install IMAP MCP Pro as a **Claude Desktop Extension** (`.mcpb`). This bundles everything (Node runtime, dependencies, native modules) into one archive and renders a native settings panel in Claude Desktop — no terminal, no JSON editing.

1. Download the latest `.mcpb` for your platform from the [Releases page](https://github.com/Temple-of-Epiphany/imap-mcp-pro/releases) (e.g. `imap-mcp-pro-2.14.0-macos-arm64.mcpb`).
2. In Claude Desktop, open **Settings → Extensions → Install Extension…** and select the downloaded file.
3. Fill in the settings panel that appears:
   - **Data Directory** — where to store the database and cache (default: `~/.imap-mcp-pro`)
   - **Log Level** — `INFO` is fine for day-to-day; `DEBUG` for troubleshooting
   - **Maximum Attachment Size** — default 25 MiB
   - **Allowed Attachment Directories** — *optional*, only needed for path-based attachment sends
   - **Encryption Key** — leave blank to use the system keyring (recommended)
   - **User ID** — `default` for single-user installs
4. Click **Enable**. Run a quick test by asking Claude `What IMAP accounts do I have?`.

To add accounts after install, ask Claude to use `imap_add_account_auto` (with provider auto-detection) or use the Web UI: `imap-setup` from the command line.

To upgrade, download a newer `.mcpb` and re-install — your data directory is preserved.

### macOS — Package Installer (Recommended)

Download the latest `.dmg` from the [Releases page](https://github.com/Temple-of-Epiphany/imap-mcp-pro/releases):

1. Open `IMAP-MCP-Pro-x.x.x.dmg`
2. Double-click the `.pkg` inside
3. Follow the installer — it will:
   - Prompt for the Web UI port (default: **4500**)
   - Offer to configure **Claude Desktop** automatically (if installed)
   - Install the **ImapMCPControl** menu bar app
   - Register and start the background service

After install the envelope icon appears in your menu bar. Use **Preferences…** (⌘,) to change settings at any time.

**What gets installed:**

| Path | Contents |
|------|----------|
| `~/.local/share/imap-mcp-pro/` | Server files, bundled Node.js runtime |
| `~/Applications/ImapMCPControl.app` | Menu bar status/control app |
| `~/Library/LaunchAgents/com.templeofepiphany.imap-mcp-pro.plist` | Background service definition |
| `~/.imap-mcp/` | Database and encryption keys (created on first run) |

### macOS — Upgrade

Run the same `.pkg` installer over an existing installation. The installer detects the previous version and:
- Preserves your port setting and Claude Desktop configuration
- Stops the service, replaces server files, then restarts automatically
- Does **not** touch `~/.imap-mcp/` (your accounts and data)

### Linux / Manual Installation

1. Clone the repository:
```bash
git clone https://github.com/Temple-of-Epiphany/imap-mcp-pro.git
cd imap-mcp-pro
```

2. Install dependencies and build:
```bash
npm install
npm run build
```

3. Install and start the service:
```bash
make install
```

## Account Setup

### Web-Based Setup Wizard (Recommended)

After installation, run the setup wizard:

```bash
npm run setup
```

Or if installed globally:

```bash
imap-setup
```

This will:
1. Start a local web server
2. Open your browser to the setup wizard
3. Guide you through adding email accounts with pre-configured settings

### Supported Email Providers

The setup wizard includes pre-configured settings for:
- Gmail / Google Workspace
- Microsoft Outlook / Hotmail / Live
- Yahoo Mail
- Apple iCloud Mail
- GMX
- WEB.DE
- IONOS (1&1)
- ProtonMail (with Bridge)
- Fastmail
- Hostinger
- Zoho Mail
- AOL Mail
- mailbox.org
- Posteo
- Custom IMAP servers

## Configuration

### Claude Desktop Configuration

**macOS pkg installer:** Claude Desktop is configured automatically during install. You can also manage it via **Preferences… → Claude Desktop Integration** in the menu bar app.

**Manual configuration** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "imap-mcp-pro": {
      "command": "/Users/YOUR_USERNAME/.local/share/imap-mcp-pro/runtime/node/bin/node",
      "args": ["/Users/YOUR_USERNAME/.local/share/imap-mcp-pro/dist/index.js"],
      "env": {
        "MCP_USER_ID": "YOUR_USERNAME"
      }
    }
  }
}
```

Restart Claude Desktop after any config change.

### Environment Variables

The following environment variables can be configured in your Claude Desktop configuration:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MCP_USER_ID` | User identifier for multi-tenant deployments. Isolates accounts and data per user. | `default` | No |
| `PORT` | Port number for the Web UI server | `4500` | No |
| `NODE_ENV` | Node environment mode. Set to `development` for detailed error stack traces. | `production` | No |
| `IMAP_MCP_VERSION` | Version identifier (automatically set by installer) | (package version) | No |

**Example multi-user configuration:**

```json
{
  "mcpServers": {
    "imap-work": {
      "command": "node",
      "args": ["/path/to/imap-mcp-pro/dist/index.js"],
      "env": {
        "MCP_USER_ID": "work",
        "PORT": "4500"
      }
    },
    "imap-personal": {
      "command": "node",
      "args": ["/path/to/imap-mcp-pro/dist/index.js"],
      "env": {
        "MCP_USER_ID": "personal",
        "PORT": "3001"
      }
    }
  }
}
```

**Note:** Each `MCP_USER_ID` creates separate:
- Account storage (database)
- CleanTalk API key configuration
- Web UI instance (on specified PORT)
- Session data and credentials

## Usage

Once configured, the IMAP MCP server provides the following tools in Claude:

### Account Management

- **imap_add_account**: Add a new IMAP account
  ```
  Parameters:
  - name: Friendly name for the account
  - host: IMAP server hostname
  - port: Server port (default: 993)
  - user: Username
  - password: Password
  - tls: Use TLS/SSL (default: true)
  ```

- **imap_list_accounts**: List all configured accounts

- **imap_remove_account**: Remove an account
  ```
  Parameters:
  - accountId: ID of the account to remove
  ```

- **imap_connect**: Connect to an account
  ```
  Parameters:
  - accountId OR accountName: Account identifier
  ```

- **imap_disconnect**: Disconnect from an account
  ```
  Parameters:
  - accountId: Account to disconnect
  ```

### Email Operations

- **imap_search_emails**: Search for emails
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - from, to, subject, body: Search criteria
  - since, before: Date filters
  - seen, flagged: Status filters
  - limit: Max results (default: 50)
  ```

- **imap_get_email**: Get full email content
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID
  ```

- **imap_get_latest_emails**: Get recent emails
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - count: Number of emails (default: 10)
  ```

- **imap_mark_as_read/unread**: Change email read status
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID
  ```

- **imap_delete_email**: Delete an email
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  - uid: Email UID
  ```

- **imap_send_email**: Send a new email
  ```
  Parameters:
  - accountId: Account ID to send from
  - to: Recipient email address(es)
  - subject: Email subject
  - text: Plain text content (optional)
  - html: HTML content (optional)
  - cc: CC recipients (optional)
  - bcc: BCC recipients (optional)
  - replyTo: Reply-to address (optional)
  - attachments: Array of attachments (optional)
    - filename: Attachment filename
    - content: Base64 encoded content
    - path: File path to attach
    - contentType: MIME type
  ```

- **imap_reply_to_email**: Reply to an existing email
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder containing the original email
  - uid: UID of the email to reply to
  - text: Plain text reply content (optional)
  - html: HTML reply content (optional)
  - replyAll: Reply to all recipients (default: false)
  - attachments: Array of attachments (optional)
  ```

- **imap_forward_email**: Forward an existing email
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder containing the original email
  - uid: UID of the email to forward
  - to: Forward to email address(es)
  - text: Additional text to include (optional)
  - includeAttachments: Include original attachments (default: true)
  ```

- **imap_copy_email**: Copy an email to another folder
  ```
  Parameters:
  - accountId: Account ID
  - sourceFolder: Source folder name (default: INBOX)
  - uid: Email UID to copy
  - targetFolder: Target folder name
  ```

- **imap_bulk_copy_emails**: Bulk copy multiple emails to another folder
  ```
  Parameters:
  - accountId: Account ID
  - sourceFolder: Source folder name (default: INBOX)
  - uids: Array of email UIDs to copy
  - targetFolder: Target folder name
  ```

- **imap_move_email**: Move an email to another folder
  ```
  Parameters:
  - accountId: Account ID
  - sourceFolder: Source folder name (default: INBOX)
  - uid: Email UID to move
  - targetFolder: Target folder name
  ```

- **imap_bulk_move_emails**: Bulk move multiple emails to another folder
  ```
  Parameters:
  - accountId: Account ID
  - sourceFolder: Source folder name (default: INBOX)
  - uids: Array of email UIDs to move
  - targetFolder: Target folder name
  ```

### Automatic Chunking (Smart Bulk Operations)

**All bulk operations now automatically use chunking for >50 UIDs!** You don't need to choose between regular and chunked tools - the system intelligently handles this for you.

**How it works:**
- **≤50 UIDs**: Fast single-batch processing
- **>50 UIDs**: Automatic chunked processing (100 UIDs per chunk)
- **Progress tracking**: Real-time logging in server logs
- **Error recovery**: Continues processing if individual chunks fail

### Chunked Bulk Operations (Large-Scale Processing)

For explicit control over chunking behavior:

- **imap_bulk_mark_emails_chunked**: Mark emails in chunks for large operations
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - uids: Array of email UIDs to mark (supports 1000+ UIDs)
  - operation: Mark operation (read, unread, flagged, unflagged, answered, unanswered, draft, not-draft, deleted, undeleted)
  - chunkSize: Number of emails per chunk (default: 100)

  Returns:
  - processed: Number of successfully processed emails
  - failed: Number of failed emails
  - errors: Array of error details for failed chunks
  ```

- **imap_bulk_delete_emails_chunked**: Delete emails in chunks for large operations
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - uids: Array of email UIDs to delete (supports 1000+ UIDs)
  - expunge: Permanently expunge deleted emails (default: false)
  - chunkSize: Number of emails per chunk (default: 100)

  Returns:
  - processed: Number of successfully deleted emails
  - failed: Number of failed emails
  - errors: Array of error details for failed chunks
  ```

- **imap_bulk_get_emails_chunked**: Fetch emails in chunks for large operations
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name (default: INBOX)
  - uids: Array of email UIDs to fetch (supports 1000+ UIDs)
  - fields: Fields to fetch (headers, body, or full)
  - chunkSize: Number of emails per chunk (default: 100)

  Returns:
  - count: Number of successfully fetched emails
  - totalRequested: Total number of UIDs requested
  - emails: Array of fetched email objects
  ```

**Use Case Example:**
Processing 1700 unread emails to mark bulk marketing messages for deletion:

1. Search for unread emails: `imap_search_emails` with `seen: false`
2. Fetch headers in chunks: `imap_bulk_get_emails_chunked` with 1700 UIDs and `chunkSize: 100`
3. Filter marketing emails in your application logic
4. Delete in chunks: `imap_bulk_delete_emails_chunked` with filtered UIDs

**Benefits:**
- Prevents circuit breaker trips by processing in small batches
- Continues processing even if individual chunks fail
- Provides progress tracking and error reporting
- 100ms delay between chunks prevents server overload

### Folder Operations

- **imap_list_folders**: List all folders
  ```
  Parameters:
  - accountId: Account ID
  ```

- **imap_folder_status**: Get folder information
  ```
  Parameters:
  - accountId: Account ID
  - folder: Folder name
  ```

- **imap_get_unread_count**: Count unread emails
  ```
  Parameters:
  - accountId: Account ID
  - folders: Specific folders (optional)
  ```

## Removal

### macOS

Use the menu bar app or run from the project directory:

```bash
# Interactive uninstall (prompts before removing data)
make uninstall

# Or run the script directly
distributions/osx/scripts/uninstall.sh
```

The uninstaller:
- Stops and removes the LaunchAgent
- Removes `~/Applications/ImapMCPControl.app`
- Removes `~/.local/share/imap-mcp-pro/`
- Forgets pkgutil receipts
- **Prompts** before removing `~/.imap-mcp/` (your accounts and data)
- **Prompts** before removing the Claude Desktop MCP entry

### Linux

```bash
make uninstall
```

---

## Backup and Restore

Your data lives in `~/.imap-mcp/` and consists of:

| File | Contents |
|------|----------|
| `data.db` | SQLite database — all accounts, settings, and history |
| `.encryption-key` | AES-256 encryption key for stored passwords |
| `.key` | Secondary key file |

> **Important:** A backup without the key files cannot decrypt stored passwords. Always back up the entire `~/.imap-mcp/` directory together.

### Backup

**Menu bar app:** Preferences… → Database → **Backup**  
Saves a `.zip` containing the database and both key files.

**Command line:**
```bash
# Save to ~/imap-mcp-pro-backup-YYYY-MM-DD.zip
make backup

# Save to a specific path
scripts/backup.sh /path/to/backup.zip
```

### Restore

**Menu bar app:** Preferences… → Database → **Restore**  
Select a `.zip` backup — the service stops, data is replaced, service restarts.

**Command line:**
```bash
make restore FILE=/path/to/backup.zip

# Or directly
scripts/restore.sh /path/to/backup.zip
```

The restore script stops the service before replacing files and restarts it automatically when done.

---

## Security

- Credentials are encrypted using AES-256-GCM encryption
- Encryption keys are stored separately in `~/.imap-mcp/`
- Database is stored at `~/.imap-mcp/data.db`
- Never commit or share your encryption keys or database

## Development

### Running in Development Mode

```bash
npm run dev
```

### Building

```bash
npm run build
```

### Project Structure

```
src/
├── index.ts           # MCP server entry point
├── services/
│   ├── imap-service.ts    # IMAP connection management
│   ├── smtp-service.ts    # SMTP service for sending emails
│   └── account-manager.ts # Account configuration
├── tools/
│   ├── index.ts          # Tool registration
│   ├── account-tools.ts  # Account management tools
│   ├── email-tools.ts    # Email operation tools (including send/reply/forward)
│   └── folder-tools.ts   # Folder operation tools
└── types/
    └── index.ts          # TypeScript type definitions
```

## Example Usage in Claude

1. **Add an account:**
   "Add my Gmail account with username john@gmail.com"

2. **Check new emails:**
   "Show me the latest 5 emails from my Gmail account"

3. **Search emails:**
   "Search for emails from boss@company.com in the last week"

4. **Send an email:**
   "Send an email to client@example.com with subject 'Project Update'"

5. **Reply to emails:**
   "Reply to the latest email from my boss"

6. **Forward emails:**
   "Forward the email with subject 'Meeting Notes' to team@company.com"

7. **Manage folders:**
   "List all folders in my email account and show unread counts"

## Troubleshooting

### Connection Issues

- Ensure your IMAP server settings are correct
- Check if your email provider requires app-specific passwords
- Verify that IMAP is enabled in your email account settings
- For sending emails, ensure your account has SMTP access enabled

### SMTP Configuration

The server automatically configures SMTP settings based on your IMAP provider. If you need custom SMTP settings, you can specify them when adding an account:

```json
{
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false
  }
}
```

### Common IMAP Settings

- **Gmail**: 
  - Host: imap.gmail.com
  - Port: 993
  - Requires app-specific password

- **Outlook/Hotmail**:
  - Host: outlook.office365.com
  - Port: 993

- **Yahoo**:
  - Host: imap.mail.yahoo.com
  - Port: 993
  - Requires app-specific password

## Troubleshooting

### Where do logs go?

Claude Desktop captures the server's stderr to per-server log files:

| Platform | Path |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-imap-mcp-pro.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-imap-mcp-pro.log` |
| Linux | `~/.local/state/Claude/logs/mcp-server-imap-mcp-pro.log` |

Look for lines like `[startup] stage=pre-handshake outcome=ok duration_ms=12` to confirm the server is starting cleanly. If pre-handshake exceeds 2 s, you'll see an `outcome=warning` line.

### Common failures

**"Configuration valid" but tools fail at runtime**
Run `node /path/to/server/dist/index.js --validate-config` (or via the .mcpb extension's bundled server). It prints every resolved value and flags filesystem permission issues separately from schema errors.

**Database errors on startup (exit 2)**
Usually permissions on the data directory. Check `database.path` from `--validate-config` — the parent directory must be writable.

**Tools return "warming up" responses on first call**
Background services are still initializing (post-handshake stage). Wait a few seconds and retry. If it persists, check the log for an `outcome=error` line.

**Server appears unresponsive in Claude Desktop**
Most often a pre-handshake timeout. Confirm with `--validate-config` first; if that's OK, check the log for the pre-handshake `duration_ms` — anything over 2000 will time out.

**Configuration not picking up env var**
Run `--validate-config` and look at the `[source]` tag next to the field. Sources, highest precedence first: `cli` > `env` > `file` > `default`. If `[default]` is shown when you expected `[env]`, the env var name may be wrong — see the canonical mapping in `src/config/server-config.ts:ENV_VAR_MAPPING`.

### Inspecting the config schema

```bash
node dist/index.js --print-config-schema | jq .
```

Returns the full JSON Schema for `ServerConfig` — type, defaults, descriptions, validation bounds for every field.

### Inspecting the tool catalog

```bash
node dist/index.js --print-tools-manifest | jq '.tools | length'
```

## Documentation

- [`EXAMPLES.md`](./EXAMPLES.md) — worked Claude conversation transcripts for common workflows
- [`docs/SKILLS.md`](./docs/SKILLS.md) — bundled skills, auto-install behavior, GitHub-update tooling, contributor guide
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — codebase map, startup stages, response-shape policy, contributor guide
- [`docs/sdk_audit_2026-04-29.md`](./docs/sdk_audit_2026-04-29.md) — MCP SDK alignment audit
- RFC 9051 (IMAP4rev2) full text in `rfc/rfc9051.txt`

## License

> **Free for personal use. Paid for commercial use.**

This software is distributed under a **Dual License Model**. The license you operate under depends entirely on how you use the software.

### ✅ Non-Commercial License — FREE

You may use, copy, modify, and distribute this software at no cost when your use is **non-commercial**, including:

- Personal email management on your own accounts
- Educational use (students, instructors, classroom)
- Academic research projects
- Internal operations of qualifying non-profit organizations
- Open source project development
- Evaluation, testing, and proof-of-concept work

Modifications you make under this license must be shared under the same non-commercial terms.

### 💼 Commercial License — PAID (required)

A paid commercial license is **required** before you may use this software for any of the following:

- Business email operations of a for-profit company
- Any SaaS product, hosted service, or paid offering
- Multi-tenant or MSP (Managed Service Provider) deployments
- Production deployments of revenue-generating services
- Re-distribution as part of a commercial product
- Use by an organization that generates revenue (other than qualifying non-profits' internal operations)

If your use isn't on the free list above, you need a commercial license — even if you're not directly charging users for the email feature.

### Getting a commercial license

**Contact:** colin.bitterfield@templeofepiphany.com
**Organization:** Temple of Epiphany

Commercial license terms include support and maintenance, priority bug fixes, production deployment rights, and legal indemnification. Both perpetual and subscription options are available.

### Not sure which applies to you?

If your use case isn't an obvious fit for the non-commercial list, default to assuming you need a commercial license and email us — happy to clarify.

Full legal terms: [LICENSE](LICENSE).

## Attribution

This project is an enterprise-enhanced fork of the original IMAP MCP Server created by Michael Nikolaus.

**Original Project:** https://github.com/nikolausm/imap-mcp-server
**Original Author:** Michael Nikolaus
**Original License:** MIT License (applies to base code only)

Temple of Epiphany has added extensive enterprise features (Levels 1-3) which are subject to the dual-license model above.

## Contributing

We welcome contributions! For commercial use contributions, contributors agree that their contributions will be subject to the project's dual-license model.

Please feel free to submit Pull Requests for:
- Bug fixes
- Documentation improvements
- New features
- Performance enhancements

For major changes, please open an issue first to discuss what you would like to change.