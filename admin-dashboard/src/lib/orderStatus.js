// Thin presentation layer ONLY. The actual status + plain-language reason are
// computed server-side (src/util/orderStatus.js) from local persisted data, so
// every order shown here already carries { status, reason } from the API —
// this module just maps that status key to an emoji/label/color.
//
// Exactly 5 possible statuses. No internal jargon (would_accept, unattributed,
// needs_login, region_unknown, taken, ...) is ever rendered — if it slipped
// through, `unknown` below is the safety net, not a name for it to hide behind.

export const STATUS_PRESENTATION = {
  accepted: { emoji: '🟢', label: 'Accepted', variant: 'accepted' },
  declined: { emoji: '🔴', label: 'Declined', variant: 'declined' },
  failed: { emoji: '⚫', label: 'Failed', variant: 'failed' },
  pending: { emoji: '🟡', label: 'Pending', variant: 'pending' },
  outside_region: { emoji: '🟠', label: 'Outside Region', variant: 'outside-region' },
  test_scan: { emoji: '🔵', label: 'Test Scan', variant: 'scan' },
}

const FALLBACK = { emoji: '⚪', label: 'Unknown', variant: 'ignored' }

/** @param {string} status one of the keys above @returns presentation info */
export function presentStatus(status) {
  return STATUS_PRESENTATION[status] || FALLBACK
}

export default presentStatus
