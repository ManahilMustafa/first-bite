// Accept executor — the hot path.
//
// Two modes:
//   1. executeAcceptFast() — FIRE-AND-FORGET: builds the accept POST body from
//      the prefetched page synchronously and fires it WITHOUT awaiting the
//      response. Returns in <10ms. All follow-up work (parsing the response,
//      verifying, recording) is the caller's job (via the deferred queue).
//
//   2. executeAccept() — FULL: the original race-both-paths-and-verify flow,
//      kept for backwards compatibility and for the deferred settlement phase.
//
// Dashboard "Accepted" is driven by result.accepted — that flag must only be
// true when we have real portal proof (or a hard path success that verify
// corroborates). Soft/optimistic wins never become accepted:true alone.
import { acceptViaEmailLink } from './emailAccept.js';
import { acceptViaPortal, locateAcceptForOrder } from './portalAccept.js';
import { tagResult, firstSuccessOrAll } from './race.js';
import { buildControlClick } from '../portal/aspnet.js';
import { logger } from '../util/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// FAST MODE — fire-and-forget accept (<10ms)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the accept POST body synchronously from prefetched HTML and fire the
 * POST to the portal WITHOUT awaiting the response. Returns in <10ms.
 *
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {import('../portal/session.js').PortalSession} opts.session
 * @param {{body:string, url?:string}} [opts.prefetchedPage]
 * @param {string} [opts.acceptUrl]  email ACCEPT link (fires a parallel GET)
 * @param {object} [opts.log]
 * @returns {{ fired: boolean, portalPromise?: Promise, emailPromise?: Promise,
 *             reason?: string, firedAt: number }}
 */
export function executeAcceptFast({
  orderId,
  session,
  prefetchedPage,
  acceptUrl,
  log = logger('accept:fast'),
}) {
  const firedAt = Date.now();

  // ── Portal accept POST (Path B — primary) ──
  let portalPromise = null;
  if (session && prefetchedPage?.body) {
    const html = prefetchedPage.body;
    const pb = locateAcceptForOrder(html, orderId);
    if (pb) {
      const body = buildControlClick(html, pb);
      const path = session.routes.newOrders;
      const url = session.url(path);
      const formBody = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) formBody.append(k, v ?? '');

      // FIRE — bypass the exclusive gate for maximum speed.
      // This POST is in-flight to the portal; we don't await the response.
      portalPromise = session.http.post(url, formBody.toString(), {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          referer: url,
        },
        followRedirects: true,
      }).catch((e) => ({ ok: false, outcome: 'error', error: String(e), status: 0, body: '' }));

      log.info('accept POST FIRED', { orderId, via: 'portal', url });
    } else {
      log.warn('no accept control found in prefetched page', { orderId });
    }
  }

  // ── Email link GET (Path A — parallel) ──
  let emailPromise = null;
  if (acceptUrl && session?.http) {
    emailPromise = session.http.get(acceptUrl, { followRedirects: true })
      .catch((e) => ({ ok: false, outcome: 'error', error: String(e), status: 0, body: '' }));
    log.info('accept GET FIRED', { orderId, via: 'email' });
  }

  if (!portalPromise && !emailPromise) {
    return { fired: false, reason: 'no_accept_path', firedAt };
  }

  return { fired: true, portalPromise, emailPromise, firedAt };
}

/**
 * Settle a fire-and-forget accept: await the in-flight responses, parse the
 * outcome, optionally verify against the portal, and return a full result.
 * Called from the deferred queue AFTER the hot path has already returned.
 *
 * @param {object} opts
 * @param {object} opts.fired  return value from executeAcceptFast()
 * @param {string} opts.orderId
 * @param {(orderId:string)=>Promise<'accepted'|'taken'|'available'|'unknown'>} [opts.verify]
 * @param {object} [opts.log]
 * @returns {Promise<{accepted:boolean, via:string|null, outcome:string, durationMs:number,
 *                     verifyDurationMs:number, verified:string|null, paths:object}>}
 */
