// Decline Path B — decline via the portal by replaying the WebForms __doPostBack.
//
// Robust fallback when the email DECLINE link bounces to login, and the only
// path available when an out-of-region order was detected by the portal poller
// (which has no email link). Mirrors portalAccept.js:
//   1. GET the New Orders page on the warm authed session (or, opt-in, reuse a
//      page the poller *just* fetched — see reuseCachedPage below).
//   2. Scrape fresh __VIEWSTATE / __EVENTVALIDATION and locate the Decline
//      control for this order.
//   3. POST the postback and read accepted/declined/gone signals.
import { buildControlClick, findPostbackTarget, looksLikeLogin, looksLikeStaleState } from '../portal/aspnet.js';
import { logger } from '../util/logger.js';
import { snippet } from '../portal/session.js';

const DECLINED_RE = /declined|rejected|order declined|has been declined|removed from your/i;
const GONE_RE = /no longer available|already (been )?(assigned|accepted)|not available|assigned to another/i;

/**
 * @param {object} opts
 * @param {import('../portal/session.js').PortalSession} opts.session
 * @param {string} opts.orderId
 * @param {string} [opts.newOrdersPath]
 * @param {RegExp} [opts.declineLabel]  text/value identifying the Decline control
 * @param {(html:string, orderId:string)=>object|null} [opts.locateDecline]
 * @param {object} [opts.log]
 * @param {boolean} [opts.reuseCachedPage]  see portalAccept.js's doc for the full
 *        rationale/safety argument — same opt-in, same safe-fallback guarantee.
 * @param {number} [opts.cacheMaxAgeMs]
 */
export async function declineViaPortal({
  session,
  orderId,
  newOrdersPath,
  declineLabel = /decline|reject/i,
  locateDecline,
  log = logger('decline:portal'),
  reuseCachedPage = false,
  cacheMaxAgeMs = 3000,
}) {
  const path = newOrdersPath || session.routes.newOrders;
  log.info('decline attempt', { orderId });

  const locate = (html) => (locateDecline ? locateDecline(html, orderId) : locateControlForOrder(html, orderId, declineLabel));

  const cached = reuseCachedPage ? session.getCachedPage(path, cacheMaxAgeMs) : null;
  if (cached && cached.body.includes(orderId)) {
    log.info('decline: reusing recently polled page (skipping fresh GET)', { orderId, ageMs: Date.now() - cached.ts });
    const result = await attempt(cached, { fromCache: true });
    if (result) return result;
    log.warn('decline: cached page rejected/unusable — falling back to a fresh GET', { orderId });
  }

  // A login bounce on either the GET or the POST below is handled transparently
  // by session.authedGet/authedPost (re-auth + single retry); if it's STILL
  // bounced after that retry, say so explicitly instead of falling through as a
  // confusing 'not_found'/'unknown'.
  const page = await session.authedGet(path);
  const result = await attempt(page, { fromCache: false });
  if (result) return result;
  log.warn('decline: no decline control found for order', { orderId });
  return {
    ok: false,
    outcome: 'not_found',
    reason: `no decline control for order ${orderId}`,
    reauthed: !!page._reauthed,
    otpFetched: !!page._otpFetched,
  };

  /** @see portalAccept.js's attempt() — identical contract (null = "try a fresh page"). */
  async function attempt(pageData, { fromCache }) {
    const html = pageData.body;
    const reauthed = !!pageData._reauthed;
    const otpFetched = !!pageData._otpFetched;

    if (looksLikeLogin(html)) {
      if (fromCache) return null;
      log.error('decline failed: still redirected to login after retry', {
        orderId,
        status: pageData.status,
        bodySnippet: snippet(html),
      });
      return { ok: false, outcome: 'needs_login', status: pageData.status, bodySnippet: snippet(html), reauthed, otpFetched };
    }

    const pb = locate(html);
    if (!pb) return null; // fresh path: caller reports not_found; cache path: try fresh

    const body = buildControlClick(html, pb);

    const res = await session.authedPost(path, body);
    const resp = res.body || '';
    const nowReauthed = reauthed || !!res._reauthed;
    const nowOtp = otpFetched || !!res._otpFetched;

    if (looksLikeLogin(resp)) {
      if (fromCache) return null;
      log.error('decline failed: postback still redirected to login after retry', {
        orderId,
        status: res.status,
        bodySnippet: snippet(resp),
      });
      return {
        ok: false,
        outcome: 'needs_login',
        status: res.status,
        durationMs: res.durationMs,
        bodySnippet: snippet(resp),
        reauthed: nowReauthed,
        otpFetched: nowOtp,
      };
    }
    if (fromCache && looksLikeStaleState(resp)) return null;

    if (GONE_RE.test(resp)) {
      log.info('decline successful (already gone)', { orderId, via: 'portal' });
      return { ok: true, outcome: 'gone', status: res.status, durationMs: res.durationMs, reauthed: nowReauthed, otpFetched: nowOtp };
    }
    if (DECLINED_RE.test(resp)) {
      log.info('decline successful', { orderId, via: 'portal', usedCachedPage: fromCache });
      return { ok: true, outcome: 'declined', status: res.status, durationMs: res.durationMs, reauthed: nowReauthed, otpFetched: nowOtp };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, outcome: 'submitted', status: res.status, durationMs: res.durationMs, reauthed: nowReauthed, otpFetched: nowOtp };
    }
    // Non-2xx, unrecognized: from a cache attempt this is untrustworthy (could
    // just be stale tokens) rather than a real failure — safe to retry fresh
    // (decline, like accept, is atomic/idempotent server-side).
    if (fromCache) return null;
    log.error('decline failed: unrecognized postback response', { orderId, status: res.status, bodySnippet: snippet(resp) });
    return {
      ok: false,
      outcome: 'unknown',
      status: res.status,
      durationMs: res.durationMs,
      bodySnippet: snippet(resp),
      reauthed: nowReauthed,
      otpFetched: nowOtp,
    };
  }
}

/**
 * Locate the control (decline) for a specific order: find the order id in the
 * page, search a window after it for the matching postback target, widening
 * backwards if needed, then fall back to a page-global control.
 */
export function locateControlForOrder(html, orderId, labelRe) {
  if (orderId) {
    const idx = html.indexOf(orderId);
    // Order not on the page → do NOT fall back to a page-global control (that
    // would act on a DIFFERENT order). Return null.
    if (idx === -1) return null;
    const local = findPostbackTarget(html.slice(idx, idx + 4000), labelRe);
    if (local) return local;
    return findPostbackTarget(html.slice(Math.max(0, idx - 2000), idx + 4000), labelRe);
  }
  return findPostbackTarget(html, labelRe);
}

export default declineViaPortal;
