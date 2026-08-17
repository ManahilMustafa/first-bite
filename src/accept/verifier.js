// Order-status verifier — reads the portal to confirm an accept landed.
// Returns 'accepted' | 'taken' | 'available' | 'unknown'.
//
// Dashboard "Accepted" must only follow a real portal confirmation. The default
// status URL is often wrong on E-Street, so we also:
//   1) inspect the New Orders row (still has Accept tick? → available)
//   2) open In Progress Orders when possible and look for the order near
//      "Accepted by Vendor" / "In Progress" / "File In Review"
import {
  buildControlClick,
  findPostbackTarget,
} from '../portal/aspnet.js';
import { looksAccepted, looksAvailable, looksTaken } from './signals.js';

// Each GET/POST here defaults to the HttpClient's full 10s timeout, and
// authedGet/authedPost retry once on timeout — so a single verify() call
// could silently cost up to ~40s (status + newOrders + inProgress, each up
// to 2x10s) before ever reaching acceptExecutor's own verifyWithRetries loop,
// which then calls verify() again up to 3 more times. Production evidence:
// portal-source verify duration p50 ~10s, max ~15.7s. Bound each request
// instead — a timeout here still gets its one retry (an actual answer beats
// a fast 'unknown', which the dashboard treats as an under-report), it's
// just not allowed to eat the whole hot path.
function resolveVerifyTimeoutMs() {
  const n = Number(process.env.VERIFY_HTTP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2500;
}

/**
 * @param {import('../portal/session.js').PortalSession} session
 * @returns {(orderId:string)=>Promise<'accepted'|'taken'|'available'|'unknown'>}
 */
export function makePortalVerifier(session) {
  return async function verify(orderId) {
    if (!orderId) return 'unknown';
    const timeoutMs = resolveVerifyTimeoutMs();

    // 1) Dedicated status route (when the portal actually implements it).
    if (typeof session.routes?.status === 'function') {
      try {
        const res = await session.authedGet(session.routes.status(orderId), { timeoutMs });
        const hit = classifyStatusHtml(res.body || '', orderId);
        if (hit) return hit;
      } catch {
        /* fall through */
      }
    }

    // 2) New Orders — if our Accept tick is still there, we did NOT win.
    try {
      const page = await session.authedGet(session.routes.newOrders, { timeoutMs });
      const html = page.body || '';
      const onNew = classifyNearOrder(html, orderId);
      if (onNew === 'available') return 'available';
      if (onNew === 'taken') return 'taken';
      if (onNew === 'accepted') return 'accepted';

      // 3) Order left New Orders → check In Progress list (real E-Street home).
      if (!html.includes(orderId)) {
        const inProg = await fetchInProgressHtml(session, html, timeoutMs);
        if (inProg) {
          const hit = classifyNearOrder(inProg, orderId);
          if (hit) return hit;
          // Whole-page accepted signals only when the order id is present.
          if (inProg.includes(orderId) && looksAccepted(inProg) && !looksTaken(inProg)) {
            return 'accepted';
          }
        }
      }
    } catch {
      /* ignore */
    }

    return 'unknown';
  };
}

/**
 * Classify a status/details page body.
 * @returns {'accepted'|'taken'|'available'|null}
 */
export function classifyStatusHtml(body, orderId) {
  if (looksTaken(body)) return 'taken';
  if (looksAccepted(body)) return 'accepted';
  if (looksAvailable(body)) return 'available';
  return classifyNearOrder(body, orderId);
}

/**
 * Look at a window around the order id (row / card), not the whole page nav.
 * @returns {'accepted'|'taken'|'available'|null}
 */
export function classifyNearOrder(html, orderId) {
  if (!html || !orderId) return null;
  const idx = html.indexOf(orderId);
  if (idx === -1) return null;
  const win = html.slice(idx, idx + 3500);
  if (/assigned to another|no longer available|reassigned/i.test(win)) return 'taken';
  // Still on the broadcast list with an Accept control → not ours yet.
  if (/imgBtnBroadcastAccept|BroadcastAccept/i.test(win)) return 'available';
  if (
    /accepted by vendor|accepted by you|assigned to you|\bfile in review\b|\bin progress\b/i.test(
      win
    )
  ) {
    return 'accepted';
  }
  return null;
}

/** Best-effort: post the "In Progress Orders" nav link from the current page. */
async function fetchInProgressHtml(session, newOrdersHtml, timeoutMs) {
  const pb =
    findPostbackTarget(newOrdersHtml, /in\s*progress\s*orders/i) ||
    findPostbackTarget(newOrdersHtml, /show\s*in\s*progress/i);
  if (!pb) return null;
  const tgt = pb.target || '';
  if (!/InProgress|ShowInProgress|inprogress/i.test(tgt)) return null;
  try {
    const body = buildControlClick(newOrdersHtml, pb);
    const res = await session.authedPost(session.routes.newOrders, body, { timeoutMs });
    return res.body || '';
  } catch {
    return null;
  }
}

export default makePortalVerifier;
