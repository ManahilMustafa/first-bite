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
}) {
  const path = newOrdersPath || session.routes.newOrders;
  const httpOpts = Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {};
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

      if (looksLikeLogin(resp)) {
        if (fromCache) return null;
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
    if (fromCache) return null;
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
 * Race cookie'd GET (URL already has Accept=asis) vs WebForms Accept Appraisal POST.
 * First decisive response wins; otherwise prefer the POST result.
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

  const getP = wrap(
    'details_get',
    session.http.get(absPostUrl, { followRedirects: true, headers, ...httpOpts })
  );
  const postP = wrap(
    'details_postback',
    session.authedPost(postUrl, detailsBody, { headers, ...httpOpts })
  );

  return new Promise((resolve) => {
    let remaining = 2;
    /** @type {object[]} */
    const settled = [];
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const onSettle = (r) => {
      settled.push(r);
      if (isDecisive(r)) {
        log.info('confirm accept path settled first', { orderId, via: r.via, status: r.status });
        return finish(r);
      }
      if (--remaining === 0) {
        finish(settled.find((x) => x.via === 'details_postback') || settled[0]);
      }
    };
    getP.then(onSettle);
    postP.then(onSettle);
  });
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
