// Decline Path A — decline via the DECLINE ORDER link in the order email.
//
// Mirrors emailAccept.js. Out-of-region orders are actively declined so they
// leave the user's queue. Supports the same three real-world behaviours:
//   1. Standalone GET — link declines immediately.
//   2. Two-step — GET opens an order page with a Decline/Reject button; we
//      scrape VIEWSTATE and POST the confirm.
//   3. Login bounce — reports needs_login so the executor can fall back to the
//      authenticated portal decline.
import { HttpClient, formEncode } from '../util/httpClient.js';
import { buildPostback, findPostbackTarget, looksLikeLogin, scrapeFormAction } from '../portal/aspnet.js';

const DECLINED_RE = /declined|rejected|order declined|has been declined|removed from your|no longer in your (queue|list)|success/i;
// "Already gone" is a fine terminal state for a decline — nothing left to do.
const GONE_RE = /no longer available|already (been )?(assigned|accepted)|not available|assigned to another/i;

/**
 * @param {object} opts
 * @param {string} opts.declineUrl
 * @param {HttpClient} [opts.http]
 * @param {RegExp} [opts.declineLabel]  label for the second-step Decline control
 * @returns {Promise<{ok:boolean, outcome:string, status:number, durationMs:number,
 *                     bounced:boolean, steps?:string[]}>}
 */
export async function declineViaEmailLink({ declineUrl, http, declineLabel = /decline|reject/i }) {
  if (!declineUrl) {
    return { ok: false, outcome: 'no_link', status: 0, durationMs: 0, bounced: false, reason: 'no declineUrl' };
  }

  const startedAt = process.hrtime.bigint();
  const client = http || new HttpClient();
  const steps = [];

  const first = await client.get(declineUrl, { followRedirects: true });
  steps.push('email_get');
  const pageUrl = first.url || declineUrl;
  const body = first.body || '';

  if (looksLikeLogin(body) || /login/i.test(first.headers?.location || '')) {
    return finish(startedAt, { ok: false, outcome: 'needs_login', status: first.status, bounced: true, steps });
  }
  if (GONE_RE.test(body)) {
    return finish(startedAt, { ok: true, outcome: 'gone', status: first.status, bounced: false, steps });
  }
  if (isDeclinedResponse(body, first.status)) {
    return finish(startedAt, { ok: true, outcome: 'declined', status: first.status, bounced: false, steps });
  }

  // Two-step: details page with a Decline/Reject button / postback.
  const pb = findPostbackTarget(body, declineLabel);
  if (pb) {
    steps.push('details_postback');
    const postUrl = scrapeFormAction(body, pageUrl);
    const extra = { ...(pb.extra || {}) };
    if (pb.isSubmit && pb.submitValue) extra[pb.target] = pb.submitValue;
    const formBody = buildPostback(body, pb.isSubmit ? '' : pb.target, pb.argument || '', extra);
    if (!pb.isSubmit) formBody.__EVENTTARGET = pb.target;

    const second = await client.post(postUrl, formEncode(formBody), { followRedirects: true });
    const resp = second.body || '';

    if (looksLikeLogin(resp)) {
      return finish(startedAt, { ok: false, outcome: 'needs_login', status: second.status, bounced: true, steps });
    }
    if (GONE_RE.test(resp)) {
      return finish(startedAt, { ok: true, outcome: 'gone', status: second.status, bounced: false, steps });
    }
    if (isDeclinedResponse(resp, second.status)) {
      return finish(startedAt, { ok: true, outcome: 'declined', status: second.status, bounced: false, steps });
    }
    // Posted the decline but no explicit confirmation text — treat the 2xx as
    // submitted; the executor's verify (re-read status) is the source of truth.
    return finish(startedAt, {
      ok: second.status >= 200 && second.status < 300,
      outcome: second.status >= 200 && second.status < 300 ? 'submitted' : 'unknown',
      status: second.status,
      bounced: false,
      steps,
    });
  }

  return finish(startedAt, {
    ok: first.status >= 200 && first.status < 300,
    outcome: first.status >= 200 && first.status < 300 ? 'submitted' : 'unknown',
    status: first.status,
    bounced: false,
    steps,
  });
}

function isDeclinedResponse(body, status) {
  return status >= 200 && status < 300 && DECLINED_RE.test(body);
}

function finish(startedAt, result) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { ...result, durationMs };
}

export default declineViaEmailLink;
