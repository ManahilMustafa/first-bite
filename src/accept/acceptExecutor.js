// Accept executor — the hot path.
//
// Given a detected order, RACE the two accept strategies and take whichever
// confirms first:
//   Path A: email-link GET (fast, if self-contained)
//   Path B: portal __doPostBack replay (robust)
// Then verify by re-reading order status (off the critical path for latency,
// but still awaited so we report a truthful outcome).
//
// Exactly-once is enforced one layer up by the lock; this module assumes it has
// already won the lock for `orderId`.
import { acceptViaEmailLink } from './emailAccept.js';
import { acceptViaPortal } from './portalAccept.js';
import { tagResult, firstSuccessOrAll } from './race.js';
import { logger } from '../util/logger.js';

/**
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {string} [opts.acceptUrl]                 email ACCEPT link (enables Path A)
 * @param {import('../portal/session.js').PortalSession} [opts.session]  enables Path B + verify
 * @param {object} [opts.portalOpts]                passed to acceptViaPortal
 * @param {(orderId:string)=>Promise<'accepted'|'taken'|'available'|'unknown'>} [opts.verify]
 * @param {object} [opts.log]
 * @returns {Promise<{accepted:boolean, via:string|null, outcome:string,
 *                    durationMs:number, paths:object, verified:string|null}>}
 */
export async function executeAccept({
  orderId,
  acceptUrl,
  session,
  portalOpts = {},
  verify,
  log = logger('accept'),
}) {
  const startedAt = process.hrtime.bigint();
  const tasks = [];

  if (acceptUrl) {
    tasks.push(
      tagResult(
        'email',
        acceptViaEmailLink({ acceptUrl, http: session?.http, session, log: log.child('email') })
      )
    );
  }
  if (session) {
    tasks.push(
      tagResult('portal', acceptViaPortal({ session, orderId, log: log.child('portal'), ...portalOpts }))
    );
  }

  if (tasks.length === 0) {
    return { accepted: false, via: null, outcome: 'no_path', durationMs: 0, paths: {}, verified: null };
  }

  // Race: resolve as soon as ANY path reports a confirmed accept; otherwise wait
  // for all to settle and pick the best outcome.
  const paths = {};
  const winner = await firstSuccessOrAll(tasks, (name, result) => {
    paths[name] = result;
    return result?.ok === true;
  });

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  let via = null;
  let outcome = 'failed';
  let accepted = false;

  if (winner?.ok) {
    accepted = true;
    via = winner.__name;
    outcome = 'accepted';
  } else {
    // No confirmed success — see if any path says it was taken by someone else.
    const taken = Object.values(paths).some((p) => p?.outcome === 'taken');
    outcome = taken ? 'taken' : (Object.values(paths).find((p) => p?.outcome)?.outcome || 'failed');
  }

  // Verify against source of truth (the portal), if a verifier is given.
  // Timed separately from the race (durationMs above) so a latency report can
  // tell "how long did winning take" apart from "how long did confirming it
  // take" — conflating the two would hide which one is actually the bottleneck.
  //
  // CRITICAL: verify must NEVER invent an accept. If every path failed before
  // clicking anything (not_found / needs_login), a flaky status-page regex used
  // to flip those into accepted:true / via:'verified' — the dashboard lied while
  // the portal never got an Accept click. Verify may confirm a real path win,
  // detect 'taken', or confirm an ambiguous post that actually landed — but not
  // promote a pure miss into a success.
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
      if (verified === 'taken') {
        accepted = false;
        outcome = 'taken';
      } else if (verified === 'accepted') {
        if (accepted || !neverActed) {
          accepted = true;
          outcome = 'accepted';
          via = via || 'verified';
        } else {
          log.warn('verify said accepted but no accept path acted — not claiming a win', {
            orderId,
            paths,
          });
        }
      }
    } catch (e) {
      log.warn('verify failed', { orderId, err: String(e) });
    } finally {
      verifyDurationMs = Number(process.hrtime.bigint() - verifyStartedAt) / 1e6;
    }
  }

  if (accepted) {
    log.info('accept result', {
      orderId,
      accepted,
      via,
      outcome,
      ms: Math.round(durationMs),
      verifyMs: Math.round(verifyDurationMs),
      verified,
    });
  } else {
    // Never let a failure disappear into a one-line summary: dump every path's
    // exact status/response so the real cause is debuggable without re-running.
    log.error('accept result: FAILED', {
      orderId,
      accepted,
      via,
      outcome,
      ms: Math.round(durationMs),
      verifyMs: Math.round(verifyDurationMs),
      verified,
      paths,
    });
  }
  return { accepted, via, outcome, durationMs, verifyDurationMs, paths, verified };
}

export default executeAccept;
