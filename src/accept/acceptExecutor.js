// Accept executor — the hot path.
//
// Race Path A (email) vs Path B (portal), then confirm against the portal.
// Dashboard "Accepted" is driven by result.accepted — that flag must only be
// true when we have real portal proof (or a hard path success that verify
// corroborates). Soft/optimistic wins never become accepted:true alone.
import { acceptViaEmailLink } from './emailAccept.js';
import { acceptViaPortal } from './portalAccept.js';
import { tagResult, firstSuccessOrAll } from './race.js';
import { logger } from '../util/logger.js';

function resolveVerifyRetryCount() {
  const n = Number(process.env.VERIFY_RETRY_COUNT);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function resolveVerifyRetryMs() {
  const n = Number(process.env.VERIFY_RETRY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 400;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * After a soft/optimistic submit the portal often lags (In Progress not yet
 * showing our assignment). One unknown pass used to become unverified and
 * release the lock while a later read would have said accepted — retry briefly.
 */
async function verifyWithRetries(verify, orderId, { optimistic, log }) {
  let verified = await verify(orderId);
  if (!optimistic || verified !== 'unknown') return verified;
  const retries = resolveVerifyRetryCount();
  const delayMs = resolveVerifyRetryMs();
  for (let i = 0; i < retries && verified === 'unknown'; i++) {
    if (delayMs > 0) await sleep(delayMs);
    verified = await verify(orderId);
    log.info('verify retry after soft submit', { orderId, attempt: i + 2, verified });
  }
  return verified;
}

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
  // Release poller / start next bulk item ASAP — do NOT wait for the losing
  // path. Losers finish in the background; verify still serializes on the
  // session gate if it needs the portal.
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  try {
    onAfterRace?.();
  } catch (e) {
    log.warn('onAfterRace threw', { orderId, err: String(e) });
  }
  // Best-effort: collect late path results for logging without blocking the hot path.
  Promise.all(tasks).then((all) => {
    for (const r of all) {
      if (r?.__name && !paths[r.__name]) paths[r.__name] = r;
    }
  }).catch(() => {});

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
      verified = await verifyWithRetries(verify, orderId, { optimistic, log });
      log.info('final portal confirmation', { orderId, verified });
      const neverActed = Object.values(paths).every(
        (p) => !p || ['not_found', 'needs_login', 'no_path'].includes(p.outcome)
      );
      // Timeout/error after we clicked still counts as acted (verify may recover).
      const pathHardWin = !!(winner?.ok && winner.outcome === 'accepted');
      const actedSoft = Object.values(paths).some(
        (p) =>
          p &&
          (p.outcome === 'error' ||
            p.outcome === 'unknown' ||
            p.outcome === 'submitted' ||
            (Array.isArray(p.steps) && p.steps.length > 0))
      );

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
        if (pathHardWin || optimistic || accepted || actedSoft || !neverActed) {
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
