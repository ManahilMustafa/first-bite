// Path B — accept via the portal by replaying the WebForms __doPostBack.
//
// Robust fallback / verifier. Steps:
//   1. GET the New Orders page on the warm authed session (or, opt-in, reuse a
//      page the poller *just* fetched — see reuseCachedPage below).
//   2. Scrape fresh __VIEWSTATE / __EVENTVALIDATION and locate the Accept
//      control for this order (its __doPostBack target or submit button name).
//   3. POST the postback back to the same page.
//   4. Read the response for accepted / already-taken signals.
import { writeFile } from 'node:fs/promises';
import { buildControlClick, findPostbackTarget, looksLikeLogin, looksLikeStaleState } from '../portal/aspnet.js';
import { logger } from '../util/logger.js';
import { snippet } from '../portal/session.js';

const ACCEPTED_RE = /accepted|assigned to you|order accepted|in progress|success/i;
const TAKEN_RE = /no longer available|already (been )?(assigned|accepted)|not available/i;

/**
 * @param {object} opts
 * @param {import('../portal/session.js').PortalSession} opts.session
 * @param {string} opts.orderId
 * @param {string} [opts.newOrdersPath]   override the New Orders route
 * @param {RegExp} [opts.acceptLabel]     text/value that identifies the Accept control
 * @param {(html:string, orderId:string)=>({target:string,argument?:string,extra?:object}|null)} [opts.locateAccept]
 *        custom locator for the accept control for a specific order row
 * @param {object} [opts.log]
 * @param {boolean} [opts.reuseCachedPage]
 *        OPT-IN, default false. The portal poller already fetches this exact
 *        page every couple of seconds; if a *very* recent copy is on hand,
 *        skip the fresh GET and build the postback straight from it — saves
 *        one full HTTP round-trip off the accept critical path. Unconfirmed
 *        against the real portal whether it tolerates a few-seconds-old
 *        VIEWSTATE on this page (see CLAUDE.md "Two production unknowns"), so
 *        this is disabled unless explicitly turned on per account, and is
 *        SAFE-BY-CONSTRUCTION regardless: any sign the cached tokens were
 *        rejected (stale-state page, login bounce, or even just an
 *        unrecognized response) falls back to a guaranteed-fresh GET+POST —
 *        so worst case this is exactly as slow as reuseCachedPage:false,
 *        never slower, never wrong.
 * @param {number} [opts.cacheMaxAgeMs]  how old a cached page may be (default 3000ms)
 */
