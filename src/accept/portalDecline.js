// Decline Path B — decline via the portal by replaying the WebForms __doPostBack.
//
// Robust fallback when the email DECLINE link bounces to login, and the only
// path available when an out-of-region order was detected by the portal poller
// (which has no email link). Mirrors portalAccept.js:
//   1. GET the New Orders page on the warm authed session.
//   2. Scrape fresh __VIEWSTATE / __EVENTVALIDATION and locate the Decline
//      control for this order.
//   3. POST the postback and read accepted/declined/gone signals.
import { buildPostback, findPostbackTarget } from '../portal/aspnet.js';

const DECLINED_RE = /declined|rejected|order declined|has been declined|removed from your/i;
const GONE_RE = /no longer available|already (been )?(assigned|accepted)|not available|assigned to another/i;

/**
 * @param {object} opts
 * @param {import('../portal/session.js').PortalSession} opts.session
 * @param {string} opts.orderId
 * @param {string} [opts.newOrdersPath]
 * @param {RegExp} [opts.declineLabel]  text/value identifying the Decline control
 * @param {(html:string, orderId:string)=>object|null} [opts.locateDecline]
 */
export async function declineViaPortal({
  session,
  orderId,
  newOrdersPath,
  declineLabel = /decline|reject/i,
  locateDecline,
}) {
  const path = newOrdersPath || session.routes.newOrders;

  const page = await session.authedGet(path);
  const html = page.body;

  const pb = locateDecline
    ? locateDecline(html, orderId)
    : locateControlForOrder(html, orderId, declineLabel);
  if (!pb) {
    // No decline control — the order may already be gone from the list.
    return { ok: false, outcome: 'not_found', reason: `no decline control for order ${orderId}` };
  }

  const extra = { ...(pb.extra || {}) };
  if (pb.isSubmit && pb.submitValue) extra[pb.target] = pb.submitValue;
  const body = buildPostback(html, pb.isSubmit ? '' : pb.target, pb.argument || '', extra);
  if (!pb.isSubmit) body.__EVENTTARGET = pb.target;

  const res = await session.authedPost(path, body);
  const resp = res.body || '';

  if (GONE_RE.test(resp)) {
    return { ok: true, outcome: 'gone', status: res.status, durationMs: res.durationMs };
  }
  if (DECLINED_RE.test(resp)) {
    return { ok: true, outcome: 'declined', status: res.status, durationMs: res.durationMs };
  }
  if (res.status >= 200 && res.status < 300) {
    return { ok: true, outcome: 'submitted', status: res.status, durationMs: res.durationMs };
  }
  return { ok: false, outcome: 'unknown', status: res.status, durationMs: res.durationMs };
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
