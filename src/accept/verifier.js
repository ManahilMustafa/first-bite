// Order-status verifier — reads the source of truth (the portal) to confirm an
// accept actually landed. Used by the executor after the race, and standalone
// for reconciliation. Returns 'accepted' | 'taken' | 'available' | 'unknown'.
//
// IMPORTANT: these patterns must NOT match nav chrome / menu link ids. The real
// E-Street dashboard has links like `lnkCondAcceptedOrders` and
// `lnkShowInProgressOrders` — a naive /accepted|in progress/i match on any page
// falsely reports every order as accepted (the 2026-07-21 production lie).
const ACCEPTED_RE =
  /\b(?:order\s+\S+\s+)?(?:accepted by vendor|accepted by you|assigned to you)\b|\bstatus:\s*in progress\b|\bin progress\.\s*$/im;
const TAKEN_RE =
  /\bassigned to (?:another|other)(?:\s+vendor)?\b|\bno longer available\b|\breassigned\b/i;
const AVAILABLE_RE = /\b(?:available|pending acceptance|awaiting(?:\s+acceptance)?)\b/i;

/**
 * @param {import('../portal/session.js').PortalSession} session
 * @returns {(orderId:string)=>Promise<'accepted'|'taken'|'available'|'unknown'>}
 */
export function makePortalVerifier(session) {
  return async function verify(orderId) {
    if (!session.routes.status) return 'unknown';
    try {
      const res = await session.authedGet(session.routes.status(orderId));
      const body = res.body || '';
      // Prefer taken over accepted: a page that mentions both (e.g. nav + body)
      // must not invent a win for us.
      if (TAKEN_RE.test(body)) return 'taken';
      if (ACCEPTED_RE.test(body)) return 'accepted';
      if (AVAILABLE_RE.test(body)) return 'available';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

export default makePortalVerifier;