export async function settleAcceptResult({
  fired,
  orderId,
  verify,
  log = logger('accept:settle'),
}) {
  const startedAt = process.hrtime.bigint();
  const paths = {};

  // Await portal response
  if (fired.portalPromise) {
    try {
      const res = await fired.portalPromise;
      const body = res?.body || '';
      const { looksAccepted, looksTaken } = await import('./signals.js');
      if (looksAccepted(body)) {
        paths.portal = { ok: true, outcome: 'accepted', status: res.status };
      } else if (looksTaken(body)) {
        paths.portal = { ok: false, outcome: 'taken', status: res.status };
      } else if (res.status >= 200 && res.status < 300 && orderId && !body.includes(orderId)) {
        paths.portal = { ok: true, outcome: 'submitted', status: res.status };
      } else {
        paths.portal = { ok: false, outcome: res.error ? 'error' : 'unknown', status: res.status };
      }
    } catch (e) {
      paths.portal = { ok: false, outcome: 'error', error: String(e) };
    }
  }

  // Await email response
  if (fired.emailPromise) {
    try {
      const res = await fired.emailPromise;
      const body = res?.body || '';
      const { looksAccepted, looksTaken } = await import('./signals.js');
      if (looksAccepted(body)) {
        paths.email = { ok: true, outcome: 'accepted', status: res.status };
      } else if (looksTaken(body)) {
        paths.email = { ok: false, outcome: 'taken', status: res.status };
      } else if (res.status >= 200 && res.status < 300) {
        paths.email = { ok: true, outcome: 'submitted', status: res.status };
      } else {
        paths.email = { ok: false, outcome: res.error ? 'error' : 'unknown', status: res.status };
      }
    } catch (e) {
      paths.email = { ok: false, outcome: 'error', error: String(e) };
    }
  }

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  // Determine winner
  let via = null;
  let outcome = 'failed';
  let accepted = false;

  const winner = Object.entries(paths).find(([, p]) => p.ok && p.outcome === 'accepted');
  const submitted = Object.entries(paths).find(([, p]) => p.ok && p.outcome === 'submitted');
  const taken = Object.entries(paths).find(([, p]) => p.outcome === 'taken');

  if (winner) {
    via = winner[0];
    outcome = 'accepted';
    accepted = true;
  } else if (submitted) {
    via = submitted[0];
    outcome = 'submitted';
  } else if (taken) {
    outcome = 'taken';
  }

  // Verify
  let verified = null;
  let verifyDurationMs = 0;
  if (verify) {
    const verifyStartedAt = process.hrtime.bigint();
    try {
      verified = await verify(orderId);
      if (verified === 'taken') { accepted = false; outcome = 'taken'; }
      else if (verified === 'available') { accepted = false; outcome = 'still_available'; }
      else if (verified === 'accepted') { accepted = true; outcome = 'accepted'; via = via || 'verified'; }
      else if (!accepted) { outcome = outcome === 'submitted' ? 'unverified' : outcome; }
    } catch (e) {
      log.warn('verify failed', { orderId, err: String(e) });
      if (outcome === 'submitted') outcome = 'unverified';
    } finally {
      verifyDurationMs = Number(process.hrtime.bigint() - verifyStartedAt) / 1e6;
    }
  } else if (outcome === 'submitted') {
    // No verifier — trust the optimistic submit
    accepted = true;
    outcome = 'accepted';
  }

  const totalSettleMs = Date.now() - fired.firedAt;
  log.info('accept settled', { orderId, accepted, via, outcome, settleMs: Math.round(totalSettleMs), verified });

  return { accepted, via, outcome, durationMs, verifyDurationMs, paths, verified };
}

