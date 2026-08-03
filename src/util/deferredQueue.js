// Deferred work queue — runs background tasks (verify, record, log) AFTER the
// hot accept path has already fired its POST.
//
// The accept hot path pushes work items here and returns immediately. The queue
// drains asynchronously, one item at a time, so the caller never waits. A
// failed item is swallowed (logged) — it must never block or crash the queue.
import { logger } from './logger.js';

const log = logger('deferred');

export class DeferredQueue {
  constructor() {
    /** @type {Array<() => Promise<void>>} */
    this._queue = [];
    this._running = false;
    this.stats = { pushed: 0, completed: 0, failed: 0 };
  }

  /**
   * Enqueue a background task. Returns immediately — never blocks the caller.
   * @param {() => Promise<void>} fn
   */
  push(fn) {
    this.stats.pushed++;
    this._queue.push(fn);
    if (!this._running) this._drain();
  }

  /** @private */
  async _drain() {
    this._running = true;
    while (this._queue.length > 0) {
      const fn = this._queue.shift();
      try {
        await fn();
        this.stats.completed++;
      } catch (e) {
        this.stats.failed++;
        log.warn('deferred task failed', { err: String(e) });
      }
    }
    this._running = false;
  }

  /** Number of items waiting + in-flight. */
  get pending() {
    return this._queue.length + (this._running ? 1 : 0);
  }
}

export default DeferredQueue;
