#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ImapService } from './services/imap-service.js';
import { DatabaseService } from './services/database-service.js';
import { SmtpService } from './services/smtp-service.js';
import { FileExportService } from './services/file-export-service.js';
import { ResultsService } from './services/results-service.js';
import { SentFolderService } from './services/sent-folder-service.js';
import { AppendRetryService } from './services/append-retry-service.js';
import { AttachmentStagingService, DEFAULT_STAGING_CONFIG } from './services/attachment-staging-service.js';
import os from 'os';
import { WorkerPool } from './utils/worker-pool.js';
import { registerTools } from './tools/index.js';
import { dispatchCli, EXIT_CODES } from './config/cli.js';
import { loadConfig, ConfigError } from './config/loader.js';
import { logEvent, timeStage, SERVER_CAPABILITIES } from './startup.js';

// Silence any package version output to stdout
const originalWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as any) = function(chunk: any, encoding?: any, callback?: any): boolean {
  // Only allow JSON-RPC messages through
  if (typeof chunk === 'string' && (chunk.startsWith('{') || chunk === '\n')) {
    return originalWrite(chunk, encoding, callback);
  }
  return true;
};

dotenv.config();

// Short-circuit CLI flags (--print-config-schema, --validate-config,
// --print-tools-manifest). Each handler exits the process; if none matched,
// dispatchCli returns true and we continue with normal startup.
await dispatchCli({
  printToolsManifestHandler: async () => buildToolsManifest(),
}).catch((e: unknown) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
  throw e;
});

// ============================================================================
// Pre-handshake stage — must complete in < 2s on cold start.
// ============================================================================

const {
  server, imapService, smtpService, db, fileExport, results, workerPool,
  sentFolderService, appendRetryService, attachmentStaging,
} = await timeStage('pre-handshake', async () => {
    // 1. Load + validate config
    let config;
    try {
      config = loadConfig().config;
    } catch (e) {
      if (e instanceof ConfigError) {
        process.stderr.write(`${e.message}\n`);
        process.exit(EXIT_CODES.CONFIG_ERROR);
      }
      throw e;
    }

    // 2. Construct McpServer with explicit capabilities (closes #80)
    const server = new McpServer(
      { name: 'imap-mcp-pro', version: '2.15.0' },
      { capabilities: SERVER_CAPABILITIES }
    );

    // 3. Database (auto-migrations run here; ledger v1.7.0 in usual case)
    let db: DatabaseService;
    try {
      db = new DatabaseService();
    } catch (e: any) {
      logEvent('[startup]', { stage: 'pre-handshake', outcome: 'error', component: 'DatabaseService', error: e?.message });
      process.exit(EXIT_CODES.DATABASE_ERROR);
    }

    // 4. Downstream services
    const fileExport = new FileExportService(db);
    const results = new ResultsService(db, fileExport);

    // 5. Worker pool (spawns threads — usually fast)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const workerScriptPath = path.join(__dirname, 'workers', 'email-parser-worker.js');
    const workerScriptUrl = pathToFileURL(workerScriptPath);
    const workerPool = new WorkerPool({ workerScript: workerScriptUrl });

    // 6. IMAP/SMTP services (no I/O at construction time)
    const imapService = new ImapService(db);
    imapService.setWorkerPool(workerPool);
    const smtpService = new SmtpService();

    // 6b. WP4: Sent folder resolution + APPEND retry queue
    const sentFolderService = new SentFolderService(db, imapService);
    const appendRetryService = new AppendRetryService(db, imapService);

    // 6c. WP2: attachment staging (chunked uploads)
    const stagingDir = process.env.IMAP_MCP_ATTACHMENT_STAGING_DIR
      ?? path.join(os.homedir(), '.imap-mcp', 'staging');
    const attachmentStaging = new AttachmentStagingService(db, {
      ...DEFAULT_STAGING_CONFIG,
      stagingDir,
      perUserMaxBytes: Number(process.env.IMAP_MCP_MAX_STAGING_BYTES_PER_USER ?? 500 * 1024 * 1024),
    });

    // 7. Tool schema registration
    registerTools(
      server, imapService, db, smtpService, results, workerPool,
      sentFolderService, appendRetryService, attachmentStaging
    );

    // Mark unused config field as intentional for now
    void config;

    return {
      server, imapService, smtpService, db, fileExport, results, workerPool,
      sentFolderService, appendRetryService, attachmentStaging,
    };
  });

// ============================================================================
// Handshake stage — SDK handles initialize/initialized exchange.
// ============================================================================

await timeStage('handshake', async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
});

// ============================================================================
// Post-handshake stage — detached, doesn't block tool invocation.
// ============================================================================

