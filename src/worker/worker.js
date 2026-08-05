// AccountWorker — everything for ONE account, fully isolated.
//
// Owns: its portal session (cookie jar), its detectors (portal poller + the
// Gmail detector feeds in externally via onOrder), its historyId cursor. Shares
// only the Redis lock (exactly-once) with the rest of the fleet. Designed to run
// as its own process/container so a crash/revocation only takes down this one.
//
// One session for poll + accept so the poller's fresh New Orders HTML can be
// reused on the accept postback (skips a GET on the hot path). Session HTTP is
// serialized via PortalSession._exclusive.
import { PortalSession } from '../portal/session.js';
import { PortalPoller } from '../detect/portalPoller.js';
import { executeAccept } from '../accept/acceptExecutor.js';
import { executeDecline } from '../accept/declineExecutor.js';
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
   * @param {(args:{sentAfter:number})=>Promise<string|null>} [opts.fetchOtpCode]
   *        shared email-OTP resolver (see src/portal/emailOtp.js); only used when
   *        the account sets `otpFields`.
   * @param {object} [opts.cookieStore]  shared SessionCookieStore — lets this
   *        account resume its portal session across process restarts instead
   *        of logging in (and hitting OTP, if required) fresh every time.
   */
  constructor({ account, lock, portalOpts = {}, poll = true, onResult, fetchOtpCode, cookieStore, log = logger }) {
    this.account = account;
    this.lock = lock;
    const reuseCachedPage =
      !!account.reuseCachedPage || String(process.env.REUSE_CACHED_PAGE || '') === '1';
    const acceptTimeoutMs = Number(process.env.ACCEPT_HTTP_TIMEOUT_MS);
    this.portalOpts = {
      reuseCachedPage,
      ...(Number.isFinite(acceptTimeoutMs) && acceptTimeoutMs > 0
        ? { timeoutMs: acceptTimeoutMs }
        : {}),
      ...portalOpts,
    };
    this.enablePoll = poll;
    this.onResult = onResult;
    this.log = log(`worker:${account.label || account.id || account.portalUsername}`);

    this.session = new PortalSession({
      baseUrl: account.portalBaseUrl,
      username: account.portalUsername,
      password: account.portalPassword,
      routes: account.portalRoutes,
      fields: account.portalFields,
      otpFields: account.otpFields,
      fetchOtpCode,
      cookieStore,
      accountId: account.id,
      label: account.label || account.portalUsername,
    });
    this.verify = makePortalVerifier(this.session);
    this.poller = null;
    this.stats = {
      detected: 0,
      accepted: 0,
      taken: 0,
      failed: 0,
      deduped: 0,
      declined: 0,
      declineFailed: 0,
      regionUnknown: 0,
    };
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

  /** Clear portal poller circuit breaker and resume polling. */
  resumePortalPoller() {
    if (!this.poller) return false;
    this.poller.resume();
    this.log.info('portal poller resume requested');
    return true;
  }

  /**
   * Entry point for ANY detector (portal poller OR gmail watcher). Applies THIS
   * account's region rule, then either accepts (in-region) or actively declines
   * (out-of-region). Wins the lock → races strategy paths → verifies → reports.
   * Idempotent per order via the lock.
   */
  async handleOrder(order) {
    const {
      orderId,
      acceptUrl,
      declineUrl,
      source,
      address,
      zip,
      state,
      forwardingEmail,
      emailReceivedAt,
      previousPollAt,
      prefetchedPage,
    } = order;
    const detectedAt = Date.now();
    this.stats.detected++;
    this.log.info('order detected', { orderId, source, account: this.account.label, address, zip, state });

    let detectionLatencyMs = null;
    if (emailReceivedAt) detectionLatencyMs = detectedAt - emailReceivedAt;
    else if (previousPollAt) detectionLatencyMs = detectedAt - previousPollAt;

    const region = orderMatchesRegion(this.account, { address, zip, state });
    const meta = {
      orderId,
      source,
      address,
      state: region.meta?.state ?? state ?? null,
      zip: region.meta?.zip ?? zip ?? null,
      account: this.account.label || this.account.portalUsername,
      accountId: this.account.id || null,
      forwardingEmail: forwardingEmail ?? this.account.forwardingEmail ?? null,
    };

    if (!region.allowed && !region.decided) {
      this.stats.regionUnknown++;
      this.log.warn('region matched: undetermined — not acting', { orderId, source, meta: region.meta });
      return this._report({
        ...meta,
        action: 'skip',
        accepted: false,
        declined: false,
        reason: 'region_unknown',
        detectedAt,
        detectionLatencyMs,
      });
    }
    this.log.info('region matched', {
      orderId,
      decision: region.allowed ? 'in-region — will accept' : 'out-of-region — will decline',
      reason: region.reason,
      meta: region.meta,
    });

    const key = orderLockKey(`${this.account.id || this.account.portalUsername}:${orderId}`);
    const lockStartedAt = Date.now();
    const won = await this.lock.acquire(key);
    const lockWaitMs = Date.now() - lockStartedAt;
    if (!won) {
      this.stats.deduped++;
      this.log.debug('order already in flight, skipping', { orderId, source });
      return { ...meta, action: region.allowed ? 'accept' : 'decline', deduped: true };
    }

    let event = region.allowed
      ? await this._accept({ orderId, acceptUrl, source, prefetchedPage })
      : await this._decline({ orderId, declineUrl, source, region, prefetchedPage });
    const totalMs = Date.now() - detectedAt;
    event = {
      ...event,
      address: meta.address,
      state: meta.state,
      zip: meta.zip,
      account: meta.account,
      accountId: meta.accountId,
      forwardingEmail: meta.forwardingEmail,
      detectedAt,
      detectionLatencyMs,
      lockWaitMs,
      totalMs,
    };

    const acted = event.accepted || event.declined;
    if (!acted) await this.lock.release(key);

    return this._report(event);
  }

  _report(event) {
    if (this.onResult) {
      try {
        this.onResult(event);
      } catch (e) {
        this.log.warn('onResult threw', { err: String(e) });
      }
    }
    return event;
  }

  async _accept({ orderId, acceptUrl, source, prefetchedPage }) {
    this.log.info('accepting in-region order', { orderId, source, hasEmailLink: !!acceptUrl });
    // Hold the poller for the race itself (Path A/B), but release it the
    // moment the race settles — verify() below is outcome reporting only, and
    // the poller sitting blind for that extra round-trip is pure lost
    // detection time for the NEXT order on this account.
    this.poller?.hold('accept');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.poller?.release('accept');
    };
    let result;
    try {
      result = await executeAccept({
        orderId,
        acceptUrl,
        session: this.session,
        portalOpts: { ...this.portalOpts, prefetchedPage: prefetchedPage || null },
        verify: this.verify,
        onAfterRace: release,
        log: this.log.child('accept'),
      });
    } catch (e) {
      result = { accepted: false, via: null, outcome: 'error', error: String(e) };
      this.log.error('accept threw', { orderId, err: String(e) });
    } finally {
      release();
    }
    if (result.accepted) this.stats.accepted++;
    else if (result.outcome === 'taken') this.stats.taken++;
    else this.stats.failed++;
    return { ...result, action: 'accept', declined: false, orderId, source, account: this.account.portalUsername };
  }

  async _decline({ orderId, declineUrl, source, region, prefetchedPage }) {
    this.log.info('declining out-of-region order', {
      orderId,
      source,
      reason: region.reason,
      meta: region.meta,
      hasEmailLink: !!declineUrl,
    });
    this.poller?.hold('decline');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.poller?.release('decline');
    };
    let result;
    try {
      result = await executeDecline({
        orderId,
        declineUrl,
        session: this.session,
        portalOpts: { ...this.portalOpts, prefetchedPage: prefetchedPage || null },
        verify: this.verify,
        onAfterRace: release,
        log: this.log.child('decline'),
      });
    } catch (e) {
      result = { declined: false, via: null, outcome: 'error', error: String(e) };
      this.log.error('decline threw', { orderId, err: String(e) });
    } finally {
      release();
    }
    if (result.declined) this.stats.declined++;
    else this.stats.declineFailed++;
    return {
      ...result,
      action: 'decline',
      accepted: false,
      orderId,
      source,
      reason: region.reason,
      account: this.account.portalUsername,
    };
  }

  async stop() {
    if (this.poller) this.poller.stop();
    this.session.close();
    this._started = false;
    this.log.info('worker stopped');
  }
}

export default AccountWorker;
