// AccountWorker — everything for ONE account, fully isolated.
//
// Owns: its portal session (cookie jar), its detectors (portal poller + the
// Gmail detector feeds in externally via onOrder), its historyId cursor. Shares
// only the Redis lock (exactly-once) with the rest of the fleet. Designed to run
// as its own process/container so a crash/revocation only takes down this one.
import { PortalSession } from '../portal/session.js';
import { PortalPoller } from '../detect/portalPoller.js';
import { executeAccept } from '../accept/acceptExecutor.js';
import { makePortalVerifier } from '../accept/verifier.js';
import { orderLockKey } from '../lock/lock.js';
import { orderMatchesRegion } from '../util/regionFilter.js';
import { logger } from '../util/logger.js';

export class AccountWorker {
  /**
   * @param {object} opts
   * @param {object} opts.account  decrypted account config
   * @param {object} opts.lock     shared lock instance
   * @param {object} [opts.portalOpts] passed to acceptViaPortal (locator/label)
   * @param {boolean} [opts.poll]  enable the portal poller (default true)
   * @param {(event:object)=>void} [opts.onResult]  accept-result callback (metrics/notify)
   */
  constructor({ account, lock, portalOpts = {}, poll = true, onResult, log = logger }) {
    this.account = account;
    this.lock = lock;
    this.portalOpts = portalOpts;
    this.enablePoll = poll;
    this.onResult = onResult;
    this.log = log(`worker:${account.label || account.id || account.portalUsername}`);

    this.session = new PortalSession({
      baseUrl: account.portalBaseUrl,
      username: account.portalUsername,
      password: account.portalPassword,
      routes: account.portalRoutes,
      fields: account.portalFields,
      label: account.label || account.portalUsername,
    });
    this.verify = makePortalVerifier(this.session);
    this.poller = null;
    this.stats = { detected: 0, accepted: 0, taken: 0, failed: 0, deduped: 0, regionSkipped: 0 };
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;
    await this.session.warmup();
    await this.session.login();

    if (this.enablePoll) {
      this.poller = new PortalPoller({
        session: this.session,
        intervalMs: this.account.pollIntervalMs,
        onOrder: (o) => this.handleOrder(o),
      });
      await this.poller.primeBaseline();
      this.poller.start();
    }
    this.log.info('worker started', { account: this.account.portalUsername });
  }

  /**
   * Entry point for ANY detector (portal poller OR gmail watcher). Wins the lock
   * → races accept paths → verifies → reports. Idempotent per order via the lock.
   * @param {{orderId:string, acceptUrl?:string, address?:string, zip?:string, state?:string, source:string}} order
   */
  async handleOrder(order) {
    const { orderId, acceptUrl, source, address, zip, state } = order;
    this.stats.detected++;

    const region = orderMatchesRegion(this.account, { address, zip, state });
    if (!region.allowed) {
      this.stats.regionSkipped++;
      this.log.info('order skipped — region filter', {
        orderId,
        source,
        reason: region.reason,
        meta: region.meta,
      });
      return { accepted: false, skipped: true, reason: region.reason, orderId, meta: region.meta };
    }

    const key = orderLockKey(`${this.account.id || this.account.portalUsername}:${orderId}`);
    const won = await this.lock.acquire(key);
    if (!won) {
      this.stats.deduped++;
      this.log.debug('order already in flight, skipping', { orderId, source });
      return { accepted: false, deduped: true, orderId };
    }

    this.log.info('handling order', { orderId, source, hasEmailLink: !!acceptUrl });
    let result;
    try {
      result = await executeAccept({
        orderId,
        acceptUrl,
        session: this.session,
        portalOpts: this.portalOpts,
        verify: this.verify,
        log: this.log.child('accept'),
      });
    } catch (e) {
      result = { accepted: false, via: null, outcome: 'error', error: String(e) };
      this.log.error('accept threw', { orderId, err: String(e) });
    }

    if (result.accepted) this.stats.accepted++;
    else if (result.outcome === 'taken') this.stats.taken++;
    else this.stats.failed++;

    // Release the lock only if we did NOT accept — a successful accept should
    // keep the key for its TTL so a late duplicate detection can't re-fire.
    if (!result.accepted) await this.lock.release(key);

    const event = { ...result, orderId, source, account: this.account.portalUsername };
    if (this.onResult) {
      try {
        this.onResult(event);
      } catch (e) {
        this.log.warn('onResult threw', { err: String(e) });
      }
    }
    return event;
  }

  async stop() {
    if (this.poller) this.poller.stop();
    this.session.close();
    this._started = false;
    this.log.info('worker stopped');
  }
}

export default AccountWorker;
