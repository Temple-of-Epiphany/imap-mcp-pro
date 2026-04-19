/**
 * WorkerPool
 *
 * Lightweight pool of node:worker_threads for offloading CPU-bound work
 * (mail parsing, summary building, filtering) off the main event loop.
 *
 * - Round-robin task dispatch with promise-based responses
 * - Per-task timeout
 * - Graceful destroy() that drains pending tasks
 *
 * Author: Temple of Epiphany
 * Date: 2026-04-18
 */

import { Worker } from 'worker_threads';
import { ContextReductionConfig as Cfg } from '../config/context-reduction.js';

export interface WorkerTask<I = unknown> {
  type: string;
  payload: I;
}

interface PendingTask {
  id: number;
  task: WorkerTask;
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timeout: NodeJS.Timeout;
}

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  pending: Map<number, PendingTask>;
}

export interface WorkerPoolOptions {
  size?: number;
  workerScript: URL | string;
  taskTimeoutMs?: number;
}

export class WorkerPool {
  private workers: PooledWorker[] = [];
  private rrIndex = 0;
  private nextTaskId = 1;
  private destroyed = false;
  private taskTimeoutMs: number;

  constructor(opts: WorkerPoolOptions) {
    const size = opts.size ?? Cfg.WORKER_POOL_SIZE;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? Cfg.WORKER_TASK_TIMEOUT_MS;

    for (let i = 0; i < size; i++) {
      const w = new Worker(opts.workerScript);
      const pooled: PooledWorker = { worker: w, busy: false, pending: new Map() };
      w.on('message', (msg: { id: number; ok: boolean; result?: any; error?: string }) => {
        const p = pooled.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timeout);
        pooled.pending.delete(msg.id);
        if (pooled.pending.size === 0) pooled.busy = false;
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error ?? 'Worker error'));
      });
      w.on('error', (err) => {
        console.error('[WorkerPool] worker error:', err);
        // Reject any in-flight tasks for this worker
        for (const p of pooled.pending.values()) {
          clearTimeout(p.timeout);
          p.reject(err);
        }
        pooled.pending.clear();
        pooled.busy = false;
      });
      this.workers.push(pooled);
    }
  }

  get stats(): { size: number; busy: number; idle: number; queued: number } {
    let busy = 0, queued = 0;
    for (const w of this.workers) {
      if (w.busy) busy += 1;
      queued += w.pending.size;
    }
    return { size: this.workers.length, busy, idle: this.workers.length - busy, queued };
  }

  run<O = unknown, I = unknown>(task: WorkerTask<I>): Promise<O> {
    if (this.destroyed) return Promise.reject(new Error('WorkerPool destroyed'));

    // Find least-loaded worker (by pending count)
    let chosen: PooledWorker | null = null;
    let minPending = Infinity;
    for (let i = 0; i < this.workers.length; i++) {
      const idx = (this.rrIndex + i) % this.workers.length;
      const w = this.workers[idx];
      if (w.pending.size < minPending) {
        chosen = w;
        minPending = w.pending.size;
      }
    }
    if (!chosen) return Promise.reject(new Error('No workers available'));
    this.rrIndex = (this.rrIndex + 1) % this.workers.length;

    const id = this.nextTaskId++;
    return new Promise<O>((resolve, reject) => {
      const timeout = setTimeout(() => {
        chosen!.pending.delete(id);
        reject(new Error(`Worker task '${task.type}' timed out after ${this.taskTimeoutMs}ms`));
      }, this.taskTimeoutMs);
      chosen!.pending.set(id, { id, task: task as WorkerTask, resolve, reject, timeout });
      chosen!.busy = true;
      chosen!.worker.postMessage({ id, task });
    });
  }

  async runBatch<O = unknown, I = unknown>(
    tasks: WorkerTask<I>[],
    concurrency?: number
  ): Promise<O[]> {
    const c = concurrency ?? this.workers.length;
    const out: O[] = new Array(tasks.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(c, tasks.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= tasks.length) return;
        out[i] = await this.run<O, I>(tasks[i]);
      }
    });
    await Promise.all(runners);
    return out;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all(this.workers.map(w => w.worker.terminate().then(() => undefined)));
    this.workers = [];
  }
}
