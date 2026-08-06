/**
 * Pull the portal ApprID for an order from nearby HTML.
 *
 * Real E-Street pages link orders as ViewAppraisal.aspx?ApprID=NNNN next to the
 * order number. Confirm / Accept=asis URLs use the same id:
 *   AcceptBroadcastAppraisal.aspx?ApprID=NNNN&Accept=asis
 *
 * @param {string} html
 * @param {string} orderId
 * @returns {string|null}
 */
export function extractApprIdNearOrder(html, orderId) {
  if (!html || !orderId) return null;
  const idx = html.indexOf(orderId);
  if (idx === -1) return null;
  const window = html.slice(Math.max(0, idx - 2000), idx + 2000);
  const patterns = [
    /ViewAppraisal\.aspx\?ApprID=(\d+)/i,
    /AcceptBroadcastAppraisal\.aspx\?ApprID=(\d+)/i,
    /AcceptAppraisal\.aspx\?ApprID=(\d+)/i,
    /[?&]ApprID=(\d+)/i,
  ];
  for (const re of patterns) {
    const m = window.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * Absolute Accept=asis URL for a known ApprID (same shape as the email link).
 * @param {{url:(path:string)=>string}} session
 * @param {string} apprId
 */
export function acceptAsIsUrl(session, apprId) {
  const path = `/AcceptBroadcastAppraisal.aspx?ApprID=${encodeURIComponent(apprId)}&Accept=asis`;
  return typeof session.url === 'function' ? session.url(path) : path;
}
