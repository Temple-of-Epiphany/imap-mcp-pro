# IMAP MCP Pro — Architecture

**Version:** 1.0.0
**Author:** Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
**Date Created:** 2026-04-29
**Date Updated:** 2026-04-29

Audience: contributors. Provides a map of the codebase, the startup sequence, the response-shape policy, and how to add new tools.

---

## High-level layout

```
src/
├── index.ts                      # Server entry point — orchestrates startup
├── startup.ts                    # Three-stage timing + structured logging
├── config/
│   ├── server-config.ts          # Zod schema (32 fields, 8 groups)
│   ├── loader.ts                 # Multi-source loader (CLI > env > file > defaults)
│   ├── cli.ts                    # --print-config-schema, --validate-config dispatcher
│   └── context-reduction.ts      # Legacy env-var readers (still used; refactor pending)
├── services/
│   ├── database-service.ts       # SQLite (better-sqlite3), AES-256-GCM encryption,
│   │                              #   auto-migration on construct
│   ├── migration-service.ts      # Schema_version ledger + migration runner
│   ├── imap-service.ts           # ImapFlow connection pool, search/fetch/store/move
│   ├── smtp-service.ts           # nodemailer-based send
│   ├── results-service.ts        # Tool-result cache (handle/file modes), LRU eviction
│   ├── file-export-service.ts    # Encrypted JSON/JSONL writer for file-mode results
│   └── encryption/               # Key storage paths (keyring vs file)
├── tools/                        # 81 MCP tools across 12 files
│   ├── account-tools.ts          # 8  add/remove/list/share accounts
│   ├── email-tools.ts            # 22 search/get/mark/delete/move/copy/send/bulk
│   ├── folder-tools.ts           # 6  list/status/create/delete/rename
│   ├── meta-tools.ts             # 7  about/list-tools/connect/disconnect/metrics
│   ├── capability-tools.ts       # 1  imap_get_capabilities
│   ├── category-tools.ts         # 5  categorize/keywords/confidence
│   ├── result-tools.ts           # 1  imap_results (action: get/list/delete/persist)
│   ├── scoring-tools.ts          # 2  score-confidence
│   ├── subscription-tools.ts     # 10 subscription / unsubscribe
│   ├── user-tools.ts             # 3  create/get/list users (multi-tenant)
│   ├── usercheck-tools.ts        # 7  spam-sender detection
│   ├── dns-firewall-tools.ts     # 5  outbound link safety
│   ├── result-envelope.ts        # maybeStoreAsHandle() — three-tier policy
│   └── tool-context.ts           # User-context injection wrapper
├── utils/
│   └── worker-pool.ts            # Worker thread pool (parsing/summarization)
├── workers/
│   └── email-parser-worker.ts    # simpleParser + row summarization
└── database/
    ├── schema.sql                # Base schema
    ├── schema_update_*.sql       # Per-version migrations (1.0.0 through 1.7.0)
    └── migrations-manifest.json  # Ledger
dxt/                              # Claude Desktop Extension packaging
├── manifest.template.json
├── icon.png
└── build.mjs                     # Build script (8 steps)
```

---

## Startup — three stages

Designed to keep pre-handshake work under 2 seconds so Claude Desktop's `initialize` timeout never trips. Implemented in `src/startup.ts` and orchestrated from `src/index.ts`.

```
┌─────────────────────────────────────────────────────────────────┐
│ Pre-handshake  (target < 2s)                                    │
│  - Load + validate config (loadConfig)                          │
│  - Construct DatabaseService (auto-runs pending migrations)     │
│  - Construct downstream services                                │
│  - Register all 81 tool schemas with the SDK                    │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Handshake                                                        │
│  - server.connect(transport)                                     │
│  - SDK exchanges initialize/initialized with the client          │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Post-handshake (detached, doesn't block tool invocation)        │
│  - Orphan-file sweep                                             │
│  - Future: cache warm-up, health checks                          │
└─────────────────────────────────────────────────────────────────┘
```

`timeStage()` wraps each stage and logs `outcome=ok|error` plus `duration_ms`. Pre-handshake exceeding 2s emits a `outcome=warning` line.

### Documented exit codes

`src/config/cli.ts` exports `EXIT_CODES`:

| Code | Meaning | Where it fires |
|---|---|---|
| 0 | OK | Normal exit |
| 1 | CONFIG_ERROR | Schema validation failed; bad enum/path/etc. |
| 2 | DATABASE_ERROR | DatabaseService construction failed |
| 3 | DEPENDENCY_ERROR | Missing prerequisite (e.g., printToolsManifest handler not wired) |
| 4 | PERMISSION_ERROR | Filesystem permission failure (validatePaths) |

---

## Configuration precedence

`src/config/loader.ts` resolves config from four sources, highest precedence first:

```
CLI args   (--log-level, --database-path, --mcp-user-id)
   │
   ▼
Env vars   (IMAP_MCP_*, MCP_USER_ID, CLAUDE_DESKTOP_EXTENSION)
   │
   ▼
Config file  (--config <path> or IMAP_MCP_CONFIG_PATH; YAML/TOML/JSON)
   │
   ▼
Schema defaults  (in src/config/server-config.ts)
```

`loadConfig()` returns a `ResolvedConfig` with provenance info per leaf — `--validate-config` prints this for debugging.

`ENV_VAR_MAPPING` in `server-config.ts` is the canonical backward-compat list — every legacy `IMAP_MCP_*` env var maps to a `ServerConfig` dotted path.

---

## Tool registration flow

