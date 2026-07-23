// Path B — accept via the portal by replaying the WebForms __doPostBack.
//
// Robust fallback / verifier. Steps:
//   1. GET the New Orders page on the warm authed session.
//   2. Scrape fresh __VIEWSTATE / __EVENTVALIDATION and locate the Accept
//      control for this order (its __doPostBack target or submit button name).
//   3. POST the postback back to the same page.
//   4. Read the response for accepted / already-taken signals.
import { buildPostback, findPostbackTarget } from '../portal/aspnet.js';

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
 */
export async function acceptViaPortal({
  session,
  orderId,
  newOrdersPath,
  acceptLabel = /accept/i,
  locateAccept,
}) {
  const path = newOrdersPath || session.routes.newOrders;

  // 1) Load the current New Orders page (fresh tokens).
  const page = await session.authedGet(path);
  const html = page.body;

  // 2) Locate the accept control for THIS order.
  let pb;
  if (locateAccept) {
    pb = locateAccept(html, orderId);
  } else {
    pb = locateAcceptForOrder(html, orderId, acceptLabel);
  }
  if (!pb) {
    return { ok: false, outcome: 'not_found', reason: `no accept control for order ${orderId}` };
  }

  // 3) Build + post the postback.
  const extra = { ...(pb.extra || {}) };
  if (pb.isSubmit && pb.submitValue) extra[pb.target] = pb.submitValue;
  const body = buildPostback(html, pb.isSubmit ? '' : pb.target, pb.argument || '', extra);
  if (!pb.isSubmit) body.__EVENTTARGET = pb.target;

  const res = await session.authedPost(path, body);
  const resp = res.body || '';

  if (TAKEN_RE.test(resp)) {
    return { ok: false, outcome: 'taken', status: res.status, durationMs: res.durationMs };
  }
  if (ACCEPTED_RE.test(resp) || (res.status >= 200 && res.status < 300)) {
    return { ok: true, outcome: 'accepted', status: res.status, durationMs: res.durationMs };
  }
  return { ok: false, outcome: 'unknown', status: res.status, durationMs: res.durationMs };
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
