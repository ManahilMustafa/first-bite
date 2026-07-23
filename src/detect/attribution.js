// Attribution — figure out WHICH user a forwarded order email belongs to.
//
// All users forward their E-Street order emails into ONE central inbox. The
// originals are BCC'd, so the `To:` header is the AMC's address, not the user's.
// The user's real mailbox survives only in the forwarding headers, and *which*
// header carries it depends on the setup (Workspace vs personal Gmail, auto vs
// manual forward). Rather than guess the "right" header, we extract EVERY
// candidate recipient address from all the plausible headers, then let the
// caller keep the first one that matches a REGISTERED user. Only a real user's
// forwarding address can match, so the AMC sender and the central inbox address
// fall away on their own.
//
// Priority order below is "most trustworthy first" so that when several headers
// each name a registered user (rare), we prefer the most reliable signal.

// Headers that can carry the original recipient, best signal first.
const RECIPIENT_HEADERS = [
  'x-gm-original-to',
  'x-forwarded-to',
  'x-original-to',
  'x-forwarded-for',
  'delivered-to',
  'envelope-to',
  'to',
  'cc',
];

// Domains that are NEVER a user's forwarding mailbox (the order sender / AMC).
// Keeps obvious noise out of the candidate list; override via opts.excludeDomains.
const DEFAULT_EXCLUDE_DOMAINS = ['valuelinkams.com', 'estreetamc.com'];

const EMAIL_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;

/** Normalize Gmail's `[{name,value}]` header array (or a plain object) to a list. */
function toHeaderList(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers
      .filter((h) => h && h.name != null)
      .map((h) => ({ name: String(h.name).toLowerCase(), value: String(h.value ?? '') }));
  }
  // Plain object form: { 'Delivered-To': 'a@b.com', ... }
  return Object.entries(headers).map(([k, v]) => ({
    name: String(k).toLowerCase(),
    value: Array.isArray(v) ? v.join(' ') : String(v ?? ''),
  }));
}

/** Pull email addresses out of a header value. `Received:` only yields its `for <addr>`. */
function addressesFromHeader(name, value) {
  if (name === 'received') {
    const m = value.match(/\bfor\s+<?([^\s<>;]+@[^\s<>;]+)>?/i);
    return m ? [m[1]] : [];
  }
  const found = value.match(EMAIL_RE);
  return found ? found.map((a) => a.replace(/[<>]/g, '')) : [];
}

/**
 * Extract ordered, de-duplicated candidate recipient addresses (lowercased).
 * `Received: ... for <addr>` is also consulted as a late fallback.
 *
 * @param {Array<{name:string,value:string}>|object} headers  Gmail payload headers
 * @param {object} [opts]
 * @param {string[]} [opts.excludeDomains]   domains to drop (defaults to the AMC senders)
 * @param {string[]} [opts.excludeAddresses] specific addresses to drop (e.g. the central inbox)
 * @returns {Array<{address:string, via:string}>}
 */
export function extractRecipientCandidates(headers, opts = {}) {
  const list = toHeaderList(headers);
  const excludeDomains = (opts.excludeDomains ?? DEFAULT_EXCLUDE_DOMAINS).map((d) => d.toLowerCase());
  const excludeAddresses = new Set((opts.excludeAddresses ?? []).map((a) => a.toLowerCase()));

  const byName = new Map(); // header name -> [values]
  for (const h of list) {
    if (!byName.has(h.name)) byName.set(h.name, []);
    byName.get(h.name).push(h.value);
  }

  const out = [];
  const seen = new Set();
  const push = (addr, via) => {
    const a = addr.trim().toLowerCase();
    if (!a || seen.has(a)) return;
    if (excludeAddresses.has(a)) return;
    const domain = a.slice(a.indexOf('@') + 1);
    if (excludeDomains.some((d) => domain === d || domain.endsWith('.' + d))) return;
    seen.add(a);
    out.push({ address: a, via });
  };

  for (const name of RECIPIENT_HEADERS) {
    for (const value of byName.get(name) || []) {
      for (const addr of addressesFromHeader(name, value)) push(addr, name);
    }
  }
  // Late fallback: Received: ... for <addr>
  for (const value of byName.get('received') || []) {
    for (const addr of addressesFromHeader('received', value)) push(addr, 'received');
  }

  return out;
}

/**
 * Resolve the owning user for a forwarded email.
 * @param {Array<{name,value}>|object} headers
 * @param {(address:string)=>any} resolve  return a truthy account for a registered address, else falsy
 * @param {object} [opts] forwarded to extractRecipientCandidates
 * @returns {{account:any, address:string, via:string, candidates:string[]}|null}
 */
export function attributeOrder(headers, resolve, opts = {}) {
  const candidates = extractRecipientCandidates(headers, opts);
  for (const c of candidates) {
    const account = resolve(c.address);
    if (account) return { account, address: c.address, via: c.via, candidates: candidates.map((x) => x.address) };
  }
  return null;
}

export default attributeOrder;
