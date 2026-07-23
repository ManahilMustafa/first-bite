// Path A — accept via the ACCEPT ORDER link embedded in the order email.
//
// Supports three real-world behaviours:
//   1. Standalone GET — link accepts immediately (~100–300ms).
//   2. Two-step — GET opens an order-details page with a green Accept button;
//      we scrape VIEWSTATE and POST the second accept (models E-Street flow).
//   3. Login bounce — the link (or the details postback) redirects to login.
//      If a `session` was given, we re-authenticate (login + OTP if the portal
//      challenges it) and retry the EXACT SAME request once. Only if that retry
//      also bounces (or no session is available) do we give up and report
//      `needs_login`.
import { HttpClient, formEncode } from '../util/httpClient.js';
import { buildPostback, findPostbackTarget, looksLikeLogin, scrapeFormAction } from '../portal/aspnet.js';
import { logger } from '../util/logger.js';
import { snippet } from '../portal/session.js';

const ACCEPTED_RE = /accepted|assigned to you|order accepted|in progress|success|thank you/i;
const TAKEN_RE = /no longer available|already (been )?(assigned|accepted)|not available|assigned to another/i;

/**
 * @param {object} opts
 * @param {string} opts.acceptUrl
 * @param {HttpClient} [opts.http]
 * @param {import('../portal/session.js').PortalSession} [opts.session]
 *        enables automatic re-authentication + a single retry on a login bounce.
 *        Without it, a bounce is reported as `needs_login` immediately (no way
 *        to log in).
 * @param {RegExp} [opts.acceptLabel]  label for the second-step Accept control
 * @param {object} [opts.log]
 * @returns {Promise<{ok:boolean, outcome:string, status:number, durationMs:number,
 *                     bounced:boolean, steps?:string[]}>}
 */
export async function acceptViaEmailLink({
  acceptUrl,
  http,
  session,
  acceptLabel = /accept/i,
  log = logger('accept:email'),
}) {
  if (!acceptUrl) {
    return { ok: false, outcome: 'unknown', status: 0, durationMs: 0, bounced: false, reason: 'no acceptUrl' };
  }

  const startedAt = process.hrtime.bigint();
  const client = http || session?.http || new HttpClient();
  const steps = [];
  let reauthed = false;
  // Wraps finish() so every return site automatically carries whether THIS
  // attempt needed a re-login/OTP, without threading it through every call site.
  const done = (result) => finish(startedAt, { ...result, reauthed, otpFetched: !!session?._lastLoginUsedOtp });

  log.info('accept attempt', { acceptUrl });

  // Bounded to a single re-auth retry: this loop runs at most twice (the
  // original attempt, then one retry after a successful re-login).
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
    if (TAKEN_RE.test(body)) {
      return done({ ok: false, outcome: 'taken', status: first.status, bounced: false, steps });
    }
    if (isAcceptedResponse(body, first.status)) {
      log.info('accept successful', { acceptUrl, via: 'email' });
      return done({ ok: true, outcome: 'accepted', status: first.status, bounced: false, steps });
    }

    // Two-step: details page with a green Accept button / postback.
    const pb = findPostbackTarget(body, acceptLabel);
    if (!pb) {
      const ok = first.status >= 200 && first.status < 300;
      if (!ok) {
        log.error('accept failed: unrecognized response', { acceptUrl, status: first.status, bodySnippet: snippet(body) });
      }
      return done({
        ok,
        outcome: ok ? 'accepted' : 'unknown',
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
    if (TAKEN_RE.test(resp)) {
      return done({ ok: false, outcome: 'taken', status: second.status, bounced: false, steps });
    }
    if (isAcceptedResponse(resp, second.status)) {
      log.info('accept successful', { acceptUrl, via: 'email' });
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
        outcome: ok ? 'accepted' : 'unknown',
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

function isAcceptedResponse(body, status) {
  return status >= 200 && status < 300 && (ACCEPTED_RE.test(body) || body.length === 0);
}

function finish(startedAt, result) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { ...result, durationMs };
}

export default acceptViaEmailLink;
