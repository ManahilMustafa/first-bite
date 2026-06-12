// Path A — accept via the ACCEPT ORDER link embedded in the order email.
//
// Supports three real-world behaviours:
//   1. Standalone GET — link accepts immediately (~100–300ms).
//   2. Two-step — GET opens an order-details page with a green Accept button;
//      we scrape VIEWSTATE and POST the second accept (models E-Street flow).
//   3. Login bounce — link redirects to login; reports needs_login so the
//      executor can fall back to the authenticated portal path.
import { HttpClient, formEncode } from '../util/httpClient.js';
import { buildPostback, findPostbackTarget, looksLikeLogin, scrapeFormAction } from '../portal/aspnet.js';

const ACCEPTED_RE = /accepted|assigned to you|order accepted|in progress|success|thank you/i;
const TAKEN_RE = /no longer available|already (been )?(assigned|accepted)|not available|assigned to another/i;

/**
 * @param {object} opts
 * @param {string} opts.acceptUrl
 * @param {HttpClient} [opts.http]
 * @param {RegExp} [opts.acceptLabel]  label for the second-step Accept control
 * @returns {Promise<{ok:boolean, outcome:string, status:number, durationMs:number,
 *                     bounced:boolean, steps?:string[]}>}
 */
export async function acceptViaEmailLink({ acceptUrl, http, acceptLabel = /accept/i }) {
  if (!acceptUrl) {
    return { ok: false, outcome: 'unknown', status: 0, durationMs: 0, bounced: false, reason: 'no acceptUrl' };
  }

  const startedAt = process.hrtime.bigint();
  const client = http || new HttpClient();
  const steps = [];

  const first = await client.get(acceptUrl, { followRedirects: true });
  steps.push('email_get');
  const pageUrl = first.url || acceptUrl;
  const body = first.body || '';

  if (looksLikeLogin(body) || /login/i.test(first.headers?.location || '')) {
    return finish(startedAt, {
      ok: false,
      outcome: 'needs_login',
      status: first.status,
      bounced: true,
      steps,
    });
  }
  if (TAKEN_RE.test(body)) {
    return finish(startedAt, { ok: false, outcome: 'taken', status: first.status, bounced: false, steps });
  }
  if (isAcceptedResponse(body, first.status)) {
    return finish(startedAt, { ok: true, outcome: 'accepted', status: first.status, bounced: false, steps });
  }

  // Two-step: details page with a green Accept button / postback.
  const pb = findPostbackTarget(body, acceptLabel);
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
      return finish(startedAt, {
        ok: false,
        outcome: 'needs_login',
        status: second.status,
        bounced: true,
        steps,
      });
    }
    if (TAKEN_RE.test(resp)) {
      return finish(startedAt, { ok: false, outcome: 'taken', status: second.status, bounced: false, steps });
    }
    if (isAcceptedResponse(resp, second.status)) {
      return finish(startedAt, { ok: true, outcome: 'accepted', status: second.status, bounced: false, steps });
    }
    return finish(startedAt, {
      ok: second.status >= 200 && second.status < 300,
      outcome: second.status >= 200 && second.status < 300 ? 'accepted' : 'unknown',
      status: second.status,
      bounced: false,
      steps,
    });
  }

  return finish(startedAt, {
    ok: first.status >= 200 && first.status < 300,
    outcome: first.status >= 200 && first.status < 300 ? 'accepted' : 'unknown',
    status: first.status,
    bounced: false,
    steps,
  });
}

function isAcceptedResponse(body, status) {
  return status >= 200 && status < 300 && (ACCEPTED_RE.test(body) || body.length === 0);
}

function finish(startedAt, result) {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { ...result, durationMs };
}

export default acceptViaEmailLink;
