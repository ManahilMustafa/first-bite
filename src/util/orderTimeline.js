// Reconstructs a per-order activity timeline PURELY from fields already
// persisted on each attempt's event row (paths.email/paths.portal, outcome,
// reason, verified, durationMs). No extra writes were added to the hot accept
// path to build this — it's derived at read time from local data only, so
// listing/expanding orders never adds latency to the actual accept/decline race.

/**
 * @param {object[]} events  all raw attempt rows for one orderId, any order
 * @returns {{ts:number, label:string}[]}  chronological technical timeline
 */
export function buildOrderTimeline(events) {
  // A slower, independent check (e.g. the original hot-path verify()) can
  // finish AFTER a faster one already confirmed success (e.g. the late
  // confirm-POST capture) — both write their own event row, so the raw
  // per-attempt trail can end on a "did not succeed" line for an order that
  // is, overall, genuinely accepted/declined. That's not a contradiction,
  // just two checks settling at different times, but read top-to-bottom it
  // looks like one. Tell attemptTimeline the real outcome so it can say so.
  const orderAccepted = events.some((e) => e.accepted);
  const orderDeclined = events.some((e) => e.declined);
  const entries = [];
  for (const e of [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    entries.push(...attemptTimeline(e, { orderAccepted, orderDeclined }));
  }
  return entries.sort((a, b) => a.ts - b.ts);
}

function attemptTimeline(e, { orderAccepted, orderDeclined } = {}) {
  const entries = [];
  const sourceLabel = e.source === 'portal' ? 'portal poll' : e.source === 'gmail' ? 'inbox email' : e.source || 'detector';
  entries.push({ ts: e.ts, label: `Detected via ${sourceLabel}` });

  if (e.action === 'skip') {
    entries.push({ ts: e.ts, label: 'Region Check — could not be determined, no action taken' });
    return entries;
  }
  if (e.action === 'unattributed') {
    entries.push({ ts: e.ts, label: 'Attribution — no matching vendor account for this email' });
    return entries;
  }

  entries.push({ ts: e.ts, label: 'Region Check — matched, proceeding' });
  const verb = e.action === 'decline' ? 'Decline' : 'Accept';
  const attemptEnd = e.ts + Math.round(e.durationMs || 0);

  for (const name of ['email', 'portal']) {
    const p = e.paths?.[name];
    if (!p) continue;
    const pathLabel = name === 'email' ? 'Email Link' : 'Portal';
    entries.push({ ts: e.ts, label: `${pathLabel} Attempt started` });

    // Path A's retry loop re-pushes 'email_get' on every attempt, so more than
    // one occurrence means a login bounce forced a retry. Path B's retry is
    // marked explicitly via the `reauthed` flag set by session.js.
    const emailRetried = name === 'email' && (p.steps || []).filter((s) => s === 'email_get').length > 1;
    if (emailRetried || p.reauthed) {
      entries.push({ ts: e.ts, label: 'Login Retry — session expired, re-authenticated automatically' });
      if (p.otpFetched) entries.push({ ts: e.ts, label: 'OTP — verification code fetched automatically' });
    }
    if (name === 'portal' && p.reauthed) {
      entries.push({ ts: e.ts, label: 'Portal Retry — request re-sent after re-login' });
    }

    entries.push({
      ts: attemptEnd,
      label: `${pathLabel} result: ${friendlyOutcome(p.outcome, p.ok)}`,
    });
  }

  if (e.verified) {
    entries.push({ ts: attemptEnd, label: `Portal Confirmation — final status: ${friendlyOutcome(e.verified)}` });
  }

  const succeeded = !!(e.accepted || e.declined);
  const supersededByAnotherCheck = !succeeded && (e.action === 'decline' ? orderDeclined : orderAccepted);
  const pastTense = e.action === 'decline' ? 'declined' : 'accepted';
  const label = succeeded
    ? `${verb} succeeded (${friendlyOutcome(e.outcome)})`
    : supersededByAnotherCheck
      ? `${verb} check here was inconclusive (${friendlyOutcome(e.outcome)}) — order was confirmed ${pastTense} by a different check`
      : `${verb} did not succeed (${friendlyOutcome(e.outcome)})`;
  entries.push({ ts: attemptEnd + 1, label });
  return entries;
}

const FRIENDLY_OUTCOME = {
  accepted: 'accepted',
  declined: 'declined',
  taken: 'already taken by someone else',
  not_found: 'order no longer listed',
  needs_login: 'login required',
  unverified: 'not yet confirmed',
  still_assigned: 'still assigned to you',
  gone: 'no longer available',
  submitted: 'submitted',
  available: 'available',
  unknown: 'unrecognized response',
  error: 'technical error',
  no_path: 'no path attempted',
};

function friendlyOutcome(outcome, ok) {
  if (ok === true) return FRIENDLY_OUTCOME[outcome] || outcome || 'succeeded';
  return FRIENDLY_OUTCOME[outcome] || outcome || 'failed';
}

export default buildOrderTimeline;