```
src/index.ts
  registerTools(server, imap, db, smtp, results, workerPool)
                  │
                  ▼
       src/tools/index.ts dispatches to per-domain registrants
                  │
                  ▼
       e.g. src/tools/email-tools.ts:
           server.registerTool(name, { description, inputSchema }, handler)
                  │
                  ▼
       handler is wrapped in withErrorHandling (uniform error shape)
       and may be wrapped in withUserAuthorization (user-context injection)
```

Every tool name is `imap_<snake_case>`, all 81 are SEP-986 compliant.

---

## Response shape — three-tier handle policy

Implemented in `src/tools/result-envelope.ts:maybeStoreAsHandle()`. Decides per call whether to:

1. **Inline** — return rows directly in the MCP response (safe ≤ ~20 rows or ≤ 256 KB JSON)
2. **Handle** — store rows in `tool_results` table (encrypted with AES-256-GCM), return a `resultId` envelope with `firstN` preview + facets; client pages via `imap_results action='get'`
3. **File** — store rows as encrypted JSON/JSONL in `~/.imap-mcp/results/<userId>/<resultId>/`, otherwise same envelope shape as handle

Decision tree (auto mode, default):

```
n > FILE_THRESHOLD (500)?            → file
n > INLINE_THRESHOLD (20)?           → handle
JSON size > INLINE_BYTE_BUDGET (256K)?
  → if 4×: file
  → if 1×: handle
otherwise                            → inline
```

Explicit `responseMode='inline'|'handle'|'file'` overrides the auto decision. Tool authors call `maybeStoreAsHandle({...})` from their handler — see `src/tools/email-tools.ts` `imap_search_emails` for the canonical example.

---

## Worker pool offload

`src/utils/worker-pool.ts` runs CPU-bound work off the main event loop:

- `simpleParser` for full-body email parsing (`bulkGetEmails(fields='full')`)
- Row summarization for batches ≥ 1000 rows

Pool size defaults to `min(4, max(2, cpus-1))`. Per-task timeout is 30s.

If the pool fails (worker error, timeout), the calling code falls back to inline execution. Look for `[ImapService] worker parse failed` in logs.

---

## Migration system

`src/services/migration-service.ts` runs migrations in order from `src/database/migrations-manifest.json`. Schema version is tracked in the `schema_version` table.

Auto-migration runs on `new DatabaseService()`. Bypass via `IMAP_MCP_SKIP_MIGRATIONS=1` env (used by the migrate CLI).

CLI: `npm run migrate:status`, `npm run migrate`, `npm run migrate:dry-run`, `npm run migrate:rollback`.

To add a new schema version:

1. Create `src/database/schema_update_X.Y.Z_TO_X.Y+1.0.sql` (and optionally a `.down.sql` rollback)
2. Add the entry to `src/database/migrations-manifest.json`
3. Bump the `schemaVersion` field in the manifest
4. Test with `npm run migrate:dry-run` then `npm run migrate`

---

## How to add a new tool

1. Pick or create a tools file under `src/tools/` (group by domain)
2. Register the tool:
   ```typescript
   server.registerTool(
     'imap_my_new_tool',
     {
       description: 'One-line description; mention any new params.',
       inputSchema: {
         accountId: z.string().describe('Account ID'),
         // ... other params
       },
     },
     withErrorHandling(async ({ accountId, /* params */ }) => {
       // 1. Call into a service method
       const data = await imapService.myMethod(accountId, /* args */);
       // 2. If returning a list of rows, run through maybeStoreAsHandle
       // 3. Otherwise return { content: [{ type: 'text', text: JSON.stringify(...) }] }
       return { content: [{ type: 'text', text: JSON.stringify({ data }, null, 2) }] };
     })
   );
   ```
3. If the tool reads or modifies user-scoped state, add `withUserAuthorization`
4. Run `npm run build` then `node dist/index.js --print-tools-manifest | jq '.tools[] | select(.name == "imap_my_new_tool")'` to confirm the schema converts correctly
5. Add a worked example to `EXAMPLES.md`
6. If the tool returns lists, default to `responseMode='auto'` and let the envelope helper decide

---

## Claude Desktop Extension (.mcpb)

`dxt/build.mjs` produces a `.mcpb` archive that bundles:

- `manifest.json` (template merged with version + tools)
- `icon.png` (256×256)
- `server/dist/` (compiled JS)
- `server/node_modules/` (pruned of devDependencies)
- `server/package.json`, `package-lock.json`

The `manifest.json` `user_config` field renders as a Claude Desktop settings panel; values flow into `server.mcp_config.env` to become `IMAP_MCP_*` env vars at runtime, where the existing config loader picks them up.

`better-sqlite3` ships native bindings — the build script runs `npm rebuild better-sqlite3` after staging to ensure the bindings match the target platform.

---

## Logging

Structured stderr lines from `src/startup.ts:logEvent()`:

```
2026-04-29T19:42:11.123Z [startup] stage=pre-handshake outcome=ok duration_ms=12
```

Format: `{ISO timestamp} {component} key=value key=value ...`

Claude Desktop captures stderr to per-server log files:

| Platform | Path |
|---|---|
| macOS | `~/Library/Logs/Claude/mcp-server-imap-mcp-pro.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-imap-mcp-pro.log` |
| Linux | `~/.local/state/Claude/logs/mcp-server-imap-mcp-pro.log` |

---

## References

- MCP spec: https://modelcontextprotocol.io/specification
- Node SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Desktop Extension spec: https://github.com/anthropics/dxt
- IMAP4rev2: RFC 9051 (full text in `rfc/rfc9051.txt`)
- SDK alignment audit: `docs/sdk_audit_2026-04-29.md`
