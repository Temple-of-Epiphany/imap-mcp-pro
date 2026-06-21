# Migration Guide

**Author:** Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
**Date Created:** 2026-04-29
**Date Updated:** 2026-04-29

This guide covers upgrades from earlier IMAP MCP Pro versions. Read the section that matches your starting point.

---

## Upgrading to v2.14.0 from v2.13.x or earlier

**TL;DR: zero-touch upgrade for env-var users.** Every legacy `IMAP_MCP_*` variable still works. The new `ServerConfig` schema is purely additive on the user surface.

### What's new in v2.14.0

- **Claude Desktop Extension (.mcpb)** install path — recommended for end users
- **Typed configuration** via Zod `ServerConfig` (32 fields, multi-source loader)
- **CLI diagnostic flags**: `--print-config-schema`, `--validate-config`, `--print-tools-manifest`
- **Three-stage startup** with structured stderr logs and documented exit codes
- **Explicit MCP capabilities** declared on `McpServer` construction

### Breaking changes

**None.** All existing env vars continue to work, every tool keeps a stable schema (run `imap_list_tools` for the current catalog), the database stays at `1.7.0` (no schema changes in this release), and the wire protocol is unchanged.

### Recommended migration paths

#### Path A — switch to the .mcpb extension (recommended for end users)

