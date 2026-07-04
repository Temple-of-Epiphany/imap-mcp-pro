// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// bulk-job-tools.ts — inspect/cancel persistent bulk jobs (#117).
//   imap_bulk_jobs        list jobs (status, progress)
//   imap_bulk_job_status  one job's detail (progress, ETA, last error)
//   imap_bulk_job_cancel  request cancellation (stops at next checkpoint)
//
// Job creation + resume live with the bulk tools that own the work (Phase 2).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { BulkJobService, BulkJob } from '../services/bulk-job-service.js';
import { DatabaseService } from '../services/database-service.js';
import { resolveUserOrThrow } from '../utils/user-resolver.js';

const StatusSchema = z.enum(['queued', 'running', 'paused', 'done', 'failed', 'cancelled']);

/** Shape a job for tool output with derived progress + ETA. */
function view(job: BulkJob, now: number) {
  const pct = job.totalItems && job.totalItems > 0
    ? Math.round((job.doneItems / job.totalItems) * 1000) / 10
    : null;
  const elapsedMs = job.startedAt ? (job.finishedAt ?? now) - job.startedAt : null;
  let etaMs: number | null = null;
  if (job.status === 'running' && elapsedMs && job.doneItems > 0 && job.totalItems) {
    const perItem = elapsedMs / job.doneItems;
    etaMs = Math.max(0, Math.round(perItem * (job.totalItems - job.doneItems)));
  }
  return {
    jobId: job.jobId,
    toolName: job.toolName,
    accountId: job.accountId,
    status: job.status,
    progress: { done: job.doneItems, total: job.totalItems, errors: job.errorItems, percent: pct },
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    elapsedMs,
    etaMs,
    lastError: job.lastError,
  };
}

export function bulkJobTools(server: McpServer, jobs: BulkJobService, db: DatabaseService): void {
  server.registerTool('imap_bulk_jobs', {
    description:
      'List persistent bulk-operation jobs (long-running scans) with status and progress. ' +
      'Filter by status; scope to a user. Per-job detail is available from imap_bulk_job_status.',
    inputSchema: {
      userId: z.string().optional().describe('Scope to this user (UUID or username); omit for all'),
      status: StatusSchema.optional().describe('Filter by status'),
      limit: z.number().int().positive().optional().describe('Max jobs (default 50, cap 500)'),
    },
  }, withErrorHandling(async ({ userId, status, limit }) => {
    const uid = userId ? resolveUserOrThrow(db, userId) : undefined;
    const now = Date.now();
    const list = jobs.listJobs({ userId: uid, status, limit }).map((j) => view(j, now));
    return { content: [{ type: 'text', text: JSON.stringify({ count: list.length, jobs: list }, null, 2) }] };
  }));

  server.registerTool('imap_bulk_job_status', {
    description: 'Get one bulk job\'s detail: status, done/total progress, error count, ETA, and last error.',
    inputSchema: { jobId: z.string().describe('Job ID returned by a *_start tool') },
  }, withErrorHandling(async ({ jobId }) => {
    const job = jobs.getJob(jobId);
    if (!job) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_not_found', jobId }, null, 2) }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(view(job, Date.now()), null, 2) }] };
  }));

  server.registerTool('imap_bulk_job_cancel', {
    description:
      'Request cancellation of a running/queued bulk job. The worker stops at its next checkpoint ' +
      '(no half-applied state); already-processed items are kept so the job can be resumed later.',
    inputSchema: { jobId: z.string().describe('Job ID to cancel') },
  }, withErrorHandling(async ({ jobId }) => {
    const changed = jobs.cancel(jobId);
    const job = jobs.getJob(jobId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          jobId,
          cancelled: changed,
          status: job?.status ?? 'unknown',
          note: changed
            ? 'Cancellation requested; the worker will stop at its next checkpoint.'
            : (job ? `Job is already ${job.status}; nothing to cancel.` : 'Job not found.'),
        }, null, 2),
      }],
    };
  }));
}