// ─────────────────────────────────────────────────────────────────────────────
// FULL MODE — original race-and-verify (backwards compatible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.orderId
 * @param {string} [opts.acceptUrl]
 * @param {import('../portal/session.js').PortalSession} [opts.session]
 * @param {object} [opts.portalOpts]
 * @param {(orderId:string)=>Promise<'accepted'|'taken'|'available'|'unknown'>} [opts.verify]
 * @param {()=>void} [opts.onAfterRace]  called once accept paths have settled,
 *        before verify — lets the worker release the poller hold so detection
 *        continues while verify (reporting only) runs.
 * @param {object} [opts.log]
 */
export async function executeAccept({
  orderId,
  acceptUrl,
  session,
  portalOpts = {},
  verify,
  onAfterRace,
  log = logger('accept'),
  portalAcceptFn = acceptViaPortal,
  emailAcceptFn = acceptViaEmailLink,
}) {
  const startedAt = process.hrtime.bigint();
  const tasks = [];

  if (acceptUrl) {
    tasks.push(
      tagResult(
        'email',
        emailAcceptFn({ acceptUrl, http: session?.http, session, log: log.child('email') })
      )
    );
  }
  if (session) {
    tasks.push(
      tagResult('portal', portalAcceptFn({ session, orderId, log: log.child('portal'), ...portalOpts }))
    );
  }

  if (tasks.length === 0) {
    return { accepted: false, via: null, outcome: 'no_path', durationMs: 0, paths: {}, verified: null };
  }

  const paths = {};
  const winner = await firstSuccessOrAll(tasks, (name, result) => {
    paths[name] = result;
    return result?.ok === true;
  });
  // Winner may resolve early; wait for the loser so the session is quiet before
  // we hand the poller back / start verify.
  await Promise.all(tasks);

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  try {
    onAfterRace?.();
  } catch (e) {
    log.warn('onAfterRace threw', { orderId, err: String(e) });
  }

  let via = null;
  let outcome = 'failed';
  let accepted = false;
  let optimistic = false;

  if (winner?.ok) {
    via = winner.__name;
    outcome = winner.outcome || 'accepted';
    optimistic = outcome === 'submitted';
    // Provisional only — verify below must allow a dashboard win.
    accepted = !optimistic;
    if (!optimistic) outcome = 'accepted';
  } else {
    const taken = Object.values(paths).some((p) => p?.outcome === 'taken');
    outcome = taken ? 'taken' : (Object.values(paths).find((p) => p?.outcome)?.outcome || 'failed');
  }

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
      const pathHardWin = !!(winner?.ok && winner.outcome === 'accepted');

      if (verified === 'taken') {
        accepted = false;
        outcome = 'taken';
      } else if (verified === 'available') {
        if (accepted || optimistic) {
          log.warn('path claimed accept but portal still shows available — not claiming a win', {
            orderId,
            paths,
          });
        }
        accepted = false;
        outcome = 'still_available';
      } else if (verified === 'accepted') {
        // Portal confirms assignment. Still refuse if we never clicked anything
        // (nav-regex lies on an empty status page).
        if (pathHardWin || optimistic || accepted || !neverActed) {
          accepted = true;
          outcome = 'accepted';
          via = via || 'verified';
        } else {
          log.warn('verify said accepted but no accept path acted — not claiming a win', {
            orderId,
            paths,
          });
          accepted = false;
        }
      } else {
        // verified === 'unknown' (or unexpected): do NOT trust path-only for the
        // dashboard. Soft wins and hard path text without portal corroboration
        // become unverified — Orders page stays Failed/Pending, not Accepted.
        if (accepted || optimistic) {
          log.warn('accept not portal-confirmed — not marking dashboard Accepted', {
            orderId,
            verified,
            pathOutcome: winner?.outcome,
            steps: winner?.steps,
          });
        }
        accepted = false;
        if (optimistic || pathHardWin || outcome === 'accepted') {
          outcome = 'unverified';
        }
      }
    } catch (e) {
      log.warn('verify failed', { orderId, err: String(e) });
      // Verify threw — cannot honestly claim Accepted.
      if (accepted || optimistic) {
        accepted = false;
        outcome = 'unverified';
      }
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
