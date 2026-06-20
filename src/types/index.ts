// SPDX-License-Identifier: LicenseRef-ImapMcpPro-Dual
//
// Shared type definitions for IMAP MCP Pro.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)
//
// Connection/account/message shapes plus the reliability-layer (circuit
// breaker, operation queue, metrics, degradation) and RFC 9051 capability
// and status types. Database row types are re-exported from ./database-types.

export * from './database-types.js';

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle phase of a pooled IMAP connection. */
export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR'
}

/** Tunables for keeping an idle connection alive. */
export interface KeepAliveConfig {
  interval?: number;      // TCP keepalive probe interval, ms (default 10000)
  idleInterval?: number;  // Re-issue IMAP IDLE after this many ms (default 1740000 / 29 min)
  forceNoop?: boolean;    // Prefer periodic NOOP over IDLE (default true)
}

/** Exponential-backoff retry policy. */
export interface RetryConfig {
  maxAttempts?: number;      // Give up after this many tries (default 5)
  initialDelay?: number;     // First backoff delay, ms (default 1000)
  maxDelay?: number;         // Upper bound on backoff, ms (default 60000)
  backoffMultiplier?: number; // Growth factor between attempts (default 2)
}

/** Runtime bookkeeping the pool keeps for each connection. */
export interface ConnectionMetadata {
  state: ConnectionState;
  lastConnected?: Date;
  lastError?: Error;
  reconnectAttempts: number;
  healthCheckInterval?: NodeJS.Timeout;
  // Reliability layer (see sections below)
  circuitBreaker?: CircuitBreakerState;
  metrics?: ConnectionMetrics;
  degradationStartTime?: Date;
  cacheData?: Map<string, { data: any; timestamp: Date }>;
}

// ---------------------------------------------------------------------------
// Accounts and transport
// ---------------------------------------------------------------------------

/** A configured IMAP account plus optional SMTP and reliability settings. */
export interface ImapAccount {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
  authTimeout?: number;
  connTimeout?: number;
  keepalive?: boolean | KeepAliveConfig;
  retry?: RetryConfig;
  smtp?: SmtpConfig;
  circuitBreaker?: CircuitBreakerConfig;
  operationQueue?: OperationQueueConfig;
  degradation?: DegradationConfig;
}

/** Outgoing-mail (SMTP) settings for an account. */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  authMethod?: 'PLAIN' | 'LOGIN' | 'CRAM-MD5' | 'XOAUTH2';
  tls?: {
    rejectUnauthorized?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Messages, folders, search
// ---------------------------------------------------------------------------

/** Header-level summary of a single message. */
export interface EmailMessage {
  uid: number;
  date: Date;
  from: string;
  to: string[];
  subject: string;
  messageId: string;
  inReplyTo?: string;
  flags: string[];
}

/** A message with its decoded body and attachments. */
export interface EmailContent extends EmailMessage {
  textContent?: string;
  htmlContent?: string;
  attachments: Attachment[];
}

/** Metadata for an attachment found on a fetched message. */
export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
}

/** A mailbox/folder node, optionally with nested children. */
export interface Folder {
  name: string;
  delimiter: string;
  attributes: string[];
  children?: Folder[];
}

/** Filters that translate into an IMAP SEARCH. */
export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: Date;
  before?: Date;
  seen?: boolean;
  unreadOnly?: boolean;  // Issue #82: convenience flag, equivalent to seen: false
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
}

/** Map of accountId -> live IMAP connection instance. */
export interface ConnectionPool {
  [accountId: string]: any;
}

// ---------------------------------------------------------------------------
// Composing / sending
// ---------------------------------------------------------------------------

/** Fields used to compose an outgoing message. */
export interface EmailComposer {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
  replyTo?: string;
  inReplyTo?: string;
  references?: string | string[];
}

/** An attachment to include on an outgoing message. */
export interface EmailAttachment {
  filename: string;
  content?: string | Buffer;
  path?: string;
  contentType?: string;
  contentDisposition?: 'attachment' | 'inline';
  cid?: string;
}

// ---------------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------------

/** Flag mutations supported by the bulk-mark tools. */
export type BulkMarkOperation =
  | 'read' | 'unread'           // \Seen
  | 'flagged' | 'unflagged'     // \Flagged
  | 'answered' | 'unanswered'   // \Answered (RFC 9051)
  | 'draft' | 'not-draft'       // \Draft (RFC 9051)
  | 'deleted' | 'undeleted';    // \Deleted

/** Recommended IMAP keywords from RFC 9051 (Issue #54). */
export type ImapKeyword =
  | '$Forwarded'   // forwarded
  | '$MDNSent'     // disposition notification sent
  | '$Junk'        // spam
  | '$NotJunk'     // user-confirmed not spam
  | '$Phishing';   // phishing attempt

/** How much of each message a bulk fetch should retrieve. */
export type BulkFetchFields = 'headers' | 'full' | 'body';

/** Outcome summary returned by bulk operations. */
export interface BulkOperationResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  errors?: Array<{ uid: number; error: string }>;
}

// ---------------------------------------------------------------------------
// Reliability: circuit breaker
// ---------------------------------------------------------------------------

/** Circuit-breaker states. */
export enum CircuitState {
  CLOSED = 'CLOSED',      // healthy, requests pass through
  OPEN = 'OPEN',          // tripped, requests rejected fast
  HALF_OPEN = 'HALF_OPEN' // probing for recovery
}

