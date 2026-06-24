// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// bulk-runners.ts — wires specific bulk tools to the BulkJobService (#117).
//
// Each runner knows how to (a) derive its work items from the persisted job
// params and (b) process one item. Both the start tools and imap_bulk_job_resume
// use this registry, so resume is tool-agnostic: re-derive items from params,
// then runJob() skips everything already processed.
//
// Execution: a job is started and run with a time budget (sync shim). If it
// finishes within the budget the caller gets the full summary; otherwise it gets
// a job_id envelope and the run continues in the background (this process stays
// alive as the long-lived MCP server). Cancellation is cooperative via the job
// status. Per-item dedup across folders/runs is further short-circuited by the
// UserCheck spam_cache.

import { BulkJobService, ItemResult, BulkJob } from '../services/bulk-job-service.js';
import { ImapService } from '../services/imap-service.js';
import { UserCheckService, SpamCheckCriteria, normalizeAddress } from '../services/usercheck-service.js';

export interface RunnerDeps {
  imapService: ImapService;
  userCheck: UserCheckService;
}

export interface BulkRunner {
  /** Re-derive the work items (item keys) for a job from its stored params. */
  deriveItems(userId: string, params: any, deps: RunnerDeps): Promise<string[]>;
  /** Process one item key; throw to record an error and continue. */
  processOne(userId: string, itemKey: string, params: any, deps: RunnerDeps): Promise<ItemResult>;
  /** Build the final result summary from the recorded items. */
  summarize(jobId: string, params: any, jobs: BulkJobService): unknown;
}

function criteriaOf(params: any): SpamCheckCriteria {
  return {
    checkDisposable: params?.checkDisposable ?? true,
    checkBlocklisted: params?.checkBlocklisted ?? true,
    checkRoleAccount: params?.checkRoleAccount ?? true,
    checkMx: params?.checkMx ?? true,
    allowPublicDomains: params?.allowPublicDomains ?? true,
  };
}

/** Check one sender address, cache-first (write-through). Result carries spam verdict. */
async function checkOneSender(userId: string, addr: string, params: any, deps: RunnerDeps): Promise<ItemResult> {
  const useCache = params?.useCache !== false;
  if (useCache) {
    const cached = await deps.userCheck.getCachedResult(addr);
    if (cached) return { outcome: 'ok', result: { ...cached, email: addr, cached: true } };
  }
  const result = await deps.userCheck.checkEmail(userId, addr, criteriaOf(params));
  await deps.userCheck.cacheResult(addr, result);
  return { outcome: 'ok', result: { ...result, email: addr, cached: false } };
}

/** Summarize spam results recorded on a job: counts + the flagged senders. */
function summarizeSpam(jobId: string, jobs: BulkJobService) {
  const items = jobs.items(jobId);
  const spamSenders = items
    .filter((i) => (i.result as any)?.isSpam)
    .map((i) => ({ email: i.itemKey, spamScore: (i.result as any)?.spamScore, reason: (i.result as any)?.spamReason }));
  return {
    sendersChecked: items.length,
    spamSenders: spamSenders.length,
    errors: items.filter((i) => i.outcome === 'error').length,
    topSpamSenders: spamSenders.sort((a, b) => (b.spamScore ?? 0) - (a.spamScore ?? 0)).slice(0, 20),
  };
}

export const BULK_RUNNERS: Record<string, BulkRunner> = {
  imap_scan_account_spam: {
    async deriveItems(_userId, params, deps) {
      const folders = await deps.imapService.listFolders(params.accountId);
      const perFolder = params?.maxEmailsPerFolder ?? 100;
      const senders = new Set<string>();
      for (const folder of folders) {
        try {
          const all = await deps.imapService.searchEmails(params.accountId, folder.name, {});
          for (const e of all.slice(0, perFolder)) {
            const addr = normalizeAddress(e.from);
            if (addr) senders.add(addr);
          }
        } catch { /* skip unreadable folder */ }
      }
      return [...senders];
    },
    processOne(userId, itemKey, params, deps) { return checkOneSender(userId, itemKey, params, deps); },
    summarize(jobId, _params, jobs) { return summarizeSpam(jobId, jobs); },
  },

  imap_check_emails_spam_bulk: {
    async deriveItems(_userId, params) {
      const senders = new Set<string>();
      for (const raw of (params?.emails ?? [])) {
        const addr = normalizeAddress(raw);
        if (addr) senders.add(addr);
      }
      return [...senders];
    },
    processOne(userId, itemKey, params, deps) { return checkOneSender(userId, itemKey, params, deps); },
    summarize(jobId, _params, jobs) { return summarizeSpam(jobId, jobs); },
  },
};

/** Outcome envelope returned by the start/resume tools. */
function envelope(jobs: BulkJobService, jobId: string, completed: boolean) {
  const job = jobs.getJob(jobId)!;
  const base = {
    jobId,
    toolName: job.toolName,
    status: job.status,
    progress: { done: job.doneItems, total: job.totalItems, errors: job.errorItems },
  };
  return completed
    ? { ...base, mode: 'completed', summary: job.resultSummary }
    : {
        ...base,
        mode: 'running',
        hint: 'Still running. Poll imap_bulk_job_status, or imap_bulk_job_resume / imap_bulk_job_cancel.',
      };
}

/**
 * Run a job with a sync time budget. Returns when the job finishes OR the budget
 * elapses (whichever first); on timeout the run continues in the background.
 */
export async function runJobWithBudget(
  jobs: BulkJobService,
  jobId: string,
  items: string[],
  processOne: (key: string) => Promise<ItemResult>,
  summarize: (jobId: string) => unknown,
  budgetMs: number,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let finished = false;
  const run: Promise<BulkJob | null> = jobs
    .runJob(jobId, items, (k) => k, processOne, { summarize })
    .then((j) => { finished = true; return j; })
    .catch((err) => { finished = true; jobs.fail(jobId, err instanceof Error ? err.message : String(err)); return null; });

  await Promise.race([run, new Promise((res) => setTimeout(res, budgetMs))]);
  // If the budget elapsed first, leave `run` executing in the background.
  return { content: [{ type: 'text', text: JSON.stringify(envelope(jobs, jobId, finished), null, 2) }] };
}
