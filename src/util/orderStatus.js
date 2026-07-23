// Single source of truth for turning raw order-event rows (from
// OrderEventsStore) into the customer-facing status a non-technical user sees.
//
// Ground rules (per product requirement):
//   - Exactly 5 possible final statuses: accepted, declined, failed, pending,
//     outside_region. No internal jargon (would_accept, unattributed,
//     needs_login, region_unknown, taken, ...) ever reaches the dashboard.
//   - Every status carries a plain-English `reason` a non-technical vendor can
//     read and understand — no HTTP statuses, outcome codes, or stack traces.
//   - This runs ENTIRELY over already-persisted local data — no Gmail/portal
//     calls — so grouping/summarizing orders is always fast.

export const STATUS = {
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  FAILED: 'failed',
  PENDING: 'pending',
  OUTSIDE_REGION: 'outside_region',
};

// Nothing in this system automatically retries an unresolved order hours
// later — the only way one gets another chance is a brand-new detection (a
// duplicate/reminder email, or the portal poller catching it again). So an
// order that hasn't budged in this long is NOT "pending" in any meaningful
// sense; it's terminal. Without this cutoff, Pending only ever grows and can
// never be trusted as "still in progress" (see the 2026-07-13 audit: 78
// "Pending" orders, of which 0 were actually still being worked on).
export const PENDING_FRESH_MS = 30 * 60 * 1000; // 30 minutes

/**
 * One order can be detected/attempted multiple times (retries, duplicate
 * detections, reminder emails). Collapse all of that account's raw event rows
 * for a single order into ONE final status + a plain-English reason.
 * @param {object[]} events  all raw rows for one orderId, any order
 * @param {number} [now]  epoch ms (injectable for tests)
 * @returns {{status:string, reason:string}}
 */
export function computeFinalStatus(events, now = Date.now()) {
  const ordered = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // A success on ANY attempt wins outright, even if earlier attempts failed —
  // the order IS accepted/declined now, regardless of how many tries it took.
  const accepted = ordered.find((e) => e.accepted);
  if (accepted) {
    return { status: STATUS.ACCEPTED, reason: 'This order was automatically accepted for you.' };
  }
  const declined = ordered.find((e) => e.declined);
  if (declined) {
    return {
      status: STATUS.DECLINED,
      reason: 'This order was outside your service area, so it was automatically declined.',
    };
  }

  // Nothing succeeded yet — the most recent attempt tells us the current state.
  const last = ordered[ordered.length - 1];
  return classifyUnresolved(last, now);
}

function classifyUnresolved(e, now) {
  if (!e) return { status: STATUS.PENDING, reason: 'This order is still being processed.' };

  const fresh = now - (e.ts || 0) < PENDING_FRESH_MS;

  if (e.action === 'skip' && e.reason === 'region_unknown') {
    return {
      status: STATUS.OUTSIDE_REGION,
      reason: "We couldn't tell whether this order is in your service area, so we didn't take any action. Worth a manual look.",
    };
  }

  if (e.action === 'unattributed') {
    return fresh
      ? {
          status: STATUS.PENDING,
          reason: "This order's email didn't match any of your registered accounts yet. Check that the forwarding address is set up correctly.",
        }
      : {
          status: STATUS.FAILED,
          reason: "This order's email never matched any of your registered accounts, and it won't resolve on its own — check that your account's forwarding address is set up correctly.",
        };
  }

  if (e.outcome === 'needs_login') {
    return fresh
      ? {
          status: STATUS.PENDING,
          reason: 'Your portal login needs attention — the bot tried to log back in automatically but could not finish in time. It will keep retrying.',
        }
      : {
          status: STATUS.FAILED,
          reason: "The bot couldn't log back into the portal for this order and it's been too long for another automatic attempt. Please check your portal login.",
        };
  }

  if (e.outcome === 'unverified') {
    return fresh
      ? {
          status: STATUS.PENDING,
          reason: "We submitted a decline for this order but haven't been able to confirm the portal accepted it yet.",
        }
      : {
          status: STATUS.FAILED,
          reason: 'We submitted a decline for this order but were never able to confirm it went through. Please check the portal directly.',
        };
  }

  if (e.outcome === 'taken') {
    return { status: STATUS.FAILED, reason: 'Another vendor accepted this order before we could.' };
  }

  if (e.outcome === 'not_found') {
    return { status: STATUS.FAILED, reason: 'This order disappeared from the portal before we could act on it.' };
  }

  if (e.outcome === 'still_assigned') {
    return { status: STATUS.FAILED, reason: "We tried to decline this order, but the portal still shows it assigned to you." };
  }

  // Generic catch-all for anything else the bot attempted and didn't succeed
  // at (a technical hiccup) — still no jargon, but honest that something broke.
  return {
    status: STATUS.FAILED,
    reason: 'We ran into a problem processing this order and it did not go through. Please check it in the portal directly.',
  };
}

/** Human label for a status key — used everywhere the dashboard renders one. */
export const STATUS_LABEL = {
  [STATUS.ACCEPTED]: 'Accepted',
  [STATUS.DECLINED]: 'Declined',
  [STATUS.FAILED]: 'Failed',
  [STATUS.PENDING]: 'Pending',
  [STATUS.OUTSIDE_REGION]: 'Outside Region',
};

export default computeFinalStatus;
