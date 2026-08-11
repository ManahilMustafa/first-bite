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
  const winStart = Math.max(0, idx - 2000);
  const window = html.slice(winStart, idx + 2000);
  const patterns = [
    /ViewAppraisal\.aspx\?ApprID=(\d+)/gi,
    /AcceptBroadcastAppraisal\.aspx\?ApprID=(\d+)/gi,
    /AcceptAppraisal\.aspx\?ApprID=(\d+)/gi,
    /[?&]ApprID=(\d+)/gi,
  ];
  // A busy New Orders list can have a neighboring order's ApprID inside this
  // same 2000-char window (production: order 268-10185's retry picked up
  // 263517 — a different order's id — instead of the correct 264238, because
  // that was simply the first match scanning left-to-right). Take the
  // occurrence closest to the order id instead of the first one found.
  for (const re of patterns) {
    let m;
    let best = null;
    while ((m = re.exec(window))) {
      const distance = Math.abs(winStart + m.index - idx);
      if (!best || distance < best.distance) best = { apprId: m[1], distance };
    }
    if (best) return best.apprId;
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
