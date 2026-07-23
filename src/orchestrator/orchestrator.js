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

// How long to wait before retrying a start() that just failed. Every
// account CRUD op (add/activate/remove — even for a *different* account)
// calls sync(), which retries every active account not yet in `workers`.
// Without a cooldown, an account whose start() fails because the portal
// wants a fresh OTP gets a brand-new OTP dispatched on every one of those
// unrelated calls — the human on the other end sees a new code land every
// time anyone touches the accounts list. The cooldown makes retries track
// "meaningful time has passed", not "someone edited an unrelated account".
const DEFAULT_START_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export class Orchestrator {
  /**
   * @param {object} opts
   * @param {import('../store/accountsStore.js').AccountsStore} opts.store
   * @param {object} opts.lock                shared lock for the whole fleet
   * @param {(account:object, ctx:object)=>AccountWorker} [opts.workerFactory]
   * @param {(event:object)=>void} [opts.onResult]
   * @param {number} [opts.startRetryCooldownMs] min time between start() retries for the same account after a failure
   */
  constructor({ store, lock, workerFactory, onResult, startRetryCooldownMs = DEFAULT_START_RETRY_COOLDOWN_MS, log = logger }) {
    this.store = store;
    this.lock = lock;
    this.onResult = onResult;
    this.log = log('orchestrator');
    this.workers = new Map(); // accountId -> AccountWorker
    this.startRetryCooldownMs = startRetryCooldownMs;
    this._failedStartAt = new Map(); // accountId -> timestamp of last failed start()
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

      // Stop workers whose account is gone or deactivated. Independent accounts
      // — run concurrently rather than one-at-a-time.
      const toStop = [...this.workers].filter(([id]) => !activeIds.has(id));
      await Promise.all(toStop.map(([id, worker]) => this._stopWorker(id, worker)));

      // Start workers for newly-active accounts — likewise concurrently. Each
      // worker's start() does its own login (and, for accounts that require a
      // fresh-login OTP, can take many seconds); awaiting them one at a time
      // meant account N had to wait for accounts 1..N-1 to fully finish logging
      // in before it even BEGAN — an N-account fleet paid N× a single login's
      // worth of avoidable downtime on every boot/reconfigure. Nothing about
      // starting one account's worker depends on another's.
      const now = Date.now();
      const toStart = active.filter((account) => {
        if (this.workers.has(account.id)) return false;
        const failedAt = this._failedStartAt.get(account.id);
        if (failedAt && now - failedAt < this.startRetryCooldownMs) {
          this.log.info('worker start on cooldown, skipping retry', {
            id: account.id,
            retryInMs: this.startRetryCooldownMs - (now - failedAt),
          });
          return false;
        }
        return true;
      });
      await Promise.all(toStart.map((account) => this._startWorker(account)));

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
      this._failedStartAt.delete(account.id);
      this.log.info('worker up', { id: account.id, label: account.label });
    } catch (e) {
      this._failedStartAt.set(account.id, Date.now());
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