export async function acceptViaPortal({
  session,
  orderId,
  newOrdersPath,
  acceptLabel = /accept/i,
  locateAccept,
  log = logger('accept:portal'),
  reuseCachedPage = false,
  cacheMaxAgeMs = 3000,
}) {
  const path = newOrdersPath || session.routes.newOrders;
  log.info('accept attempt', { orderId });

  const locate = (html) => (locateAccept ? locateAccept(html, orderId) : locateAcceptForOrder(html, orderId, acceptLabel));

  // Try the cached page first, IF asked to and it plausibly has this order.
  const cached = reuseCachedPage ? session.getCachedPage(path, cacheMaxAgeMs) : null;
  if (cached && cached.body.includes(orderId)) {
    log.info('accept: reusing recently polled page (skipping fresh GET)', { orderId, ageMs: Date.now() - cached.ts });
    const result = await attempt(cached, { fromCache: true });
    if (result) return result;
    log.warn('accept: cached page rejected/unusable — falling back to a fresh GET', { orderId });
  }

  // Guaranteed-fresh path (the only path when reuseCachedPage is off). A login
  // bounce here is handled transparently by session.authedGet/authedPost
  // (re-auth + single retry); if it's STILL bounced after that retry, say so
  // explicitly instead of letting it fall through as a confusing 'not_found'.
  const page = await session.authedGet(path);
  const result = await attempt(page, { fromCache: false });
  if (result) return result;
  log.warn('accept: no accept control found for order', { orderId });
  return {
    ok: false,
    outcome: 'not_found',
    reason: `no accept control for order ${orderId}`,
    reauthed: !!page._reauthed,
    otpFetched: !!page._otpFetched,
  };

  /**
   * One GET-page → locate → POST → interpret cycle.
   * @returns the final result object, or `null` to mean "this page/response
   *          couldn't be trusted — try again with a guaranteed-fresh page"
   *          (only ever returned when fromCache is true; the fresh path always
   *          returns a definitive result, even 'not_found'/'unknown').
   */
  async function attempt(pageData, { fromCache }) {
    const html = pageData.body;
    const reauthed = !!pageData._reauthed;
    const otpFetched = !!pageData._otpFetched;

    if (looksLikeLogin(html)) {
      if (fromCache) return null;
      log.error('accept failed: still redirected to login after retry', {
        orderId,
        status: pageData.status,
        bodySnippet: snippet(html),
      });
      return { ok: false, outcome: 'needs_login', status: pageData.status, bodySnippet: snippet(html), reauthed, otpFetched };
    }

    const pb = locate(html);
    if (!pb) {
      if (fromCache) return null; // maybe just stale — a fresh page might still have it
      // TEMP DIAGNOSTIC: dump the real page whenever the accept control can't be
      // located, so the actual markup is on hand instead of guessed at. Remove
      // once the real portal's Accept control shape is confirmed and handled.
      writeFile('/root/Estreet/data/dashboard-diagnostic.html', html, 'utf8').catch(() => {});
      return null; // signals the caller to report not_found (keeps one code path)
    }

    const body = buildControlClick(html, pb);

    const res = await session.authedPost(path, body);
    const resp = res.body || '';
    const nowReauthed = reauthed || !!res._reauthed;
    const nowOtp = otpFetched || !!res._otpFetched;

    if (looksLikeLogin(resp)) {
      if (fromCache) return null;
      log.error('accept failed: postback still redirected to login after retry', {
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
    // Only meaningful for a cache attempt: the session IS fine, but these
    // particular tokens were rejected as stale — a fresh GET gets new ones.
    if (fromCache && looksLikeStaleState(resp)) return null;

    if (TAKEN_RE.test(resp)) {
      return { ok: false, outcome: 'taken', status: res.status, durationMs: res.durationMs, reauthed: nowReauthed, otpFetched: nowOtp };
    }
    if (ACCEPTED_RE.test(resp) || (res.status >= 200 && res.status < 300)) {
      log.info('accept successful', { orderId, via: 'portal', usedCachedPage: fromCache });
      return { ok: true, outcome: 'accepted', status: res.status, durationMs: res.durationMs, reauthed: nowReauthed, otpFetched: nowOtp };
    }
    // An unrecognized response from a CACHE attempt is treated as untrustworthy
    // rather than a real failure — retrying fresh is safe (the portal's accept
    // is atomic/idempotent: a duplicate postback on an already-accepted order
    // just comes back 'taken', it never double-accepts).
    if (fromCache) return null;
    log.error('accept failed: unrecognized postback response', { orderId, status: res.status, bodySnippet: snippet(resp) });
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
 * Default locator: find the row/section that mentions the order id, then find an
 * Accept postback target within a window around it. Falls back to a page-global
 * accept control if rows aren't separable.
 */
export function locateAcceptForOrder(html, orderId, acceptLabel = /accept/i) {
  if (orderId) {
    const idx = html.indexOf(orderId);
    // Order not on the page (e.g. already taken/removed) → do NOT fall back to a
    // page-global control: that would accept a DIFFERENT order. Return null.
    if (idx === -1) return null;
    // Search a window after the order id for the nearest accept control.
    const local = findPostbackTarget(html.slice(idx, idx + 4000), acceptLabel);
    if (local) return local;
    // Some layouts put the button before the id; widen backwards too.
    return findPostbackTarget(html.slice(Math.max(0, idx - 2000), idx + 4000), acceptLabel);
  }
  // No order id given (single-order page): take the page's accept control.
  return findPostbackTarget(html, acceptLabel);
}

export default acceptViaPortal;
