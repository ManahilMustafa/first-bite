// Decline executor — the out-of-region path.
//
// Given a detected order that fails the user's region filter, RACE the two
// decline strategies and take whichever confirms first:
//   Path A: email DECLINE-link GET (fast, if self-contained)
//   Path B: portal __doPostBack replay (robust; works for poller-detected orders)
// Then verify by re-reading order status: a decline succeeded as long as the
// order is no longer 'accepted' (assigned to us).
//
// Exactly-once is enforced one layer up by the lock; this assumes it has already
// won the lock for `orderId`.
import { declineViaEmailLink } from './emailDecline.js';
import { declineViaPortal } from './portalDecline.js';
import { tagResult, firstSuccessOrAll } from './race.js';
import { logger } from '../util/logger.js';

/**
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {string} [opts.declineUrl]                email DECLINE link (enables Path A)
 * @param {import('../portal/session.js').PortalSession} [opts.session] enables Path B + verify
 * @param {object} [opts.portalOpts]                passed to declineViaPortal
 * @param {(orderId:string)=>Promise<'accepted'|'taken'|'available'|'unknown'>} [opts.verify]
 * @param {object} [opts.log]
 * @returns {Promise<{declined:boolean, via:string|null, outcome:string,
 *                    durationMs:number, paths:object, verified:string|null}>}
 */
export async function executeDecline({
  orderId,
  declineUrl,
  session,
  portalOpts = {},
  verify,
  log = logger('decline'),
}) {
  const startedAt = process.hrtime.bigint();
  const tasks = [];

  if (declineUrl) {
    tasks.push(
      tagResult(
        'email',
        declineViaEmailLink({ declineUrl, http: session?.http, session, log: log.child('email') })
      )
    );
  }
  if (session) {
    tasks.push(
      tagResult('portal', declineViaPortal({ session, orderId, log: log.child('portal'), ...portalOpts }))
    );
  }

  if (tasks.length === 0) {
    return { declined: false, via: null, outcome: 'no_path', durationMs: 0, paths: {}, verified: null };
  }

  const paths = {};
  const winner = await firstSuccessOrAll(tasks, (name, result) => {
    paths[name] = result;
    return result?.ok === true;
  });

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  let via = null;
  let outcome = 'failed';
  let declined = false;
  // 'submitted' means a path got a 2xx but no explicit "declined"/"gone" text —
  // optimistic, NOT proof. Such a win must be confirmed by verify before we claim
  // success; an explicit 'declined'/'gone' stands on its own.
  let optimistic = false;

  if (winner?.ok) {
    via = winner.__name;
    outcome = winner.outcome || 'declined';
    optimistic = outcome === 'submitted';
    declined = !optimistic; // confirmed wins count immediately; optimistic awaits verify
  } else {
    outcome = Object.values(paths).find((p) => p?.outcome)?.outcome || 'failed';
  }

  // Verify against source of truth: a decline is good as long as the order is no
  // longer assigned to us. Only 'accepted' contradicts a successful decline.
  // Same honesty rule as accept: never invent a decline when every path failed
  // before clicking (not_found / needs_login) — "still available" on the status
  // page is NOT proof we declined it.
  let verified = null;
  let verifyDurationMs = 0;
  if (verify) {
    const verifyStartedAt = process.hrtime.bigint();
    try {
      verified = await verify(orderId);
      log.info('final portal confirmation', { orderId, verified });
      const neverActed = Object.values(paths).every(
        (p) => !p || ['not_found', 'needs_login', 'no_path'].includes(p.outcome)
      );
      if (verified === 'accepted') {
        declined = false;
        outcome = 'still_assigned';
      } else if (verified === 'available' || verified === 'taken') {
        if (declined || !neverActed) {
          declined = true;
          if (outcome === 'failed' || outcome === 'submitted') {
            outcome = verified === 'taken' ? 'gone' : 'declined';
            via = via || 'verified';
          }
        } else {
          log.warn('verify said order gone/available but no decline path acted — not claiming a decline', {
            orderId,
            verified,
            paths,
          });
        }
      }
    } catch (e) {
      log.warn('decline verify failed', { orderId, err: String(e) });
    } finally {
      verifyDurationMs = Number(process.hrtime.bigint() - verifyStartedAt) / 1e6;
    }
  }

  // An optimistic 'submitted' that verify could not confirm is NOT a success —
  // reporting declined:true here would lie about an order that may still be ours.
  // (If verify said 'accepted', outcome is already the truthful 'still_assigned'.)
  if (optimistic && !declined && (verified === null || verified === 'unknown')) {
    outcome = 'unverified';
  }

  if (declined) {
    log.info('decline result', {
      orderId,
      declined,
      via,
      outcome,
      ms: Math.round(durationMs),
      verifyMs: Math.round(verifyDurationMs),
      verified,
    });
  } else {
    log.error('decline result: FAILED', {
      orderId,
      declined,
      via,
      outcome,
      ms: Math.round(durationMs),
      verifyMs: Math.round(verifyDurationMs),
      verified,
      paths,
    });
  }
  return { declined, via, outcome, durationMs, verifyDurationMs, paths, verified };
}

export default executeDecline;
