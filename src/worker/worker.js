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

/**
 * Keep the exactly-once lock after a soft confirm submit even if verify is still
 * unknown. Releasing let Gmail re-fire Accept on the same order (production
 * 268-11027/11023 → second attempt already `taken`). Lock TTL still expires.
 */
export function shouldRetainOrderLock(event) {
  if (event?.accepted || event?.declined) return true;
  if (event?.action !== 'accept' || event?.outcome !== 'unverified') return false;
  const portal = event.paths?.portal;
  if (portal?.outcome === 'submitted') return true;
  if (Array.isArray(portal?.steps) && portal.steps.includes('details_postback')) return true;
  return false;
}

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
    // Serialize portal accept/decline so bulk orders don't share one VIEWSTATE
    // stampede. Prefetch HTML body ref is single-use across the queue.
    this._portalWork = Promise.resolve();
    this._spentPrefetchBody = null;
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

    const acted = event.accepted || event.declined || shouldRetainOrderLock(event);
    if (!acted) await this.lock.release(key);

    // shouldRetainOrderLock(event) true here means the portal path already
    // told us the accept POST likely landed (outcome:'submitted' or it reached
    // details_postback) — we just couldn't get a fast enough read to prove it.
    // Left alone, this sits as unverified → pending → FAILED after 30 minutes
    // even when the order really is ours, because nothing ever asks the
    // portal again. Keep asking quietly in the background; a later 'accepted'
    // read is recorded as a corrective event, and computeFinalStatus already
    // treats a success on ANY attempt as the final word — so the dashboard
    // self-corrects instead of permanently mis-reporting a real win as lost.
    if (event.action === 'accept' && !event.accepted && event.outcome === 'unverified' && shouldRetainOrderLock(event)) {
      this._scheduleUnverifiedRecheck(orderId, {
        address: meta.address,
        state: meta.state,
        zip: meta.zip,
        account: meta.account,
        accountId: meta.accountId,
        forwardingEmail: meta.forwardingEmail,
      });
    }

    return this._report(event);
  }

  /**
   * Background-only: re-poll the portal for an order the hot path couldn't
   * confirm, and if it turns out to actually be accepted, append a corrective
   * event. Never blocks handleOrder's return, never retried indefinitely —
   * bounded attempts/window (default ~10 min) so a genuinely stuck order still
   * settles to FAILED via the normal PENDING_FRESH_MS timeout instead of
   * lingering forever.
   *
   * Speed protection: this shares the account's one serialized HTTP session
   * with real accept/decline work (ASP.NET WebForms + one cookie jar can't
   * take concurrent requests safely — see PortalSession._exclusive). A
   * recheck tick that happened to be mid-request exactly when a live order
   * needed accepting would queue behind it and cost real race time. So before
   * every tick this checks the poller's hold count (the same signal
   * accept/decline already raises via poller.hold('accept')) and, if a live
   * accept/decline is in flight, steps aside without spending an attempt —
   * background verification never gets to compete with a live race.
   */
  _scheduleUnverifiedRecheck(orderId, meta, attempts = 20, delayMs = 30000) {
    const run = async (attemptsLeft) => {
      if (!this._started || attemptsLeft <= 0) return;
      await new Promise((r) => setTimeout(r, delayMs));
      if (!this._started) return;

      if ((this.poller?._holds || 0) > 0) {
        this.log.debug('unverified recheck: live accept/decline in flight — stepping aside', { orderId });
        return run(attemptsLeft); // doesn't cost an attempt, just waits for the next tick
      }

      let verified;
      try {
        verified = await this.verify(orderId);
      } catch (e) {
        this.log.warn('unverified recheck: verify threw', { orderId, err: String(e) });
        return run(attemptsLeft - 1);
      }

      if (verified === 'accepted') {
        this.log.info('unverified recheck: portal now confirms accepted', { orderId });
        this.stats.accepted++;
        this._report({
          ...meta,
          orderId,
          action: 'accept',
          accepted: true,
          declined: false,
          outcome: 'accepted',
          via: 'verify-recheck',
          detectedAt: Date.now(),
        });
        return;
      }
      if (verified === 'taken') {
        this.log.info('unverified recheck: portal confirms another vendor took it', { orderId });
        return;
      }
      return run(attemptsLeft - 1);
    };
    run(attempts).catch((e) => this.log.warn('unverified recheck crashed', { orderId, err: String(e) }));
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
   * Run portal accept/decline one-at-a-time for this account.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  _enqueuePortalWork(fn) {
    const run = this._portalWork.then(fn, fn);
    this._portalWork = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /** First consumer of a poll tick's HTML keeps it; later bulk siblings get fresh GET. */
  _takePrefetch(prefetchedPage) {
    if (!prefetchedPage?.body) return null;
    if (this._spentPrefetchBody === prefetchedPage.body) return null;
    this._spentPrefetchBody = prefetchedPage.body;
    return prefetchedPage;
  }

  async _accept({ orderId, acceptUrl, source, prefetchedPage }) {
    this.log.info('accepting in-region order', { orderId, source, hasEmailLink: !!acceptUrl });
    return this._enqueuePortalWork(async () => {
      let released = false;
      const releaseHold = () => {
        if (released) return;
        released = true;
        this.poller?.release('accept');
      };
      this.poller?.hold('accept');
      let result;
      try {
        result = await executeAccept({
          orderId,
          acceptUrl,
          session: this.session,
          portalOpts: {
            ...this.portalOpts,
            prefetchedPage: this._takePrefetch(prefetchedPage),
          },
          verify: this.verify,
          onAfterRace: releaseHold,
          log: this.log.child('accept'),
        });
      } catch (e) {
        result = { accepted: false, via: null, outcome: 'error', error: String(e) };
        this.log.error('accept threw', { orderId, err: String(e) });
      } finally {
        releaseHold();
        // Spent VIEWSTATE must not be reused by the next bulk item.
        try {
          this.session._pageCache?.clear?.();
        } catch {
          /* ignore */
        }
      }
      if (result.accepted) this.stats.accepted++;
      else if (result.outcome === 'taken') this.stats.taken++;
      else this.stats.failed++;
      return { ...result, action: 'accept', declined: false, orderId, source, account: this.account.portalUsername };
    });
  }

  async _decline({ orderId, declineUrl, source, region, prefetchedPage }) {
    this.log.info('declining out-of-region order', {
      orderId,
      source,
      reason: region.reason,
      meta: region.meta,
      hasEmailLink: !!declineUrl,
    });
    return this._enqueuePortalWork(async () => {
      let released = false;
      const releaseHold = () => {
        if (released) return;
        released = true;
        this.poller?.release('decline');
      };
      this.poller?.hold('decline');
      let result;
      try {
        result = await executeDecline({
          orderId,
          declineUrl,
          session: this.session,
          portalOpts: {
            ...this.portalOpts,
            prefetchedPage: this._takePrefetch(prefetchedPage),
          },
          verify: this.verify,
          onAfterRace: releaseHold,
          log: this.log.child('decline'),
        });
      } catch (e) {
        result = { declined: false, via: null, outcome: 'error', error: String(e) };
        this.log.error('decline threw', { orderId, err: String(e) });
      } finally {
        releaseHold();
        try {
          this.session._pageCache?.clear?.();
        } catch {
          /* ignore */
        }
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
    });
  }

  async stop() {
    if (this.poller) this.poller.stop();
    this.session.close();
    this._started = false;
    this.log.info('worker stopped');
  }
}

export default AccountWorker;
