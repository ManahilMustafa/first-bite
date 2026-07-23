// Fetches a portal login's email-OTP code from the central Gmail inbox.
//
// Some ValueLink/E-Street deployments require a 6-digit code emailed on every
// fresh login (no "remember this device" option). Rick's forwarding rule
// relays that email into the same central inbox the order detector already
// watches, so we can read the code the same way we read forwarded orders —
// no separate mailbox access needed.
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function decodeBody(message) {
  let html = '';
  let text = '';
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || '';
    const body = part.body?.data;
    if (body) {
      const decoded = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      if (mime === 'text/html') html += decoded;
      else if (mime === 'text/plain') text += decoded;
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(message.payload);
  // Prefer the plain-text part — HTML <style> blocks contain 6-digit hex colors
  // (e.g. "#202020") that a bare \d{6} scan would mistake for the code.
  if (text) return text;
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
}

/** Pull the code out, anchored to E-Street / ValueLink OTP wording first to
 *  avoid stray 6-digit numbers (order ids, phone extensions, hex colors).
 *
 *  Real portal mail looks like the screenshot: title "Login Verification Code",
 *  then a standalone 6-digit block, then "This verification code is valid for
 *  5 minutes." The digits often sit *before* the word "verification code" in
 *  that trailing sentence — so we also match code-then-valid phrasing. */
export function extractCode(body) {
  const text = String(body || '').replace(/<[^>]+>/g, ' ');
  // "739495" … "This verification code is valid for 5 minutes"
  let m = text.match(/(\d{6})\D{0,60}(?:this\s+)?verification code is valid/i);
  if (m) return m[1];
  // "Your verification code is 515344" / "verification code: 515344"
  m = text.match(/verification code\D{0,40}(\d{6})/i);
  if (m) return m[1];
  m = text.match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

/**
 * @param {object} opts
 * @param {{clientId:string, clientSecret:string}} opts.oauth
 * @param {()=>Promise<string|null>} opts.getRefreshToken  central inbox refresh token
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {(args:{sentAfter:number, subjectQuery?:string, timeoutMs?:number})=>Promise<string|null>}
 *          fetchOtpCode — polls until a fresh code arrives or timeoutMs elapses
 */
// This OTP wait sits directly in the accept critical path (a fresh login
// blocks Path B until the code lands), so every millisecond here is one the
// bot isn't racing on a live order. Two concrete cuts, both measured in
// test/emailOtp.test.js:
//  1. Cache the access token (mirrors gmailWatcher.accessTokenFor) instead of
//     re-running a full OAuth refresh-token exchange on every single login —
//     an access token is valid ~1h, so only the FIRST OTP wait in that window
//     pays for it.
//  2. Poll every 1s instead of 3s, and fetch candidate messages in the same
//     poll tick CONCURRENTLY instead of one-at-a-time — both cut how long a
//     code can sit unread after Gmail actually has it.
const POLL_MS = 1000;

export function createGmailOtpFetcher({ oauth, getRefreshToken, fetchImpl = fetch }) {
  let cached = null; // { at, rt, exp }

  async function accessToken() {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) throw new Error('no central Gmail refresh token — cannot fetch OTP code');
    const now = Date.now();
    if (cached && cached.rt === refreshToken && cached.exp > now + 60000) {
      return cached.at;
    }
    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`OAuth token refresh failed: ${res.status}`);
    const j = await res.json();
    cached = { at: j.access_token, rt: refreshToken, exp: now + (Number(j.expires_in) || 3600) * 1000 };
    return cached.at;
  }

  // Subject must match both "Verification Code" (Rick) and the current
  // E-Street template "Login Verification Code" (Manara). Codes are only
  // readable if that mail is forwarded into the *central* Gmail — same as
  // order emails. Allow up to 90s: forwarding + Gmail index lag is common.
  return async function fetchOtpCode({
    sentAfter,
    subjectQuery = 'subject:(("Login Verification Code") OR ("Verification Code")) newer_than:1h',
    timeoutMs = 90000,
  } = {}) {
    const at = await accessToken();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const listRes = await fetchImpl(
        `${GMAIL_API}/users/me/messages?q=${encodeURIComponent(subjectQuery)}&maxResults=5`,
        { headers: { authorization: `Bearer ${at}` } }
      );
      const list = await listRes.json();
      const candidates = list.messages || [];
      // Fetch every candidate's full content concurrently — these are
      // independent reads, no reason to pay N sequential round-trips when the
      // code (if present at all) is almost always in the newest message.
      const msgs = await Promise.all(
        candidates.map((m) =>
          fetchImpl(`${GMAIL_API}/users/me/messages/${m.id}?format=full`, {
            headers: { authorization: `Bearer ${at}` },
          }).then((r) => r.json())
        )
      );
      for (const msg of msgs) {
        const internalDate = Number(msg.internalDate);
        // Gmail's internalDate is second-truncated, so a code sent just after
        // `sentAfter` can round down to just before it — allow a few seconds
        // of slack rather than rejecting the very code we're waiting for.
        if (internalDate < sentAfter - 5000) continue; // stale — from an earlier attempt
        const code = extractCode(decodeBody(msg));
        if (code) return code;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  };
}

export default createGmailOtpFetcher;
