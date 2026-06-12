// Order-status verifier — reads the source of truth (the portal) to confirm an
// accept actually landed. Used by the executor after the race, and standalone
// for reconciliation. Returns 'accepted' | 'taken' | 'available' | 'unknown'.
const ACCEPTED_RE = /accepted|assigned to you|in progress|accepted by vendor/i;
const TAKEN_RE = /assigned to (another|other)|no longer available|taken|reassigned/i;
const AVAILABLE_RE = /available|new order|pending acceptance|awaiting/i;

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
      if (ACCEPTED_RE.test(body)) return 'accepted';
      if (TAKEN_RE.test(body)) return 'taken';
      if (AVAILABLE_RE.test(body)) return 'available';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

export default makePortalVerifier;
