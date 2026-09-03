// Path A — accept via the ACCEPT ORDER link embedded in the order email.
//
// Real E-Street Gmail flow (owner-confirmed):
//   1. GET the green ACCEPT ORDER link → confirmation page.
//   2. Click green "Accept Order" (not "Accept Appraisal" — that is portal).
//   3. Loading, then EITHER a green acceptance badge OR the same no-banner
//      "Manage Order" detail page the portal path can land on (owner-
//      confirmed 2026-09-03: neither page is exclusive to one path) — see
//      classifyNearOrder in verifier.js for the order-detail-page match.
//
// Also supports: standalone GET accept, login bounce + one re-auth retry.
import { HttpClient, formEncode } from '../util/httpClient.js';
import {
  buildControlClick,
  findPostbackTarget,
  looksLikeLogin,
  scrapeFormActionForControl,
} from '../portal/aspnet.js';
import { logger } from '../util/logger.js';
import { snippet } from '../portal/session.js';
import { dumpAcceptDiagnostic } from './diagnostic.js';
import { findConfirmAcceptControl, looksAccepted, looksLikePortalError, looksTaken } from './signals.js';
import { classifyNearOrder } from './verifier.js';

/**
 * @param {object} opts
 * @param {string} opts.acceptUrl
 * @param {HttpClient} [opts.http]
 * @param {import('../portal/session.js').PortalSession} [opts.session]
 * @param {RegExp} [opts.acceptLabel]  unused unless prefer fails — prefer "Accept Order"
 * @param {object} [opts.log]
 */
