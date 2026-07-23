// Helpers for ASP.NET WebForms pages (which ValueLink/E-Street is built on).
//
// WebForms drives almost every action through a __doPostBack(eventTarget, arg)
// that submits the whole <form> including the hidden state fields __VIEWSTATE,
// __VIEWSTATEGENERATOR and __EVENTVALIDATION. To replay an action as raw HTTP we
// must (1) scrape those fields fresh from the current page and (2) post them
// back with __EVENTTARGET set to the control that was "clicked".

const HIDDEN_FIELD_NAMES = [
  '__VIEWSTATE',
  '__VIEWSTATEGENERATOR',
  '__EVENTVALIDATION',
  '__VIEWSTATEENCRYPTED',
  '__PREVIOUSPAGE',
  '__SCROLLPOSITIONX',
  '__SCROLLPOSITIONY',
];

/** Scrape ALL <input type=hidden> name/value pairs from an HTML page. */
export function scrapeHiddenFields(html) {
  const fields = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const tag = m[0];
    const type = attr(tag, 'type');
    const name = attr(tag, 'name');
    if (!name) continue;
    if (type && type.toLowerCase() !== 'hidden') continue;
    fields[name] = decodeAttr(attr(tag, 'value') ?? '');
  }
  return fields;
}

/** Scrape only the canonical WebForms state fields. */
export function scrapeViewState(html) {
  const all = scrapeHiddenFields(html);
  const out = {};
  for (const name of HIDDEN_FIELD_NAMES) if (name in all) out[name] = all[name];
  return out;
}

/** Build a postback body that simulates clicking `eventTarget`. */
export function buildPostback(html, eventTarget, eventArgument = '', extra = {}) {
  const body = {
    ...scrapeHiddenFields(html),
    __EVENTTARGET: eventTarget,
    __EVENTARGUMENT: eventArgument,
    ...extra,
  };
  return body;
}

/**
 * Find the __doPostBack event target for a control, by matching nearby text.
 * Returns the control name to put in __EVENTTARGET, or null.
 * Handles:
 *   - link buttons (href="javascript:__doPostBack('target','arg')")
 *   - submit buttons (<input type=submit name="target" value="Accept">)
 *   - image buttons (<input type=image name="…imgBtnBroadcastAccept" title="…accept…">)
 *     — the real E-Street New Orders Accept/Decline controls are type=image ticks.
 */
export function findPostbackTarget(html, labelRe) {
  // 1) Anchor/link buttons with __doPostBack in href or onclick.
  const aRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    const tag = m[0];
    const text = m[1].replace(/<[^>]+>/g, ' ').trim();
    const onclickOrHref = `${attr(tag, 'href') ?? ''} ${attr(tag, 'onclick') ?? ''}`;
    const pb = onclickOrHref.match(/__doPostBack\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/i);
    if (pb && labelRe.test(text)) return { target: pb[1], argument: pb[2] };
  }
  // 2) Submit/button/image inputs.
  const inputRe = /<input\b[^>]*>/gi;
  while ((m = inputRe.exec(html))) {
    const tag = m[0];
    const type = (attr(tag, 'type') || '').toLowerCase();
    const name = attr(tag, 'name');
    if (!name) continue;
    if (type === 'submit' || type === 'button') {
      const value = attr(tag, 'value') || '';
      if (labelRe.test(value)) return { target: name, argument: '', isSubmit: true, submitValue: value };
      continue;
    }
    // ASP.NET ImageButton → <input type="image">. A click posts name.x / name.y
    // (not __EVENTTARGET). Match name/id/title/alt so "Accept" finds
    // imgBtnBroadcastAccept ("Click here to accept this order").
    if (type === 'image') {
      const hay = [name, attr(tag, 'id') || '', attr(tag, 'title') || '', attr(tag, 'alt') || ''].join(' ');
      if (labelRe.test(hay)) return { target: name, argument: '', isImage: true };
    }
  }
  // 3) <button> elements.
  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((m = btnRe.exec(html))) {
    const attrs = m[1];
    const text = m[2].replace(/<[^>]+>/g, ' ').trim();
    const name = attr(`<x ${attrs}>`, 'name');
    if (name && labelRe.test(text)) return { target: name, argument: '', isSubmit: true, submitValue: text };
  }
  return null;
}

/**
 * Build the form body that simulates clicking a control returned by
 * findPostbackTarget (link / submit / image).
 */
export function buildControlClick(html, pb) {
  const extra = { ...(pb.extra || {}) };
  if (pb.isSubmit && pb.submitValue) extra[pb.target] = pb.submitValue;
  // Image buttons are identified by the presence of name.x / name.y in the POST
  // (browser click coordinates). ASP.NET does not need __EVENTTARGET for them.
  if (pb.isImage) {
    extra[`${pb.target}.x`] = '1';
    extra[`${pb.target}.y`] = '1';
  }
  const useEventTarget = !pb.isSubmit && !pb.isImage;
  const body = buildPostback(html, useEventTarget ? pb.target : '', pb.argument || '', extra);
  if (useEventTarget) body.__EVENTTARGET = pb.target;
  return body;
}

/** Resolve the first <form action="..."> against a base URL. */
export function scrapeFormAction(html, baseUrl) {
  const m = html.match(/<form\b[^>]*\baction\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!m) return baseUrl;
  const action = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  if (!action || action === '#') return baseUrl;
  try {
    return new URL(action, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

/** Heuristic: does this HTML look like a login page (i.e. we got bounced)? */
export function looksLikeLogin(html) {
  if (!html) return false;
  const h = html.toLowerCase();
  const hasPassword = /<input[^>]*type\s*=\s*['"]?password/i.test(html);
  const mentionsLogin = /log\s*in|sign\s*in|forgot your password|user\s*name/i.test(h);
  return hasPassword && mentionsLogin;
}

/** Heuristic: does this HTML look like a post-login email-OTP challenge page? */
export function looksLikeOtpPage(html) {
  if (!html) return false;
  const h = html.toLowerCase();
  const mentionsCode = /verification code|enter.{0,20}\bcode\b|6.?digit code/i.test(h);
  const hasCodeInput = /<input[^>]*maxlength\s*=\s*['"]?6['"]?[^>]*>/i.test(html);
  return mentionsCode && hasCodeInput;
}

// Common ASP.NET WebForms phrasing for a rejected/stale postback — distinct
// from a login bounce (looksLikeLogin): the session IS authenticated, but the
// __VIEWSTATE/__EVENTVALIDATION we posted no longer matches what the server
// expects. Used only by the opt-in cached-page reuse path (see portalAccept.js
// / portalDecline.js) to detect "the cached page's tokens were stale — redo
// this with a guaranteed-fresh GET" without mistaking it for a real failure.
export function looksLikeStaleState(html) {
  if (!html) return false;
  return /session (has )?expired|invalid\s+viewstate|viewstate is invalid|unable to validate data|validateantiforgerytoken/i.test(
    html
  );
}

// ── tiny attribute reader ────────────────────────────────────────────────────
function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

function decodeAttr(s) {
  return s
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export { attr as _attr };
