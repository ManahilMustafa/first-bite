// Decline Path A — decline via the DECLINE ORDER link in the order email.
//
// Mirrors emailAccept.js. Out-of-region orders are actively declined so they
// leave the user's queue. Supports the same three real-world behaviours:
//   1. Standalone GET — link declines immediately.
//   2. Two-step — GET opens an order page with a Decline/Reject button; we
//      scrape VIEWSTATE and POST the confirm.
//   3. Login bounce — the link (or the confirm postback) redirects to login.
//      If a `session` was given, we re-authenticate (login + OTP if the portal
//      challenges it) and retry the EXACT SAME request once. Only if that retry
//      also bounces (or no session is available) do we give up and report
//      `needs_login`.
import { HttpClient, formEncode } from '../util/httpClient.js';
import { buildPostback, findPostbackTarget, looksLikeLogin, scrapeFormAction } from '../portal/aspnet.js';
import { logger } from '../util/logger.js';
import { snippet } from '../portal/session.js';

const DECLINED_RE = /declined|rejected|order declined|has been declined|removed from your|no longer in your (queue|list)|success/i;
// "Already gone" is a fine terminal state for a decline — nothing left to do.
const GONE_RE = /no longer available|already (been )?(assigned|accepted)|not available|assigned to another/i;

/**
 * @param {object} opts
 * @param {string} opts.declineUrl
 * @param {HttpClient} [opts.http]
 * @param {import('../portal/session.js').PortalSession} [opts.session]
 *        enables automatic re-authentication + a single retry on a login bounce.
 * @param {RegExp} [opts.declineLabel]  label for the second-step Decline control
 * @param {object} [opts.log]
 * @returns {Promise<{ok:boolean, outcome:string, status:number, durationMs:number,
 *                     bounced:boolean, steps?:string[]}>}
 */
export async function declineViaEmailLink({
  declineUrl,
  http,
  session,
  declineLabel = /decline|reject/i,
  log = logger('decline:email'),
}) {
  if (!declineUrl) {
    return { ok: false, outcome: 'no_link', status: 0, durationMs: 0, bounced: false, reason: 'no declineUrl' };
  }

  const startedAt = process.hrtime.bigint();
  const client = http || session?.http || new HttpClient();
  const steps = [];
  let reauthed = false;
  // Wraps finish() so every return site automatically carries whether THIS
  // attempt needed a re-login/OTP, without threading it through every call site.
  const done = (result) => finish(startedAt, { ...result, reauthed, otpFetched: !!session?._lastLoginUsedOtp });

  log.info('decline attempt', { declineUrl });

  // Bounded to a single re-auth retry: this loop runs at most twice (the
  // original attempt, then one retry after a successful re-login).
  for (;;) {
    const first = await client.get(declineUrl, { followRedirects: true });
    steps.push('email_get');
    const pageUrl = first.url || declineUrl;
    const body = first.body || '';

    if (looksLikeLogin(body) || /login/i.test(first.headers?.location || '')) {
      if (session && !reauthed) {
        reauthed = true;
        if (await reauthenticate(session, log, declineUrl)) continue;
      }
      log.error('decline failed: still redirected to login', {
        declineUrl,
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
    if (GONE_RE.test(body)) {
      log.info('decline successful (already gone)', { declineUrl });
      return done({ ok: true, outcome: 'gone', status: first.status, bounced: false, steps });
    }
    if (isDeclinedResponse(body, first.status)) {
      log.info('decline successful', { declineUrl, via: 'email' });
      return done({ ok: true, outcome: 'declined', status: first.status, bounced: false, steps });
    }

    // Two-step: details page with a Decline/Reject button / postback.
    const pb = findPostbackTarget(body, declineLabel);
    if (!pb) {
      const ok = first.status >= 200 && first.status < 300;
      if (!ok) {
        log.error('decline failed: unrecognized response', { declineUrl, status: first.status, bodySnippet: snippet(body) });
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

    steps.push('details_postback');
    const postUrl = scrapeFormAction(body, pageUrl);
    const extra = { ...(pb.extra || {}) };
    if (pb.isSubmit && pb.submitValue) extra[pb.target] = pb.submitValue;
    const formBody = buildPostback(body, pb.isSubmit ? '' : pb.target, pb.argument || '', extra);
    if (!pb.isSubmit) formBody.__EVENTTARGET = pb.target;

    const second = await client.post(postUrl, formEncode(formBody), { followRedirects: true });
    const resp = second.body || '';

    if (looksLikeLogin(resp)) {
      if (session && !reauthed) {
        reauthed = true;
        if (await reauthenticate(session, log, declineUrl)) continue;
      }
      log.error('decline failed: still redirected to login on details postback', {
        declineUrl,
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
    if (GONE_RE.test(resp)) {
      log.info('decline successful (already gone)', { declineUrl });
      return done({ ok: true, outcome: 'gone', status: second.status, bounced: false, steps });
    }
    if (isDeclinedResponse(resp, second.status)) {
      log.info('decline successful', { declineUrl, via: 'email' });
      return done({ ok: true, outcome: 'declined', status: second.status, bounced: false, steps });
    }
    // Posted the decline but no explicit confirmation text — treat the 2xx as
    // submitted; the executor's verify (re-read status) is the source of truth.
    {
      const ok = second.status >= 200 && second.status < 300;
      if (!ok) {
        log.error('decline failed: unrecognized response on details postback', {
          declineUrl,
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

/**
 * Log in again (login() itself handles the OTP challenge if the portal presents
 * one) and report whether it's safe to retry the original request.
 * @returns {Promise<boolean>} true if login succeeded and the caller should retry
 */
async function reauthenticate(session, log, declineUrl) {
  log.warn('login required', { declineUrl });
  log.info('re-authenticating');
  session.authenticated = false;
  try {
    await session.login();
  } catch (e) {
    log.error('re-authentication failed', { declineUrl, err: String(e) });
    return false;
  }
  log.info('login successful — retrying decline', { declineUrl });
  return true;
}

function isDeclinedResponse(body, status) {
  return status >= 200 && status < 300 && DECLINED_RE.test(body);
}

function finish(startedAt, result) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { ...result, durationMs };
}

export default declineViaEmailLink;
