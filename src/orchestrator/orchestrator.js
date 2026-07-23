// Orchestrator — reconciles running workers against the accounts store.
//
// This is the "more creds = more bots" engine: it diffs the set of ACTIVE
// accounts against the set of running workers and starts/stops the difference.
// Call sync() once at boot and again whenever the store changes (the control
// plane calls it after every upsert/activate/remove). Idempotent.
//
// Workers here run in-process (one AccountWorker object each). For hard process
// isolation in production, swap _startWorker/_stopWorker to fork a child process
// per account (e.g. via node:child_process or a container per row) — the
// reconcile logic stays identical.
import { AccountWorker } from '../worker/worker.js';
import { logger } from '../util/logger.js';

export class Orchestrator {
  /**
   * @param {object} opts
   * @param {import('../store/accountsStore.js').AccountsStore} opts.store
   * @param {object} opts.lock                shared lock for the whole fleet
   * @param {(account:object, ctx:object)=>AccountWorker} [opts.workerFactory]
   * @param {(event:object)=>void} [opts.onResult]
   */
  constructor({ store, lock, workerFactory, onResult, log = logger }) {
    this.store = store;
    this.lock = lock;
    this.onResult = onResult;
    this.log = log('orchestrator');
    this.workers = new Map(); // accountId -> AccountWorker
    this.workerFactory =
      workerFactory ||
      ((account) =>
        new AccountWorker({ account, lock: this.lock, onResult: this.onResult }));
    this._syncing = false;
  }

  /** Reconcile workers to match active accounts. Safe to call repeatedly. */
  async sync() {
    if (this._syncing) return; // avoid overlapping reconciles
    this._syncing = true;
    try {
      const active = await this.store.listActive();
      const activeIds = new Set(active.map((a) => a.id));

      // Stop workers whose account is gone or deactivated.
      for (const [id, worker] of this.workers) {
        if (!activeIds.has(id)) {
          await this._stopWorker(id, worker);
        }
      }

      // Start workers for newly-active accounts.
      for (const account of active) {
        if (!this.workers.has(account.id)) {
          await this._startWorker(account);
        }
      }

      this.log.info('sync complete', { live: this.workers.size, active: active.length });
      return { live: this.workers.size };
    } finally {
      this._syncing = false;
    }
  }

  async _startWorker(account) {
    const worker = this.workerFactory(account);
    try {
      await worker.start();
      this.workers.set(account.id, worker);
      this.log.info('worker up', { id: account.id, label: account.label });
    } catch (e) {
      this.log.error('worker failed to start', { id: account.id, err: String(e) });
      try {
        await worker.stop();
      } catch {
        /* ignore */
      }
    }
  }

  async _stopWorker(id, worker) {
    try {
      await worker.stop();
    } catch (e) {
      this.log.warn('worker stop error', { id, err: String(e) });
    }
    this.workers.delete(id);
    this.log.info('worker down', { id });
  }

  /** Route a detected order (e.g. from the Gmail webhook) to the right worker. */
  async routeOrderToAccount(accountId, order) {
    const worker = this.workers.get(accountId);
    if (!worker) {
      this.log.warn('no worker for account', { accountId });
      return null;
    }
    return worker.handleOrder(order);
  }

  getWorker(accountId) {
    return this.workers.get(accountId) || null;
  }

  getWorkerByForwardingEmail(forwardingEmail) {
    const needle = String(forwardingEmail || '').toLowerCase();
    for (const w of this.workers.values()) {
      if ((w.account.forwardingEmail || '').toLowerCase() === needle) return w;
    }
    return null;
  }

  async shutdown() {
    for (const [id, worker] of this.workers) await this._stopWorker(id, worker);
  }

  status() {
    return [...this.workers.values()].map((w) => {
      const snap = w.poller?.statusSnapshot?.() || null;
      return {
        id: w.account.id,
        label: w.account.label,
        username: w.account.portalUsername,
        stats: w.stats,
        pollerStats: w.poller?.stats,
        portalPaused: !!snap?.paused,
        pauseReason: snap?.pauseReason || null,
        pausedAt: snap?.pausedAt || null,
        backoffMs: snap?.backoffMs ?? w.account.pollIntervalMs ?? null,
      };
    });
  }

  /**
   * Resume a paused portal poller for one account (circuit breaker clear).
   * @param {string} accountId
   * @returns {boolean}
   */
  resumePoller(accountId) {
    const worker = this.workers.get(accountId);
    if (!worker) return false;
    return worker.resumePortalPoller();
  }
}

export default Orchestrator;
