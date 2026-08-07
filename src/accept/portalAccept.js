// Path B — accept via the portal by replaying the WebForms __doPostBack.
//
// Real E-Street portal flow (owner-confirmed):
//   1. GET New Orders → green tick (image Accept) for the order row.
//   2. Confirmation page (AcceptAppraisal / AcceptBroadcastAppraisal) with
//      green "Accept Appraisal" button → POST that.
//   3. Loading, then order detail / in-progress (no alert popup).
import { writeFile } from 'node:fs/promises';
import {
  buildControlClick,
  findPostbackTarget,
  looksLikeLogin,
  looksLikeStaleState,
  scrapeFormActionForControl,
} from '../portal/aspnet.js';
import { logger } from '../util/logger.js';
import { snippet } from '../portal/session.js';
import { dumpAcceptDiagnostic } from './diagnostic.js';
import {
  findConfirmAcceptControl,
  isAcceptConfirmUrl,
  looksAccepted,
  looksLikePortalError,
  looksTaken,
} from './signals.js';
import { acceptAsIsUrl, extractApprIdNearOrder } from './apprId.js';

function resolveEarlyAsIsTimeoutMs() {
  const n = Number(process.env.EARLY_ASIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1200;
}

/**
 * @param {object} opts
 * @param {import('../portal/session.js').PortalSession} opts.session
 * @param {string} opts.orderId
 * @param {string} [opts.newOrdersPath]
 * @param {RegExp} [opts.acceptLabel]  list-row Accept locator (default /accept/i)
 * @param {(html:string, orderId:string)=>({target:string,argument?:string,extra?:object}|null)} [opts.locateAccept]
 * @param {object} [opts.log]
 * @param {boolean} [opts.reuseCachedPage]
 * @param {number} [opts.cacheMaxAgeMs]
 * @param {{body:string, status?:number, url?:string, _reauthed?:boolean, _otpFetched?:boolean}} [opts.prefetchedPage]
 *        New Orders page already fetched on the accept session (overlaps region/lock).
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
  prefetchedPage = null,
  timeoutMs,
  earlyAsIs = true,
  earlyAsIsTimeoutMs,
}) {
  const path = newOrdersPath || session.routes.newOrders;
  const httpOpts = Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {};
  // The initial early-asis GET is a "competitor-style shot in the dark" — it
  // has no race/fallback of its own, so giving it the full accept timeout
  // (default 3000ms) means a slow/hanging response burns the whole budget
  // before we even try the reliable list postback. Keep it short: if the
  // portal doesn't answer fast, assume it won't and fall back sooner
  // (production orders 268-09310/268-09399/268-09464 lost ~3.3s here).
  const resolvedEarlyAsIsTimeoutMs = Number.isFinite(earlyAsIsTimeoutMs) && earlyAsIsTimeoutMs > 0
    ? earlyAsIsTimeoutMs
    : resolveEarlyAsIsTimeoutMs();
  log.info('accept attempt', { orderId });

  const locate = (html) => (locateAccept ? locateAccept(html, orderId) : locateAcceptForOrder(html, orderId, acceptLabel));
  const tag = (result, pageReuse, timings = {}) =>
    result
      ? {
          ...result,
          usedCachedPage: pageReuse !== 'fresh',
          pageReuse,
          timings: { ...(result.timings || {}), ...timings },
        }
      : result;

  if (prefetchedPage?.body && prefetchedPage.body.includes(orderId)) {
    log.info('accept: using prefetched New Orders page (skipping GET)', { orderId });
    const result = tag(await attempt(prefetchedPage, { fromCache: true }), 'prefetched', { listGetMs: 0 });
    if (result) return result;
    log.warn('accept: prefetched page rejected/unusable — falling back', { orderId });
  }

  const cached = reuseCachedPage ? session.getCachedPage(path, cacheMaxAgeMs) : null;
  if (cached && cached.body.includes(orderId)) {
    log.info('accept: reusing recently polled page (skipping fresh GET)', { orderId, ageMs: Date.now() - cached.ts });
    const result = tag(await attempt(cached, { fromCache: true }), 'cache', { listGetMs: 0 });
    if (result) return result;
    log.warn('accept: cached page rejected/unusable — falling back to a fresh GET', { orderId });
  }

  const getStarted = process.hrtime.bigint();
  const page = await session.authedGet(path, httpOpts);
  const listGetMs = Number(process.hrtime.bigint() - getStarted) / 1e6;
  const result = tag(await attempt(page, { fromCache: false }), 'fresh', { listGetMs });
  if (result) return result;
  log.warn('accept: no accept control found for order', { orderId });
  return {
    ok: false,
    outcome: 'not_found',
    reason: `no accept control for order ${orderId}`,
    reauthed: !!page._reauthed,
    otpFetched: !!page._otpFetched,
    usedCachedPage: false,
    pageReuse: 'fresh',
    timings: { listGetMs },
  };

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

    // Competitor-style shot: if ApprID is already on the list HTML, fire
    // Accept=asis BEFORE the list tick. Falls through to list postback on miss.
    if (earlyAsIs) {
      const early = await tryEarlyAcceptAsIs({
        session,
        orderId,
        html,
        log,
        httpOpts,
        earlyAsIsTimeoutMs: resolvedEarlyAsIsTimeoutMs,
        referer: typeof session.url === 'function' ? session.url(path) : path,
      });
      if (early) {
        return {
          ...early,
          timings: { listPostMs: 0, confirmMs: early.timings?.confirmMs || early.durationMs || 0, earlyAsIs: true },
        };
      }
    }

    const pb = locate(html);
    if (!pb) {
      if (fromCache) return null;
      writeFile('/root/Estreet/data/dashboard-diagnostic.html', html, 'utf8').catch(() => {});
      return null;
    }

    const body = buildControlClick(html, pb);

    const listUrl = typeof session.url === 'function' ? session.url(path) : path;
    const listPostStarted = process.hrtime.bigint();
    const res = await session.authedPost(path, body, {
      headers: { referer: listUrl },
      ...httpOpts,
    });
    const listPostMs = Number(process.hrtime.bigint() - listPostStarted) / 1e6;
    let resp = res.body || '';
    let status = res.status;
    let durationMs = res.durationMs || 0;
    let nowReauthed = reauthed || !!res._reauthed;
    let nowOtp = otpFetched || !!res._otpFetched;
    let usedDetailsStep = false;
    let confirmMs = 0;
    let pageUrl = res.url || (typeof session.url === 'function' ? session.url(path) : path);
    const withTimings = (r) => (r ? { ...r, timings: { listPostMs, confirmMs } } : r);

    if (looksLikeLogin(resp)) {
      if (fromCache) return null;
      log.error('accept failed: postback still redirected to login after retry', {
        orderId,
        status,
        bodySnippet: snippet(resp),
      });
      return withTimings({
        ok: false,
        outcome: 'needs_login',
        status,
        durationMs,
        bodySnippet: snippet(resp),
        reauthed: nowReauthed,
        otpFetched: nowOtp,
      });
    }
    if (fromCache && looksLikeStaleState(resp)) return null;

    if (looksTaken(resp)) {
      return withTimings({
        ok: false,
        outcome: 'taken',
        status,
        durationMs,
        reauthed: nowReauthed,
        otpFetched: nowOtp,
      });
    }
    if (looksAccepted(resp)) {
      log.info('accept successful', { orderId, via: 'portal', usedCachedPage: fromCache, steps: ['list_postback'] });
      return withTimings({
        ok: true,
        outcome: 'accepted',
        status,
        durationMs,
        reauthed: nowReauthed,
        otpFetched: nowOtp,
        steps: ['list_postback'],
      });
    }

    // Step 2: confirmation page — prefer "Accept Appraisal".
    const detailsPb = findDetailsAccept(resp, orderId, pageUrl, locateAccept);
    if (detailsPb) {
      dumpAcceptDiagnostic({ orderId, stage: 'portal_confirm_page', html: resp, url: pageUrl });
      const postUrl = scrapeFormActionForControl(resp, pageUrl, detailsPb.target);
      if (/&amp;/i.test(postUrl)) {
        log.error('accept: form action still contains &amp; after decode — refusing POST', {
          orderId,
          postUrl,
        });
        return withTimings({
          ok: false,
          outcome: 'bad_url',
          reason: 'form action retained &amp; entity',
          status,
          durationMs,
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: ['list_postback'],
        });
      }
      const detailsBody = buildControlClick(resp, detailsPb);
      const absPostUrl =
        typeof session.url === 'function' && !/^https?:/i.test(postUrl)
          ? session.url(postUrl)
          : postUrl;
      // Confirm URL already carries Accept=asis (same shape as the email link).
      // Race a cookie'd GET against the WebForms POST — whichever settles with a
      // decisive outcome first wins. The slow ~5–6s losses we saw were waiting
      // only on the heavy postback+278KB Order page.
      log.info('accept: confirmation page — racing Accept=asis GET + Appraisal POST', {
        orderId,
        postUrl: absPostUrl,
      });

      const detailsStarted = process.hrtime.bigint();
      const second = await raceConfirmAccept({
        session,
        absPostUrl,
        postUrl,
        detailsBody,
        referer: pageUrl,
        orderId,
        log,
        timeoutMs: httpOpts.timeoutMs,
      });
      confirmMs = Number(process.hrtime.bigint() - detailsStarted) / 1e6;
      resp = second.body || '';
      status = second.status;
      durationMs = (durationMs || 0) + (second.durationMs || confirmMs);
      nowReauthed = nowReauthed || !!second._reauthed;
      nowOtp = nowOtp || !!second._otpFetched;
      usedDetailsStep = true;
      pageUrl = second.url || absPostUrl;
      const detailSteps = ['list_postback', second.via || 'details_postback'];

      // We already POSTed the list tick — never discard for prefetch fallback.
      // Returning null here caused verify=accepted + dashboard fail (268-08298).
      if (second._ok === false) {
        return withTimings({
          ok: false,
          outcome: 'error',
          reason: second.error || 'confirm request failed',
          status,
          durationMs,
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: detailSteps,
        });
      }

      if (looksLikeLogin(resp)) {
        log.error('accept failed: details Accept redirected to login after retry', {
          orderId,
          status,
          bodySnippet: snippet(resp),
        });
        return withTimings({
          ok: false,
          outcome: 'needs_login',
          status,
          durationMs,
          bodySnippet: snippet(resp),
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: detailSteps,
        });
      }
      if (looksLikePortalError(resp, pageUrl)) {
        dumpAcceptDiagnostic({ orderId, stage: 'portal_post_accept_error', html: resp, url: pageUrl });
        log.error('accept failed: portal returned Error.aspx after Accept Appraisal', {
          orderId,
          status,
          pageUrl,
          bodySnippet: snippet(resp),
        });
        return withTimings({
          ok: false,
          outcome: 'portal_error',
          status,
          durationMs,
          bodySnippet: snippet(resp),
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: detailSteps,
        });
      }
      if (looksTaken(resp)) {
        dumpAcceptDiagnostic({ orderId, stage: 'portal_post_accept_taken', html: resp, url: pageUrl });
        return withTimings({
          ok: false,
          outcome: 'taken',
          status,
          durationMs,
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: detailSteps,
        });
      }
      if (looksAccepted(resp)) {
        log.info('accept successful', {
          orderId,
          via: 'portal',
          usedCachedPage: fromCache,
          confirmVia: second.via,
          steps: detailSteps,
        });
        return withTimings({
          ok: true,
          outcome: 'accepted',
          status,
          durationMs,
          reauthed: nowReauthed,
          otpFetched: nowOtp,
          steps: detailSteps,
        });
      }
      dumpAcceptDiagnostic({ orderId, stage: 'portal_post_accept', html: resp, url: pageUrl });
    } else if (isAcceptConfirmUrl(pageUrl) || /ACCEPT\s+(APPRAISAL\s+)?ORDER/i.test(resp)) {
      // Landed on confirm UI but could not locate the button — capture HTML.
      dumpAcceptDiagnostic({ orderId, stage: 'portal_confirm_no_btn', html: resp, url: pageUrl });
    }

    const steps = usedDetailsStep ? ['list_postback', 'details_postback'] : ['list_postback'];

    // Error.aspx has no order id either — never treat it as an optimistic submit.
    if (looksLikePortalError(resp, pageUrl)) {
      log.error('accept failed: portal error page (not a successful submit)', {
        orderId,
        status,
        pageUrl,
        steps,
      });
      return withTimings({
        ok: false,
        outcome: 'portal_error',
        status,
        durationMs,
        reauthed: nowReauthed,
        otpFetched: nowOtp,
        steps,
      });
    }

    if (status >= 200 && status < 300 && orderId && !resp.includes(orderId)) {
      log.info('accept postback removed order from list — pending verify', {
        orderId,
        via: 'portal',
        usedCachedPage: fromCache,
        steps,
      });
      return withTimings({
        ok: true,
        outcome: 'submitted',
        status,
        durationMs,
        reauthed: nowReauthed,
        otpFetched: nowOtp,
        steps,
      });
    }
    // After a list (and possibly confirm) click, never discard for cache fallback.
    if (fromCache && !usedDetailsStep) return null;
    log.error('accept failed: unrecognized postback response', { orderId, status, bodySnippet: snippet(resp), steps });
    return withTimings({
      ok: false,
      outcome: 'unknown',
      status,
      durationMs,
      bodySnippet: snippet(resp),
      reauthed: nowReauthed,
      otpFetched: nowOtp,
      steps,
    });
  }
}

/**
 * Confirm claim: Prefer Accept=asis GET (fast, no exclusive gate). Only if that
 * leaves us on the confirm UI, fall back to the heavy WebForms POST.
 * Parallel POST used to hold the session gate for 2–6s even when GET already lost.
 */
async function raceConfirmAccept({ session, absPostUrl, postUrl, detailsBody, referer, orderId, log, timeoutMs }) {
  const headers = { referer };
  const httpOpts = Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {};

  const wrap = async (via, promise) => {
    try {
      const r = await promise;
      return { ...r, via, _ok: true };
    } catch (e) {
      log.warn('confirm accept path error', { via, orderId, err: String(e) });
      return { status: 0, body: '', durationMs: 0, via, _ok: false, error: String(e) };
    }
  };

  const isDecisive = (r) => {
    if (!r || r._ok === false) return false;
    const body = r.body || '';
    const url = r.url || absPostUrl;
    if (looksLikeLogin(body)) return true;
    if (looksLikePortalError(body, url)) return true;
    if (looksTaken(body)) return true;
    if (looksAccepted(body)) return true;
    // Confirm UI still showing Accept Appraisal → GET alone did not finish.
    if (findConfirmAcceptControl(body, 'appraisal')) return false;
    if (r.status >= 200 && r.status < 300 && orderId && body && !body.includes(orderId)) return true;
    return false;
  };

  const getResult = await wrap(
    'details_get',
    session.http.get(absPostUrl, { followRedirects: true, headers, ...httpOpts })
  );
  if (isDecisive(getResult)) {
    log.info('confirm accept path settled first', { orderId, via: 'details_get', status: getResult.status });
    return getResult;
  }

  log.info('accept: Accept=asis GET not decisive — falling back to Appraisal POST', {
    orderId,
    status: getResult.status,
  });
  const postResult = await wrap(
    'details_postback',
    session.authedPost(postUrl, detailsBody, { headers, ...httpOpts })
  );
  if (isDecisive(postResult)) {
    log.info('confirm accept path settled first', { orderId, via: 'details_postback', status: postResult.status });
  }
  return postResult._ok !== false ? postResult : getResult._ok !== false ? getResult : postResult;
}

/**
 * One-shot Accept=asis when ApprID is visible on the New Orders HTML.
 * @returns {Promise<object|null>}
 */
async function tryEarlyAcceptAsIs({ session, orderId, html, log, httpOpts, earlyAsIsTimeoutMs, referer }) {
  const apprId = extractApprIdNearOrder(html, orderId);
  if (!apprId) return null;

  const absUrl = acceptAsIsUrl(session, apprId);
  log.info('accept: early Accept=asis GET (ApprID from list)', { orderId, apprId, url: absUrl });
  const started = process.hrtime.bigint();
  // Short, dedicated timeout: this probe has no race/fallback of its own, so
  // it must not burn the full accept timeout before we fall back to the
  // reliable list postback (see resolveEarlyAsIsTimeoutMs / acceptViaPortal).
  const earlyHttpOpts = Number.isFinite(earlyAsIsTimeoutMs) && earlyAsIsTimeoutMs > 0
    ? { ...httpOpts, timeoutMs: earlyAsIsTimeoutMs }
    : httpOpts;
  let res;
  try {
    res = await session.http.get(absUrl, {
      followRedirects: true,
      headers: { referer },
      ...earlyHttpOpts,
    });
  } catch (e) {
    log.warn('accept: early Accept=asis failed — using list postback', { orderId, err: String(e) });
    return null;
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const body = res.body || '';
  const status = res.status;
  const pageUrl = res.url || absUrl;
  const steps = ['early_asis_get'];

  if (looksLikeLogin(body)) {
    log.warn('accept: early Accept=asis hit login — using list postback', { orderId });
    return null;
  }
  if (looksLikePortalError(body, pageUrl)) {
    log.warn('accept: early Accept=asis hit Error.aspx — using list postback', { orderId });
    return null;
  }
  if (looksTaken(body)) {
    return { ok: false, outcome: 'taken', status, durationMs, steps, reauthed: false, otpFetched: false };
  }
  if (looksAccepted(body)) {
    log.info('accept successful', { orderId, via: 'portal', steps, earlyAsIs: true });
    return { ok: true, outcome: 'accepted', status, durationMs, steps, reauthed: false, otpFetched: false };
  }

  // Landed on confirm UI — finish with Appraisal POST only (no list tick).
  const detailsPb = findDetailsAccept(body, orderId, pageUrl, null);
  if (!detailsPb) {
    if (status >= 200 && status < 300 && orderId && body && !body.includes(orderId)) {
      return { ok: true, outcome: 'submitted', status, durationMs, steps, reauthed: false, otpFetched: false };
    }
    log.info('accept: early Accept=asis inconclusive — using list postback', { orderId, status });
    return null;
  }

  dumpAcceptDiagnostic({ orderId, stage: 'portal_early_asis_confirm', html: body, url: pageUrl });
  const postUrl = scrapeFormActionForControl(body, pageUrl, detailsPb.target);
  if (/&amp;/i.test(postUrl)) return null;
  const detailsBody = buildControlClick(body, detailsPb);
  const absPostUrl =
    typeof session.url === 'function' && !/^https?:/i.test(postUrl) ? session.url(postUrl) : postUrl;

  // Same race as the list-postback confirm step (raceConfirmAccept below):
  // try the cookie'd Accept=asis GET first — fast, no exclusive gate — and
  // only fall to the WebForms POST if that's inconclusive. A bare sequential
  // POST here used to eat the full HTTP timeout (~3s, ACCEPT_HTTP_TIMEOUT_MS)
  // before this whole early-asis attempt gave up and fell back to list
  // postback anyway, by which point the order was already gone (production
  // orders 268-08682/268-08906/268-08993 — see early_confirm POST timeout).
  const second = await raceConfirmAccept({
    session,
    absPostUrl,
    postUrl,
    detailsBody,
    referer: pageUrl,
    orderId,
    log,
    timeoutMs: httpOpts.timeoutMs,
  });
  if (second._ok === false) {
    log.warn('accept: early confirm race failed — using list postback', { orderId, err: second.error });
    return null;
  }
  const confirmMs = second.durationMs || 0;
  const totalMs = durationMs + confirmMs;
  const resp2 = second.body || '';
  const status2 = second.status;
  const steps2 = ['early_asis_get', second.via || 'details_postback'];
  const url2 = second.url || absPostUrl;

  if (looksLikePortalError(resp2, url2)) return null;
  if (looksTaken(resp2)) {
    return {
      ok: false,
      outcome: 'taken',
      status: status2,
      durationMs: totalMs,
      steps: steps2,
      reauthed: !!second._reauthed,
      otpFetched: !!second._otpFetched,
      timings: { confirmMs },
    };
  }
  if (looksAccepted(resp2)) {
    log.info('accept successful', { orderId, via: 'portal', steps: steps2, earlyAsIs: true });
    return {
      ok: true,
      outcome: 'accepted',
      status: status2,
      durationMs: totalMs,
      steps: steps2,
      reauthed: !!second._reauthed,
      otpFetched: !!second._otpFetched,
      timings: { confirmMs },
    };
  }
  if (status2 >= 200 && status2 < 300 && orderId && resp2 && !resp2.includes(orderId)) {
    return {
      ok: true,
      outcome: 'submitted',
      status: status2,
      durationMs: totalMs,
      steps: steps2,
      reauthed: !!second._reauthed,
      otpFetched: !!second._otpFetched,
      timings: { confirmMs },
    };
  }
  return null;
}

/**
 * Confirmation-page Accept: prefer Accept Appraisal; never re-click list tick.
 */
function findDetailsAccept(html, orderId, pageUrl, locateAccept) {
  if (!html) return null;
  const onConfirmUrl = isAcceptConfirmUrl(pageUrl);
  if (orderId && html.includes(orderId) && /imgBtnBroadcastAccept|grdNewOrders/i.test(html) && !onConfirmUrl) {
    const listPb = locateAccept ? locateAccept(html, orderId) : locateAcceptForOrder(html, orderId, /accept/i);
    if (listPb && /BroadcastAccept|grdNewOrders/i.test(listPb.target || '')) return null;
  }

  const preferred = findConfirmAcceptControl(html, 'appraisal');
  if (preferred) return preferred;

  if (locateAccept) {
    const scoped = locateAccept(html, orderId);
    if (scoped) return scoped;
  }
  const scoped = locateAcceptForOrder(html, orderId, /accept/i);
  if (scoped) return scoped;
  return findPostbackTarget(html, /accept/i);
}

export function locateAcceptForOrder(html, orderId, acceptLabel = /accept/i) {
  if (orderId) {
    const idx = html.indexOf(orderId);
    if (idx === -1) return null;
    const local = findPostbackTarget(html.slice(idx, idx + 4000), acceptLabel);
    if (local) return local;
    return findPostbackTarget(html.slice(Math.max(0, idx - 2000), idx + 4000), acceptLabel);
  }
  return findPostbackTarget(html, acceptLabel);
}

export default acceptViaPortal;