1. Download the latest `.mcpb` for your platform from the [Releases page](https://github.com/Temple-of-Epiphany/imap-mcp-pro/releases).
2. In Claude Desktop, **Settings → Extensions → Install Extension…** and choose the `.mcpb`.
3. The settings panel will appear. Suggested values for an upgrade:
   - **Data Directory**: point to your existing `~/.imap-mcp` (preserves accounts, results cache, encryption key)
   - **Log Level**: `INFO`
   - **User ID**: whatever you had set as `MCP_USER_ID` (default: `default`)
   - **Encryption Key**: leave blank to keep using your existing on-disk key file (`~/.imap-mcp/.encryption-key`, mode 600). Credentials are encrypted with AES-256-GCM. (The previous OS-keyring path was removed in v2.x when the native `keytar`/SQLCipher dependencies were dropped — storage is now purely file-based.)
4. **Disable the old MCP server entry** in `claude_desktop_config.json` so Claude Desktop doesn't run two copies.
5. Restart Claude Desktop.
6. Verify with `imap_list_accounts` — your accounts should be there.

#### Path B — keep the existing manual install, no changes required

You're already using `IMAP_MCP_*` env vars in `claude_desktop_config.json` or a `.env` file. **Nothing changes.** The new config loader reads the same vars.

If you want to take advantage of the new capabilities:

- Run `node /path/to/dist/index.js --validate-config` to inspect your resolved configuration.
- Run `node /path/to/dist/index.js --print-config-schema` to see all 32 typed fields with their defaults — anything not currently set falls back to the default.

#### Path C — switch to a config file

If managing many env vars in JSON config has gotten unwieldy, you can now use a YAML, TOML, or JSON config file:

```yaml
# imap-mcp-pro.yaml
logging:
  level: INFO

smtp:
  poolMaxPerAccount: 5
  retryMaxAttempts: 5

attachments:
  allowedDirs:
    - /Users/me/Documents/imap-attachments
  maxSizeBytes: 26214400  # 25 MiB

contextReduction:
  inlineThreshold: 30  # show up to 30 emails inline before promoting to a handle
```

Then run with `--config /path/to/imap-mcp-pro.yaml` or set `IMAP_MCP_CONFIG_PATH=/path/to/imap-mcp-pro.yaml`.

Precedence: CLI flags > env vars > config file > schema defaults. So you can mix-and-match.

### Env var → ServerConfig field mapping

The full mapping lives in `src/config/server-config.ts:ENV_VAR_MAPPING`. Highlights:

| Old env var | New ServerConfig path |
|---|---|
| `MCP_USER_ID` | `user.mcpUserId` |
| `CLAUDE_DESKTOP_EXTENSION` | `encryption.claudeDesktopExtension` |
| `IMAP_MCP_INLINE_THRESHOLD` | `contextReduction.inlineThreshold` |
| `IMAP_MCP_FILE_THRESHOLD` | `contextReduction.fileThreshold` |
| `IMAP_MCP_INLINE_BYTE_BUDGET` | `contextReduction.inlineByteBudget` |
| `IMAP_MCP_INLINE_LIMIT_CAP` | `contextReduction.inlineLimitCap` |
| `IMAP_MCP_HANDLE_LIMIT_CAP` | `contextReduction.handleLimitCap` |
| `IMAP_MCP_RESULT_TTL_MS` | `contextReduction.resultTtlMs` |
| `IMAP_MCP_MAX_RESULTS_PER_USER` | `contextReduction.maxResultsPerUser` |
| `IMAP_MCP_DISK_QUOTA` | `contextReduction.perUserDiskQuota` |
| `IMAP_MCP_CLEANUP_INTERVAL_MS` | `contextReduction.cleanupIntervalMs` |
| `IMAP_MCP_WORKERS` | `contextReduction.workerPoolSize` |
| `IMAP_MCP_WORKER_TIMEOUT` | `contextReduction.workerTaskTimeoutMs` |
| `IMAP_MCP_PREVIEW_CHARS` | `contextReduction.previewChars` |
| `IMAP_MCP_FIRST_N_PREVIEW` | `contextReduction.firstNPreviewRows` |
| `IMAP_MCP_JSONL_THRESHOLD` | `contextReduction.jsonlThresholdRows` |
| `IMAP_MCP_ATTACHMENT_MAX_BYTES` | `contextReduction.attachmentMaxBytes` |
| `IMAP_MCP_RESULTS_DIR` | `contextReduction.resultsRootDir` |
| `IMAP_MCP_SKIP_MIGRATIONS` | `database.skipMigrations` |
| `IMAP_MCP_LOG_LEVEL` *(new)* | `logging.level` |
| `IMAP_MCP_LOG_PATH` *(new)* | `logging.path` |
| `IMAP_MCP_DATABASE_PATH` *(new)* | `database.path` |
| `IMAP_MCP_ENCRYPTION_KEY` *(new)* | `encryption.masterKey` |
| `IMAP_MCP_ALLOWED_ATTACHMENT_DIRS` *(new, comma-separated)* | `attachments.allowedDirs` |
| `IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES` *(new)* | `attachments.maxSizeBytes` |
| `IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES` *(new)* | `attachments.maxTotalSizeBytes` |
| `IMAP_MCP_ATTACHMENT_STAGING_DIR` *(new)* | `attachments.stagingDir` |
| `IMAP_MCP_STAGING_TTL_SECONDS` *(new)* | `attachments.stagingTtlSeconds` |
| `IMAP_MCP_SMTP_POOL_MAX_PER_ACCOUNT` *(new)* | `smtp.poolMaxPerAccount` |
| `IMAP_MCP_SMTP_POOL_IDLE_TIMEOUT_SECONDS` *(new)* | `smtp.poolIdleTimeoutSeconds` |
| `IMAP_MCP_SMTP_RETRY_MAX_ATTEMPTS` *(new)* | `smtp.retryMaxAttempts` |
| `IMAP_MCP_AUTO_CREATE_SENT_FOLDER` *(new)* | `imap.autoCreateSentFolder` |

**New env vars** are flagged. They were not available before v2.14.0 — adopt only if you need them.

### Verifying the upgrade

After upgrading, run:

```bash
# inspect resolved config
node dist/index.js --validate-config

# expect exit 0 and a table showing each leaf with [default]/[env]/[file]/[cli] source
```

Sample output (truncated):

```
IMAP MCP Pro — resolved configuration
────────────────────────────────────────────────────────────

  database.path                                    = "/Users/me/.imap-mcp/data.db"  [default]
  database.skipMigrations                          = false  [default]
  encryption.masterKey                             = <redacted>  [env]
  encryption.claudeDesktopExtension                = true  [env]
  ...
  logging.level                                    = "INFO"  [env]
  user.mcpUserId                                   = "me"  [env]

Configuration valid.
```

If anything reads `[default]` when you expected `[env]` or `[file]`, the source isn't being picked up — check the env var name against the mapping table above.

### Rollback

If something goes wrong, revert to the previous version of the binary/install. The database stays at v1.7.0 in either direction (no schema changes in this release). Your accounts and encryption key are unaffected.

If you ran the .mcpb extension and want to go back to manual install:

1. Disable / uninstall the extension in Claude Desktop Settings → Extensions
2. Re-enable the previous `mcpServers.imap-mcp-pro` entry in `claude_desktop_config.json`
3. Restart Claude Desktop

---

## Earlier upgrades

For upgrades to v2.13.x and earlier, see `CHANGELOG.md`.
