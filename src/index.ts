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
import { WorkerPool } from './utils/worker-pool.js';
import { registerTools } from './tools/index.js';
import { dispatchCli, EXIT_CODES } from './config/cli.js';
import { loadConfig, ConfigError } from './config/loader.js';

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

// Short-circuit CLI flags (--print-config-schema, --validate-config). Each
// handler exits the process; if none matched, dispatchCli returns true.
await dispatchCli({}).catch((e: unknown) => {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
  throw e;
});

// Load and validate config for normal startup. Phase 3 will wire this
// through to the services; Phase 2 ensures misconfiguration fails fast.
try {
  loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT_CODES.CONFIG_ERROR);
  }
  throw e;
}

const server = new McpServer({
  name: 'imap-mcp-pro',
  version: '2.13.1',
});

const db = new DatabaseService();
const fileExport = new FileExportService(db);
const results = new ResultsService(db, fileExport);

// Worker script lives next to this file; in dev (tsx) it's the .ts source,
// in prod it's the compiled .js under dist/workers/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerScriptPath = path.join(__dirname, 'workers', 'email-parser-worker.js');
const workerScriptUrl = pathToFileURL(workerScriptPath);
const workerPool = new WorkerPool({ workerScript: workerScriptUrl });

const imapService = new ImapService(db); // Pass db for auto-capability storage (Issue #58)
imapService.setWorkerPool(workerPool); // Phase D: offload simpleParser to worker threads
const smtpService = new SmtpService();

// Register all tools (results service + worker pool now available)
registerTools(server, imapService, db, smtpService, results, workerPool);

// Startup orphan-file sweep
fileExport.sweepOrphans(results.knownResultPaths())
  .then(n => { if (n > 0) console.error(`[startup] Cleaned up ${n} orphan result dir(s)`); })
  .catch(e => console.error('[startup] orphan sweep failed:', e));

// Graceful shutdown
async function shutdown(signal: string) {
  console.error(`[shutdown] received ${signal}, cleaning up...`);
  try { results.destroy(); } catch (e) { console.error('[shutdown] results.destroy:', e); }
  try { await workerPool.destroy(); } catch (e) { console.error('[shutdown] workerPool.destroy:', e); }
  try { fileExport.destroy(); } catch (e) { console.error('[shutdown] fileExport.destroy:', e); }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IMAP MCP Server started');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
