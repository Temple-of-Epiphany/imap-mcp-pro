import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ImapService } from '../services/imap-service.js';
import { DatabaseService } from '../services/database-service.js';
import { SmtpService } from '../services/smtp-service.js';
import { ResultsService } from '../services/results-service.js';
import { WorkerPool } from '../utils/worker-pool.js';
import { SentFolderService } from '../services/sent-folder-service.js';
import { AppendRetryService } from '../services/append-retry-service.js';
import { AttachmentStagingService } from '../services/attachment-staging-service.js';
import { MessageCacheService } from '../services/message-cache-service.js';
import { SkillsInstallerService } from '../services/skills-installer-service.js';
import { accountTools } from './account-tools.js';
import { emailTools } from './email-tools.js';
import { folderTools } from './folder-tools.js';
import { metaTools } from './meta-tools.js';
import { userTools } from './user-tools.js';
import { userCheckTools } from './usercheck-tools.js';
import { registerScoringTools } from './scoring-tools.js';
import { registerSubscriptionTools } from './subscription-tools.js';
import { capabilityTools } from './capability-tools.js';
import { dnsFirewallTools } from './dns-firewall-tools.js';
import { categoryTools } from './category-tools.js';
import { resultTools } from './result-tools.js';
import { cacheTools } from './cache-tools.js';
import { skillsTools } from './skills-tools.js';
import { getAnnotations } from './annotations.js';

/**
 * Wrap server.registerTool so every call gets MCP annotations injected
 * from our central table. Drives Claude Desktop's "Tool permissions" UI
 * (Read-only / Write-delete groups). Restored on every registerTools()
 * invocation so we don't leak the wrapper across re-registrations.
 *
 * Caller-supplied annotations (if any) win on a per-key basis — the
 * central table only fills in keys the call site didn't already set.
 */
function withAnnotations<T extends McpServer>(server: T): () => void {
  const original = (server as any).registerTool.bind(server);
  (server as any).registerTool = (name: string, config: any, handler: any) => {
    const merged = {
      ...config,
      annotations: { ...getAnnotations(name), ...(config?.annotations ?? {}) },
    };
    return original(name, merged, handler);
  };
  return () => { (server as any).registerTool = original; };
}

export function registerTools(
  server: McpServer,
  imapService: ImapService,
  db: DatabaseService,
  smtpService: SmtpService,
  results?: ResultsService,
  workerPool?: WorkerPool,
  sentFolder?: SentFolderService,
  appendRetry?: AppendRetryService,
  staging?: AttachmentStagingService,
  messageCache?: MessageCacheService,
  skillsInstaller?: SkillsInstallerService
): void {
  // Inject MCP annotations on every registerTool call (drives Claude
  // Desktop's Tool Permissions UI). Restored after the registration phase
  // so re-entrant calls (e.g. from buildToolsManifest) start fresh.
  const restoreRegisterTool = withAnnotations(server);

  // Register user & database management tools (v2.6.0 - SQLite3 integration)
  userTools(server, db);

  // Register account management tools (legacy - to be deprecated)
  accountTools(server, db, imapService);

  // Register email operation tools (Phase C: pass results + workerPool when wired;
  // WP4: sentFolder + appendRetry for Sent-folder placement)
  emailTools(server, imapService, db, smtpService, results, workerPool, sentFolder, appendRetry, staging);

  // Register folder operation tools
  folderTools(server, imapService, db);

  // Register category tools (Issue #71 - Quick Categories)
  categoryTools(server, imapService, db);

  // Register capability tools (Issue #55 - RFC 9051 compliance)
  capabilityTools(server, imapService, db);

  // Register DNS Firewall tools (Issue #59)
  dnsFirewallTools(server, imapService, db);

  // Register UserCheck SPAM detection tools (Issues #3, #17, #18)
  userCheckTools(server, db, imapService);

  // Register confidence scoring tools (Issue #42)
  registerScoringTools(server, imapService);

  // Register subscription management tools (Issue #45 Phase 4, Issue #47)
  registerSubscriptionTools(server, imapService, db, smtpService);

  // Register consolidated imap_results tool (resource-handle pattern)
  if (results) {
    resultTools(server, db, results);
  }

  // Register v2.17.0 MVP cache tools (Issue #124)
  if (messageCache) {
    cacheTools(server, messageCache);
  }

  // Register v2.17.4 skill update tools (#138). Skips registration when no
  // installer is wired (e.g. tests or environments without bundled skills).
  if (skillsInstaller) {
    skillsTools(server, skillsInstaller);
  }

  // Register meta/discovery tools
  metaTools(server);

  restoreRegisterTool();
}
