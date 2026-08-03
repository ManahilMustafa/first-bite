// AccountWorker — everything for ONE account, fully isolated.
//
// FAST PATH: when a new order is detected, the accept POST fires within ~5ms
// (synchronous body-build from prefetched HTML → fire POST, don't await). All
// follow-up work (awaiting response, verifying, recording events, logging the
// final result) runs in a DeferredQueue — it never blocks the next order.
//
// Owns: its portal session (cookie jar), its detectors (portal poller + the
// Gmail detector feeds in externally via onOrder), its historyId cursor. Shares
// only the Redis lock (exactly-once) with the rest of the fleet. Designed to run
// as its own process/container so a crash/revocation only takes down this one.
import { PortalSession } from '../portal/session.js';
import { PortalPoller } from '../detect/portalPoller.js';
import { executeAcceptFast, settleAcceptResult, executeAccept } from '../accept/acceptExecutor.js';
import { executeDecline } from '../accept/declineExecutor.js';
import { makePortalVerifier } from '../accept/verifier.js';
import { orderLockKey } from '../lock/lock.js';
import { orderMatchesRegion } from '../util/regionFilter.js';
import { DeferredQueue } from '../util/deferredQueue.js';
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
    this._deferred = new DeferredQueue();
    this.stats = {
      detected: 0,
      accepted: 0,
      taken: 0,
      failed: 0,
      deduped: 0,
      declined: 0,
      declineFailed: 0,
      regionUnknown: 0,
      fastFired: 0,
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
   * FAST-PATH entry point for ANY detector (portal poller OR gmail watcher).
   *
   * For IN-REGION orders with a prefetched page: fires the accept POST in
   * <10ms and defers all follow-up (response parsing, verify, event record)
   * to the background queue. For out-of-region or no-prefetched-page, falls
   * back to the full (slower but more robust) executor.
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

    // ── Region undetermined → skip (never act on ambiguity) ──
    if (!region.allowed && !region.decided) {
      this.stats.regionUnknown++;
      const skipEvent = {
        ...meta,
        action: 'skip',
        accepted: false,
        declined: false,
        reason: 'region_unknown',
        detectedAt,
        detectionLatencyMs,
      };
      // Defer reporting — don't block the poller
      this._deferred.push(() => this._report(skipEvent));
      return skipEvent;
    }

    // ── Out-of-region → DEFER decline entirely (not time-critical) ──
    if (!region.allowed) {
      // Return a promise that resolves when decline completes — callers (tests,
      // Gmail watcher) can await it; the poller fire-and-forgets.
      return this._deferDecline({ orderId, declineUrl, source, region, prefetchedPage, meta, detectedAt, detectionLatencyMs });
    }

    // ── In-region → FAST ACCEPT ──
    const key = orderLockKey(`${this.account.id || this.account.portalUsername}:${orderId}`);
    const lockStartedAt = Date.now();
    const won = await this.lock.acquire(key);
    const lockWaitMs = Date.now() - lockStartedAt;
    if (!won) {
      this.stats.deduped++;
      return { ...meta, action: 'accept', deduped: true };
    }

    // Try the fast fire-and-forget path (requires prefetched page with the order)
    if (prefetchedPage?.body && prefetchedPage.body.includes(orderId)) {
      const fired = executeAcceptFast({
        orderId,
        session: this.session,
        prefetchedPage,
        acceptUrl,
        log: this.log.child('accept:fast'),
      });

      if (fired.fired) {
        this.stats.fastFired++;
        const hotPathMs = Date.now() - detectedAt;
        this.log.info('⚡ FAST ACCEPT fired', { orderId, source, hotPathMs });

        // Settle in the background but expose a .settled promise for callers
        // that need the final result (tests, Gmail watcher).
        const settlePromise = this._settleInBackground({
          fired, orderId, key, source, meta, detectedAt, detectionLatencyMs, lockWaitMs,
        });

        // Return immediately with a preliminary event
        const event = {
          action: 'accept',
          accepted: true, // optimistic — will be corrected by settlement
          declined: false,
          orderId,
          source,
          ...meta,
          detectedAt,
          detectionLatencyMs,
          lockWaitMs,
          totalMs: Date.now() - detectedAt,
          fastFired: true,
          hotPathMs,
          settled: settlePromise,
        };
        return event;
      }
      // Fast path couldn't fire (no accept control) — fall through to full mode
    }

    // ── FULL MODE fallback (no prefetched page, or fast path failed) ──
    this.log.info('accepting in-region order (full mode)', { orderId, source, hasEmailLink: !!acceptUrl });
    let result;
    try {
      result = await executeAccept({
        orderId,
        acceptUrl,
        session: this.session,
        portalOpts: { ...this.portalOpts, prefetchedPage: prefetchedPage || null },
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

    const event = {
      ...result,
      action: 'accept',
      declined: false,
      orderId,
      source,
      account: this.account.portalUsername,
      ...meta,
      detectedAt,
      detectionLatencyMs,
      lockWaitMs,
      totalMs: Date.now() - detectedAt,
      fastFired: false,
    };

    const acted = result.accepted;
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

  /**
   * Run decline in the deferred queue. Returns a promise that resolves to the
   * final event — callers that need the result (tests, Gmail watcher) can
   * await it; the poller just fire-and-forgets.
   */
  async _deferDecline({ orderId, declineUrl, source, region, prefetchedPage, meta, detectedAt, detectionLatencyMs }) {
    const key = orderLockKey(`${this.account.id || this.account.portalUsername}:${orderId}`);
    const won = await this.lock.acquire(key);
    if (!won) { this.stats.deduped++; return { ...meta, action: 'decline', deduped: true }; }

    this.log.info('declining out-of-region order', { orderId, source, reason: region.reason });
    let event;
    try {
      event = await this._decline({ orderId, declineUrl, source, region, prefetchedPage });
    } catch (e) {
      event = { declined: false, via: null, outcome: 'error', error: String(e) };
      this.log.error('decline threw', { orderId, err: String(e) });
    }
    if (event.declined) this.stats.declined++;
    else this.stats.declineFailed++;
    event = {
      ...event,
      action: 'decline',
      accepted: false,
      orderId,
      source,
      reason: region.reason,
      ...meta,
      detectedAt,
      detectionLatencyMs,
      totalMs: Date.now() - detectedAt,
    };
    const acted = event.declined;
    if (!acted) await this.lock.release(key);
    this._report(event);
    return event;
  }

  /**
   * Push settlement into the deferred queue and return a promise for the final
   * result. The hot path fires the POST and returns; this runs after.
   */
  _settleInBackground({ fired, orderId, key, source, meta, detectedAt, detectionLatencyMs, lockWaitMs }) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });

    this._deferred.push(async () => {
      let result;
      try {
        result = await settleAcceptResult({
          fired,
          orderId,
          verify: this.verify,
          log: this.log.child('accept:settle'),
        });
      } catch (e) {
        result = { accepted: false, via: null, outcome: 'error', error: String(e), paths: {} };
        this.log.error('settle threw', { orderId, err: String(e) });
      }

      if (result.accepted) this.stats.accepted++;
      else if (result.outcome === 'taken') this.stats.taken++;
      else this.stats.failed++;

      const event = {
        ...result,
        action: 'accept',
        declined: false,
        orderId,
        source,
        ...meta,
        detectedAt,
        detectionLatencyMs,
        lockWaitMs,
        totalMs: Date.now() - detectedAt,
        fastFired: true,
      };

      if (!result.accepted) await this.lock.release(key);
      this._report(event);
      resolve(event);
    });

    return promise;
  }

  async _decline({ orderId, declineUrl, source, region, prefetchedPage }) {
    let result;
    try {
      result = await executeDecline({
        orderId,
        declineUrl,
        session: this.session,
        portalOpts: { ...this.portalOpts, prefetchedPage: prefetchedPage || null },
        verify: this.verify,
        log: this.log.child('decline'),
      });
    } catch (e) {
      result = { declined: false, via: null, outcome: 'error', error: String(e) };
      this.log.error('decline threw', { orderId, err: String(e) });
    }
    return result;
  }

  async stop() {
    if (this.poller) this.poller.stop();
    this.session.close();
    this._started = false;
    this.log.info('worker stopped');
  }
}

export default AccountWorker;