/** Circuit-breaker thresholds and timing. */
export interface CircuitBreakerConfig {
  failureThreshold?: number;     // failures that trip the breaker (default 5)
  successThreshold?: number;     // successes to close from half-open (default 2)
  timeout?: number;              // wait before probing half-open, ms (default 60000)
  monitoringWindow?: number;     // rolling failure window, ms (default 120000)
}

/** Live circuit-breaker state for a connection. */
export interface CircuitBreakerState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime?: Date;
  lastFailureReason?: string;
  lastStateChange: Date;
  config: Required<CircuitBreakerConfig>;
}

// ---------------------------------------------------------------------------
// Reliability: operation queue
// ---------------------------------------------------------------------------

/** A single queued operation awaiting (re)execution. */
export interface QueuedOperation {
  id: string;
  accountId: string;
  operation: string;
  args: any[];
  timestamp: Date;
  retries: number;
  priority: number;
}

/** Bounds and cadence for the offline operation queue. */
export interface OperationQueueConfig {
  maxSize?: number;           // cap on pending operations (default 1000)
  maxRetries?: number;        // per-operation retry limit (default 3)
  processingInterval?: number; // drain interval, ms (default 5000)
  enablePriority?: boolean;   // honor per-operation priority (default true)
}

// ---------------------------------------------------------------------------
// Reliability: metrics
// ---------------------------------------------------------------------------

/** Aggregate counters for a connection. */
export interface ConnectionMetrics {
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  averageLatency: number;
  lastOperationTime: Date;
  uptime: number;
}

/** Per-operation latency/throughput counters. */
export interface OperationMetrics {
  operationName: string;
  count: number;
  successCount: number;
  failureCount: number;
  totalLatency: number;
  averageLatency: number;
  minLatency: number;
  maxLatency: number;
  lastExecuted?: Date;
}

// ---------------------------------------------------------------------------
// Reliability: graceful degradation
// ---------------------------------------------------------------------------

/** Behavior while the server is degraded/unreachable. */
export interface DegradationConfig {
  enableReadOnlyMode?: boolean;     // serve reads when writes fail (default true)
  enableCaching?: boolean;          // cache read results (default true)
  cacheTimeout?: number;            // cached-data TTL, ms (default 300000 / 5 min)
  fallbackToLastKnown?: boolean;    // fall back to last good data (default true)
  maxDegradationTime?: number;      // cap on degraded operation, ms (default 3600000 / 1 hr)
}

// ---------------------------------------------------------------------------
// RFC 9051: capabilities and status
// ---------------------------------------------------------------------------

/** Parsed server CAPABILITY response (Issue #55). */
export interface ServerCapabilities {
  raw: string[];              // verbatim capability tokens
  imap4rev2: boolean;         // advertises IMAP4rev2
  imap4rev1: boolean;         // advertises IMAP4rev1 (fallback)
  authMethods: string[];      // AUTH= mechanisms, e.g. PLAIN / LOGIN / XOAUTH2
  extensions: {
    // IMAP4rev2 built-ins (expected true on compliant servers)
    namespace?: boolean;
    unselect?: boolean;
    uidplus?: boolean;
    esearch?: boolean;
    searchres?: boolean;
    enable?: boolean;
    idle?: boolean;
    saslir?: boolean;
    listExtended?: boolean;
    listStatus?: boolean;
    move?: boolean;
    literalMinus?: boolean;
    binary?: boolean;
    specialUse?: boolean;
    statusSize?: boolean;
    statusDeleted?: boolean;

    // Frequently-seen optional extensions
    quota?: boolean;
    sort?: boolean;
    thread?: boolean;
    condstore?: boolean;
    qresync?: boolean;
    compress?: boolean;
    notify?: boolean;
    metadata?: boolean;

    // Catch-all for anything else the server advertises
    [key: string]: boolean | undefined;
  };
}

/** Result of a mailbox STATUS query (Issue #56). */
export interface MailboxStatus {
  mailbox: string;
  messages: number;          // MESSAGES — total count
  recent?: number;           // RECENT — legacy in IMAP4rev2, still reported
  uidNext: number;           // UIDNEXT — next UID the server will assign
  uidValidity: bigint;       // UIDVALIDITY — mailbox UID epoch
  unseen: number;            // UNSEEN — count of unseen messages
  deleted?: number;          // DELETED — \Deleted count (STATUS=DELETED)
  size?: number;             // SIZE — mailbox size in bytes (STATUS=SIZE)
}

// ---------------------------------------------------------------------------
// DNS firewall (Issue #60)
// ---------------------------------------------------------------------------

/** Lookup transport a DNS-firewall provider uses. */
export type DnsFirewallProviderType = 'dns-over-https' | 'dns-lookup';

/** A configured DNS-firewall provider. */
export interface DnsFirewallProvider {
  providerId: string;
  providerName: string;
  providerType: DnsFirewallProviderType;
  apiEndpoint?: string;      // endpoint for DoH providers
  apiKey?: string;           // optional key for future paid services
  isEnabled: boolean;
  isDefault: boolean;
  timeoutMs: number;
  createdAt: number;
  updatedAt: number;
  metadata?: string;         // provider-specific config as JSON
}
