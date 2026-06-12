// Parser for E-Street / ValueLink AMS order-notification emails.
//
// Extracts the order id, the ACCEPT/DECLINE links, and the structured fields
// from the email body (HTML or plain text). Built against the real notification
// format from notifications@valuelinkams.com, e.g.:
//
//   An order for the property at 8140 NIGHTINGALE RD WEEKI WACHEE FL 34613
//   (Order no. 266-03335) is available, for the following service:
//   ...
//   Client Name: Shellpoint Mortgage Services - Collateral Management
//   Vendor's Fee: 50.00
//   ...
//   ACCEPT ORDER       DECLINE ORDER   (each an <a href> in the HTML part)

import { parseAddressMeta } from '../util/regionFilter.js';

const ORDER_NO_RE = /Order\s*(?:no\.?|number)\s*[:#]?\s*([0-9][0-9-]+)/i;

/** Strip HTML tags to plain text (good enough for field extraction). */
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Pull all <a href="..">text</a> pairs out of an HTML string. */
function extractAnchors(html) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[2] ?? m[3] ?? m[4] ?? '';
    const text = m[5].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ href: decodeEntities(href.trim()), text });
  }
  return out;
}

function decodeEntities(s) {
  return s.replace(/&amp;/gi, '&').replace(/&#38;/g, '&');
}

/** Choose the accept / decline links from anchors (and a plain-text fallback). */
function findActionLinks(anchors, text) {
  const byText = (kw) =>
    anchors.find((a) => new RegExp(`\\b${kw}\\b`, 'i').test(a.text))?.href;
  const byHref = (kw) =>
    anchors.find((a) => new RegExp(kw, 'i').test(a.href))?.href;

  let acceptUrl = byText('accept') || byHref('accept');
  let declineUrl = byText('decline') || byHref('decline');

  // Plain-text fallback: a bare URL near the word accept/decline.
  if (!acceptUrl) acceptUrl = nearbyUrl(text, 'accept');
  if (!declineUrl) declineUrl = nearbyUrl(text, 'decline');

  return { acceptUrl, declineUrl };
}

/**
 * Plain-text fallback: find the URL most plausibly belonging to `keyword`.
 * Prefers the nearest URL that FOLLOWS a keyword occurrence; falls back to a URL
 * whose own path contains the keyword.
 */
function nearbyUrl(text, keyword) {
  if (!text) return undefined;
  const kwRe = new RegExp(keyword, 'i');
  const urls = [];
  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  let m;
  while ((m = urlRe.exec(text))) urls.push({ url: m[0], idx: m.index });
  if (!urls.length) return undefined;

  const kwIdx = [];
  const gRe = new RegExp(keyword, 'gi');
  while ((m = gRe.exec(text))) kwIdx.push(m.index);

  for (const k of kwIdx) {
    const cand = urls
      .filter((x) => x.idx >= k && x.idx - k < 200)
      .sort((a, b) => a.idx - b.idx)[0];
    if (cand) return cand.url;
  }
  return urls.find((x) => kwRe.test(x.url))?.url;
}

/** Extract "Label: value" fields from plain text into a flat object. */
function extractFields(text) {
  const fields = {};
  const lineRe = /^([A-Za-z][A-Za-z0-9 .,/'()\-]+?):\s*(.+?)\s*$/;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(lineRe);
    if (m) {
      const key = m[1].trim();
      // Avoid swallowing sentence fragments that merely contain a colon.
      if (key.length <= 40) fields[key] = m[2].trim();
    }
  }
  return fields;
}

function pickFee(fields) {
  const raw =
    fields["Net Vendor's Fee"] ||
    fields["Vendor's Fee"] ||
    fields['Net Vendor Fee'] ||
    fields['Vendor Fee'];
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a raw email body (HTML and/or text) into a structured order.
 * @param {object} input
 * @param {string} [input.html]    raw HTML part
 * @param {string} [input.text]    raw text part
 * @param {string} [input.subject] subject line (helps id extraction)
 * @returns {{isOrder:boolean, orderId:string|null, acceptUrl?:string, declineUrl?:string,
 *            address?:string, fields:object, fee:number|null, raw:object}}
 */
export function parseOrderEmail({ html = '', text = '', subject = '' } = {}) {
  const anchors = html ? extractAnchors(html) : [];
  const bodyText = text || (html ? htmlToText(html) : '');
  const hay = `${subject}\n${bodyText}`;

  const orderMatch = hay.match(ORDER_NO_RE);
  const orderId = orderMatch ? orderMatch[1] : null;

  const { acceptUrl, declineUrl } = findActionLinks(anchors, bodyText);
  const fields = extractFields(bodyText);

  // It's an order email if we found an order id AND at least one action link,
  // or the unmistakable "An order for the property" phrasing.
  const looksLikeOrder =
    (!!orderId && (!!acceptUrl || !!declineUrl)) ||
    /an order for the property/i.test(hay);

  const address =
    fields['Property Address'] ||
    (hay.match(/property at\s+(.+?)\s*\(Order/i)?.[1]?.trim()) ||
    undefined;

  const { zip, zipPrefix, state } = parseAddressMeta(address || '');

  return {
    isOrder: looksLikeOrder,
    orderId,
    acceptUrl,
    declineUrl,
    address,
    zip,
    zipPrefix,
    state,
    fee: pickFee(fields),
    fields,
    raw: { subject, hasHtml: !!html, anchorCount: anchors.length },
  };
}

export { htmlToText, extractAnchors };
export default parseOrderEmail;
