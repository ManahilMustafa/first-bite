// Shared accept/decline outcome signals for E-Street / ValueLink.
//
// MUST stay strict: dashboard nav contains "Accepted" / "In Progress" substrings
// (lnkCondAcceptedOrders, lnkShowInProgressOrders). A loose match invented the
// 2026-07-21 / 2026-07-24 fake-accept bugs.
//
// Tuned to the real vendor flow the owner documented:
//   Gmail → ACCEPT ORDER link → "Accept Order" button → green badge OR order detail
//   Portal → list tick → "Accept Appraisal" button → green badge OR order detail
// Neither landing page is exclusive to one path (owner-confirmed 2026-09-03) —
// both accept flows can end on either the green acceptance badge or the plain
// "Manage Order" detail page (Status: In Progress next to the order's own
// number, no banner). The order-detail match is order-id-scoped
// (classifyNearOrder in verifier.js), not part of the whole-page ACCEPTED_RE
// below, precisely so it stays strict per the warning above.

import { findPostbackTarget } from '../portal/aspnet.js';

/** Hard accept proof (postback response, status page, or green badge copy). */
export const ACCEPTED_RE =
  /\b(?:order\s+\S+\s+)?(?:accepted by vendor|accepted by you|assigned to you)\b|\border\s+\S+\s+accepted\b|\bsuccessfully\s+accepted(?:\s+the\s+order)?\b|\bacceptance\s+(?:was\s+)?successful\b|\byou\s+have\s+(?:successfully\s+)?accepted\b|\border\s+has\s+been\s+accepted\b|\baccepted\s+successfully\b|\bstatus:\s*in progress\b|\bin progress\.\s*$/im;

export const TAKEN_RE =
  /\bno longer available\b|\balready (?:been )?(?:assigned|accepted)\b|\bassigned to (?:another|other)(?:\s+vendor)?\b|\bnot available\b|\breassigned\b/i;

export const AVAILABLE_RE = /\b(?:available|pending acceptance|awaiting(?:\s+acceptance)?)\b/i;

/** Confirmation page landed after list-tick or email ACCEPT ORDER link. */
export const CONFIRM_URL_RE = /Accept(?:Broadcast)?Appraisal|AcceptOrder|AcceptAppraisal\.aspx/i;

export function looksAccepted(html) {
  return ACCEPTED_RE.test(html || '');
}

export function looksTaken(html) {
  return TAKEN_RE.test(html || '');
}

export function looksAvailable(html) {
  return AVAILABLE_RE.test(html || '');
}

/** ValueLink generic failure page (bad postback / broken query string, etc.). */
export function looksLikePortalError(html, url = '') {
  if (/Error\.aspx/i.test(String(url || ''))) return true;
  const h = html || '';
  if (/ValueLink\s+AMS\s*-\s*ERROR/i.test(h)) return true;
  return /unexpected error occurred that caused the previous operation to fail/i.test(h);
}

export function isAcceptConfirmUrl(url = '') {
  return CONFIRM_URL_RE.test(String(url));
}

/**
 * Prefer the real button label for this path, then fall back.
 * @param {string} html
 * @param {'order'|'appraisal'|'any'} [prefer]
 */
export function findConfirmAcceptControl(html, prefer = 'any') {
  const chains = {
    order: [/accept\s*order/i, /accept\s*appraisal/i, /\baccept\b/i],
    appraisal: [/accept\s*appraisal/i, /accept\s*order/i, /\baccept\b/i],
    any: [/accept\s*order/i, /accept\s*appraisal/i, /\baccept\b/i],
  };
  for (const re of chains[prefer] || chains.any) {
    const pb = findPostbackTarget(html, re);
    if (pb) return pb;
  }
  return null;
}