export async function acceptViaEmailLink({
  acceptUrl,
  http,
  session,
  acceptLabel,
  log = logger('accept:email'),
}) {
  if (!acceptUrl) {
    return { ok: false, outcome: 'unknown', status: 0, durationMs: 0, bounced: false, reason: 'no acceptUrl' };
  }

  const startedAt = process.hrtime.bigint();
  const client = http || session?.http || new HttpClient();
  const steps = [];
  let reauthed = false;
  const done = (result) => finish(startedAt, { ...result, reauthed, otpFetched: !!session?._lastLoginUsedOtp });

  log.info('accept attempt', { acceptUrl });
  const orderId = orderIdFromUrl(acceptUrl);

  for (;;) {
    const first = await client.get(acceptUrl, { followRedirects: true });
    steps.push('email_get');
    const pageUrl = first.url || acceptUrl;
    const body = first.body || '';

    if (looksLikeLogin(body) || /login/i.test(first.headers?.location || '')) {
      if (session && !reauthed) {
        reauthed = true;
        if (await reauthenticate(session, log, acceptUrl)) continue;
      }
      log.error('accept failed: still redirected to login', {
        acceptUrl,
        retried: reauthed,
        status: first.status,
        bodySnippet: snippet(body),
      });
      return done({
        ok: false,
        outcome: 'needs_login',
        status: first.status,
        bounced: true,
        steps,
        bodySnippet: snippet(body),
      });
    }
    if (looksTaken(body)) {
      return done({ ok: false, outcome: 'taken', status: first.status, bounced: false, steps });
    }
    if (isAcceptedResponse(body, first.status, orderId)) {
      log.info('accept successful', { acceptUrl, via: 'email', steps });
      return done({ ok: true, outcome: 'accepted', status: first.status, bounced: false, steps });
    }

    // Confirmation page: prefer "Accept Order" (Gmail path), then Appraisal, then any Accept.
    let pb = findConfirmAcceptControl(body, 'order');
    if (!pb && acceptLabel) {
      pb = findPostbackTarget(body, acceptLabel);
    }
    if (!pb) {
      dumpAcceptDiagnostic({ orderId, stage: 'email_no_accept_btn', html: body, url: pageUrl });
      // No confirm button and not a recognized badge — before assuming
      // 'submitted'/'unknown', check whether we actually landed straight on
      // the no-banner order-detail page (owner-confirmed 2026-09-03: the
      // portal path shows this instead of a badge; the email path can too).
      if (classifyNearOrder(body, orderId) === 'accepted') {
        log.info('accept successful', { acceptUrl, via: 'email', steps, matched: 'order-detail page' });
        return done({ ok: true, outcome: 'accepted', status: first.status, bounced: false, steps });
      }
      const ok = first.status >= 200 && first.status < 300;
      if (!ok) {
        log.error('accept failed: unrecognized response', { acceptUrl, status: first.status, bodySnippet: snippet(body) });
      }
      return done({
        ok,
        outcome: ok ? 'submitted' : 'unknown',
        status: first.status,
        bounced: false,
        steps,
        bodySnippet: ok ? undefined : snippet(body),
      });
    }

    dumpAcceptDiagnostic({ orderId: orderIdFromUrl(acceptUrl), stage: 'email_confirm_page', html: body, url: pageUrl });
    steps.push('details_postback');
    const postUrl = scrapeFormActionForControl(body, pageUrl, pb.target);
    const formBody = buildControlClick(body, pb);

    const second = await client.post(postUrl, formEncode(formBody), { followRedirects: true });
    const resp = second.body || '';

    if (looksLikeLogin(resp)) {
      if (session && !reauthed) {
        reauthed = true;
        if (await reauthenticate(session, log, acceptUrl)) continue;
      }
      log.error('accept failed: still redirected to login on details postback', {
        acceptUrl,
        retried: reauthed,
        status: second.status,
        bodySnippet: snippet(resp),
      });
      return done({
        ok: false,
        outcome: 'needs_login',
        status: second.status,
        bounced: true,
        steps,
        bodySnippet: snippet(resp),
      });
    }
    if (looksTaken(resp)) {
      return done({ ok: false, outcome: 'taken', status: second.status, bounced: false, steps });
    }
    if (looksLikePortalError(resp, second.url || postUrl)) {
      dumpAcceptDiagnostic({
        orderId: orderIdFromUrl(acceptUrl),
        stage: 'email_post_accept_error',
        html: resp,
        url: second.url || postUrl,
      });
      log.error('accept failed: portal Error.aspx after email Accept Order', {
        acceptUrl,
        status: second.status,
        bodySnippet: snippet(resp),
      });
      return done({
        ok: false,
        outcome: 'portal_error',
        status: second.status,
        bounced: false,
        steps,
        bodySnippet: snippet(resp),
      });
    }
    if (isAcceptedResponse(resp, second.status, orderId)) {
      log.info('accept successful', { acceptUrl, via: 'email', steps });
      return done({ ok: true, outcome: 'accepted', status: second.status, bounced: false, steps });
    }

    dumpAcceptDiagnostic({
      orderId,
      stage: 'email_post_accept',
      html: resp,
      url: second.url || postUrl,
    });
    // Same no-banner order-detail check as the first-GET branch above.
    if (classifyNearOrder(resp, orderId) === 'accepted') {
      log.info('accept successful', { acceptUrl, via: 'email', steps, matched: 'order-detail page' });
      return done({ ok: true, outcome: 'accepted', status: second.status, bounced: false, steps });
    }
    {
      const ok = second.status >= 200 && second.status < 300;
      if (!ok) {
        log.error('accept failed: unrecognized response on details postback', {
          acceptUrl,
          status: second.status,
          bodySnippet: snippet(resp),
        });
      }
      return done({
        ok,
        outcome: ok ? 'submitted' : 'unknown',
        status: second.status,
        bounced: false,
        steps,
        bodySnippet: ok ? undefined : snippet(resp),
      });
    }
  }
}

async function reauthenticate(session, log, acceptUrl) {
  log.warn('login required', { acceptUrl });
  log.info('re-authenticating');
  session.authenticated = false;
  try {
    await session.login();
  } catch (e) {
    log.error('re-authentication failed', { acceptUrl, err: String(e) });
    return false;
  }
  log.info('login successful — retrying accept', { acceptUrl });
  return true;
}

function isAcceptedResponse(body, status, orderId) {
  return status >= 200 && status < 300 && (looksAccepted(body) || classifyNearOrder(body, orderId) === 'accepted');
}

function orderIdFromUrl(url) {
  const m = String(url || '').match(/(\d{2,4}-\d{4,6})/);
  return m ? m[1] : 'email';
}

function finish(startedAt, result) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { ...result, durationMs };
}

export default acceptViaEmailLink;