void timeStage('post-handshake', async () => {
  // Orphan-file sweep — opportunistic, log on cleanup
  try {
    const n = await fileExport.sweepOrphans(results.knownResultPaths());
    if (n > 0) logEvent('[startup]', { component: 'orphan-sweep', cleaned: n });
  } catch (e: any) {
    logEvent('[startup]', { component: 'orphan-sweep', outcome: 'error', error: e?.message });
  }

  // WP4: start the APPEND retry timer (5-min interval, unref'd)
  try {
    appendRetryService.start();
    logEvent('[startup]', { component: 'append-retry', msg: 'retry timer started' });
  } catch (e: any) {
    logEvent('[startup]', { component: 'append-retry', outcome: 'error', error: e?.message });
  }

  // WP2: start the staging GC timer (15-min interval, unref'd)
  try {
    attachmentStaging.start();
    logEvent('[startup]', { component: 'staging-gc', msg: 'GC timer started' });
  } catch (e: any) {
    logEvent('[startup]', { component: 'staging-gc', outcome: 'error', error: e?.message });
  }
});

logEvent('[startup]', { msg: 'IMAP MCP Server ready' });

// ============================================================================
// Tool manifest emitter — used by Phase 4 .mcpb build pipeline.
// Returns the tool catalog without starting the transport.
// ============================================================================

async function buildToolsManifest(): Promise<unknown> {
  // Lazily import zod-to-json-schema to avoid pulling it into hot startup.
  const { zodToJsonSchema } = await import('zod-to-json-schema');

  // Construct the same server object but never call server.connect().
  const tmpServer = new McpServer(
    { name: 'imap-mcp-pro', version: '2.15.0' },
    { capabilities: SERVER_CAPABILITIES }
  );
  const tmpDb = new DatabaseService();
  const tmpFileExport = new FileExportService(tmpDb);
  const tmpResults = new ResultsService(tmpDb, tmpFileExport);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const workerScriptPath = path.join(__dirname, 'workers', 'email-parser-worker.js');
  const workerScriptUrl = pathToFileURL(workerScriptPath);
  const tmpWorkerPool = new WorkerPool({ workerScript: workerScriptUrl });
  const tmpImap = new ImapService(tmpDb);
  tmpImap.setWorkerPool(tmpWorkerPool);
  const tmpSmtp = new SmtpService();
  const tmpSentFolder = new SentFolderService(tmpDb, tmpImap);
  const tmpAppendRetry = new AppendRetryService(tmpDb, tmpImap);
  const tmpStaging = new AttachmentStagingService(tmpDb, {
    ...DEFAULT_STAGING_CONFIG,
    stagingDir: path.join(os.homedir(), '.imap-mcp', 'staging'),
  });
  registerTools(
    tmpServer, tmpImap, tmpDb, tmpSmtp, tmpResults, tmpWorkerPool,
    tmpSentFolder, tmpAppendRetry, tmpStaging
  );

  // Pull the registered tools out of McpServer's internal map. This is
  // accessing private SDK state (versioned at @1.22.0); regenerate if the
  // shape changes in a future SDK upgrade.
  const internal = (tmpServer as any)._registeredTools as Record<string, any> | undefined;
  const tools: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }> = [];

  if (internal) {
    for (const [name, t] of Object.entries(internal)) {
      // Each registered tool's inputSchema is a Zod object whose shape is the
      // map of field-name -> Zod type. Reconstruct as a single z.object() and
      // convert to JSON Schema.
      let inputSchemaJson: unknown = { type: 'object', properties: {}, additionalProperties: false };
      try {
        const shape = t?.inputSchema?.shape;
        if (shape) {
          const { z } = await import('zod');
          const wrapped = z.object(shape);
          inputSchemaJson = (zodToJsonSchema as any)(wrapped, { $refStrategy: 'none' });
        } else if (t?.inputSchema) {
          inputSchemaJson = (zodToJsonSchema as any)(t.inputSchema, { $refStrategy: 'none' });
        }
      } catch (e: any) {
        inputSchemaJson = { type: 'object', _conversion_error: e?.message };
      }

      tools.push({
        name,
        description: t?.description ?? undefined,
        inputSchema: inputSchemaJson,
      });
    }
  }

  // Cleanup background timers/threads we created just for this listing.
  try { tmpResults.destroy(); } catch {}
  try { await tmpWorkerPool.destroy(); } catch {}
  try { tmpFileExport.destroy(); } catch {}

  return { tools };
}

// ============================================================================
// Graceful shutdown
// ============================================================================

async function shutdown(signal: string) {
  logEvent('[shutdown]', { signal, msg: 'cleaning up' });
  try { attachmentStaging.stop(); } catch (e: any) { logEvent('[shutdown]', { component: 'staging.stop', error: e?.message }); }
  try { appendRetryService.stop(); } catch (e: any) { logEvent('[shutdown]', { component: 'appendRetry.stop', error: e?.message }); }
  try { results.destroy(); } catch (e: any) { logEvent('[shutdown]', { component: 'results.destroy', error: e?.message }); }
  try { await workerPool.destroy(); } catch (e: any) { logEvent('[shutdown]', { component: 'workerPool.destroy', error: e?.message }); }
  try { fileExport.destroy(); } catch (e: any) { logEvent('[shutdown]', { component: 'fileExport.destroy', error: e?.message }); }
  process.exit(EXIT_CODES.OK);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// keep refs alive
void imapService; void smtpService; void db; void sentFolderService;
