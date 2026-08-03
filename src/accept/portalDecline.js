// Decline Path B — decline via the portal by replaying the WebForms __doPostBack.
//
// Mirrors portalAccept.js, including the real E-Street two-step:
//   1. GET New Orders → locate Decline for this order → POST list click.
//   2. Confirmation / details page (same as email Decline link) → POST Decline
//      again. One-step portals that confirm on step 1 still short-circuit.
import {
  buildControlClick,
  findPostbackTarget,
  looksLikeLogin,
  looksLikeStaleState,
  scrapeFormActionForControl,
} from '../portal/aspnet.js';
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
  prefetchedPage = null,
  timeoutMs,
}) {
  const path = newOrdersPath || session.routes.newOrders;
  const httpOpts = Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {};
  log.info('decline attempt', { orderId });

  const locate = (html) => (locateDecline ? locateDecline(html, orderId) : locateControlForOrder(html, orderId, declineLabel));

  if (prefetchedPage?.body && prefetchedPage.body.includes(orderId)) {
    log.info('decline: using prefetched New Orders page (skipping GET)', { orderId });
    const result = await attempt(prefetchedPage, { fromCache: true });
    if (result) return { ...result, usedCachedPage: true, pageReuse: 'prefetched' };
    log.warn('decline: prefetched page rejected/unusable — falling back', { orderId });
  }

  const cached = reuseCachedPage ? session.getCachedPage(path, cacheMaxAgeMs) : null;
  if (cached && cached.body.includes(orderId)) {
    log.info('decline: reusing recently polled page (skipping fresh GET)', { orderId, ageMs: Date.now() - cached.ts });
    const result = await attempt(cached, { fromCache: true });
    if (result) return { ...result, usedCachedPage: true, pageReuse: 'cache' };
    log.warn('decline: cached page rejected/unusable — falling back to a fresh GET', { orderId });
  }

  // A login bounce on either the GET or the POST below is handled transparently
  // by session.authedGet/authedPost (re-auth + single retry); if it's STILL
  // bounced after that retry, say so explicitly instead of falling through as a
  // confusing 'not_found'/'unknown'.
  const page = await session.authedGet(path, httpOpts);
  const result = await attempt(page, { fromCache: false });
  if (result) return { ...result, usedCachedPage: false, pageReuse: 'fresh' };
  log.warn('decline: no decline control found for order', { orderId });
  return {
    ok: false,
    outcome: 'not_found',
    reason: `no decline control for order ${orderId}`,
    reauthed: !!page._reauthed,
    otpFetched: !!page._otpFetched,
    usedCachedPage: false,
    pageReuse: 'fresh',
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

    const res = await session.authedPost(path, body, httpOpts);
    let resp = res.body || '';
    let status = res.status;
    let durationMs = res.durationMs || 0;
    let nowReauthed = reauthed || !!res._reauthed;
    let nowOtp = otpFetched || !!res._otpFetched;
    let usedDetailsStep = false;

    if (looksLikeLogin(resp)) {
      if (fromCache) return null;
      log.error('decline failed: postback still redirected to login after retry', {
        orderId,
        status,
        bodySnippet: snippet(resp),
      });
      return {
        ok: false,
        outcome: 'needs_login',
        status,
        durationMs,
        bodySnippet: snippet(resp),
        reauthed: nowReauthed,
        otpFetched: nowOtp,
      };
    }
    if (fromCache && looksLikeStaleState(resp)) return null;

    if (GONE_RE.test(resp)) {
      log.info('decline successful (already gone)', { orderId, via: 'portal' });
      return { ok: true, outcome: 'gone', status, durationMs, reauthed: nowReauthed, otpFetched: nowOtp };
    }
    if (DECLINED_RE.test(resp)) {
      log.info('decline successful', { orderId, via: 'portal', usedCachedPage: fromCache });
      return { ok: true, outcome: 'declined', status, durationMs, reauthed: nowReauthed, otpFetched: nowOtp };
    }

    const detailsPb = findDetailsDecline(resp, orderId, declineLabel, locateDecline);
    if (detailsPb) {
      const pageUrl = res.url || session.url(path);
      const postUrl = scrapeFormActionForControl(resp, pageUrl, detailsPb.target);
      log.info('decline: confirmation page — posting second Decline', { orderId, postUrl });
      const detailsBody = buildControlClick(resp, detailsPb);
      const second = await session.authedPost(postUrl, detailsBody, httpOpts);
      resp = second.body || '';
      status = second.status;
      durationMs = (durationMs || 0) + (second.durationMs || 0);
      nowReauthed = nowReauthed || !!second._reauthed;
      nowOtp = nowOtp || !!second._otpFetched;
      usedDetailsStep = true;

      if (looksLikeLogin(resp)) {
        if (fromCache) return null;
        log.error('decline failed: details Decline redirected to login after retry', {
          orderId,
          status,
          bodySnippet: snippet(resp),
        });
        return {
          ok: false,
          outcome: 'needs_login',
          status,
          durationMs,
          bodySnippet: snippet(resp),
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: ['list_postback', 'details_postback'],
        };
      }
      if (GONE_RE.test(resp)) {
        log.info('decline successful (already gone)', { orderId, via: 'portal' });
        return {
          ok: true,
          outcome: 'gone',
          status,
          durationMs,
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: ['list_postback', 'details_postback'],
        };
      }
      if (DECLINED_RE.test(resp)) {
        log.info('decline successful', {
          orderId,
          via: 'portal',
          usedCachedPage: fromCache,
          steps: ['list_postback', 'details_postback'],
        });
        return {
          ok: true,
          outcome: 'declined',
          status,
          durationMs,
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: ['list_postback', 'details_postback'],
        };
      }
    }

    if (status >= 200 && status < 300) {
      return {
        ok: true,
        outcome: 'submitted',
        status,
        durationMs,
        reauthed: nowReauthed,
        otpFetched: nowOtp,
        steps: usedDetailsStep ? ['list_postback', 'details_postback'] : ['list_postback'],
      };
    }
    // Non-2xx, unrecognized: from a cache attempt this is untrustworthy (could
    // just be stale tokens) rather than a real failure — safe to retry fresh
    // (decline, like accept, is atomic/idempotent server-side).
    if (fromCache) return null;
    log.error('decline failed: unrecognized postback response', { orderId, status, bodySnippet: snippet(resp) });
    return {
      ok: false,
      outcome: 'unknown',
      status,
      durationMs,
      bodySnippet: snippet(resp),
      reauthed: nowReauthed,
      otpFetched: nowOtp,
    };
  }
}

function findDetailsDecline(html, orderId, declineLabel, locateDecline) {
  if (!html) return null;
  if (orderId && html.includes(orderId) && /imgBtnDecline|grdNewOrders|New Orders/i.test(html)) {
    const listPb = locateDecline ? locateDecline(html, orderId) : locateControlForOrder(html, orderId, declineLabel);
    if (listPb && /imgBtnDecline|grdNewOrders|Broadcast/i.test(listPb.target || '')) return null;
  }
  if (locateDecline) {
    const scoped = locateDecline(html, orderId);
    if (scoped) return scoped;
  }
  const scoped = locateControlForOrder(html, orderId, declineLabel);
  if (scoped) return scoped;
  return findPostbackTarget(html, declineLabel);
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
