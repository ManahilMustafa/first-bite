// Region filter — only accept orders whose ZIP prefix or state matches account rules.
//
// Rules live on the account record as `regionZipPrefixes` (e.g. ["32","34"]) and
// `regionStates` (e.g. ["FL","CA"]). If neither list is configured, all orders pass.

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

/** Parse ZIP + state from a property address string. */
export function parseAddressMeta(address = '') {
  if (!address) return { zip: null, zipPrefix: null, state: null };

  let zip = null;
  let state = null;

  // Prefer the canonical "<ST> <ZIP>" tail of a US address. This is critical when
  // the street number is itself 5 digits, e.g. "13167 DON LOOP ... FL 34609" — we
  // must take 34609, not the house number 13167.
  const stZip = address.match(/\b([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\b/);
  if (stZip && US_STATES.has(stZip[1].toUpperCase())) {
    state = stZip[1].toUpperCase();
    zip = stZip[2];
  }

  // Fall back to the LAST 5-digit group (the ZIP sits at the end, after the
  // street number), not the first match.
  if (!zip) {
    const all = [...address.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)];
    if (all.length) zip = all[all.length - 1][1];
  }

  // Still no state? Look just before the chosen ZIP.
  if (!state && zip) {
    const beforeZip = address.slice(0, address.lastIndexOf(zip));
    const stMatch = beforeZip.match(/\b([A-Za-z]{2})\s*$/);
    if (stMatch && US_STATES.has(stMatch[1].toUpperCase())) state = stMatch[1].toUpperCase();
  }

  const zipPrefix = zip ? zip.slice(0, 2) : null;
  return { zip, zipPrefix, state };
}

function ruleLists(account) {
  const zips = account?.regionZipPrefixes || account?.region?.zipPrefixes || [];
  const states = account?.regionStates || account?.region?.states || [];
  return {
    zips: zips.map((z) => String(z).trim()).filter(Boolean),
    states: states.map((s) => String(s).trim().toUpperCase()).filter(Boolean),
  };
}

/**
 * Decide whether an order is in a user's region.
 *
 * Semantics are **OR across configured dimensions**: if a user sets both ZIP
 * prefixes and states, an order matching *either* is in-region (matching the
 * "ZIP prefixes or states" wording in the UI). `decided` distinguishes a
 * confident out-of-region (decline) from "couldn't tell" (skip): if a configured
 * dimension couldn't be evaluated because the order lacked that signal (e.g. a
 * state rule but the address had no parseable state), we return decided:false so
 * the caller skips rather than declining a possibly-in-region order on a guess.
 *
 * @param {object} account
 * @param {{address?:string, zip?:string, state?:string}} orderMeta
 * @returns {{allowed:boolean, decided:boolean, reason:string, meta:object}}
 */
export function orderMatchesRegion(account, orderMeta = {}) {
  const { zips, states } = ruleLists(account);
  if (!zips.length && !states.length) {
    return { allowed: true, decided: true, reason: 'no_rules', meta: {} };
  }

  const parsed = parseAddressMeta(orderMeta.address || '');
  const zip = orderMeta.zip || parsed.zip;
  const zipPrefix = zip ? String(zip).slice(0, 2) : parsed.zipPrefix;
  const state = (orderMeta.state || parsed.state || '').toUpperCase() || null;
  const meta = { zip, zipPrefix, state, address: orderMeta.address };

  const zipConfigured = zips.length > 0;
  const stateConfigured = states.length > 0;
  const zipKnown = !!(zip || zipPrefix);
  const stateKnown = !!state;

  // Match a configured prefix P if the order's full ZIP starts with P (so
  // prefixes of any length — "34", "346", "34613" — work). Fall back to the
  // 2-digit prefix when that's all we have (best-effort for 1–2 digit rules).
  const zipMatch =
    zipConfigured &&
    zipKnown &&
    zips.some((p) => {
      const pref = String(p);
      return zip ? zip.startsWith(pref) : zipPrefix.startsWith(pref);
    });
  const stateMatch = stateConfigured && stateKnown && states.includes(state);

  if (zipMatch || stateMatch) {
    return { allowed: true, decided: true, reason: 'match', meta };
  }

  // No dimension matched. Were ALL configured dimensions actually evaluable? If a
  // configured dimension lacked signal, we can't be sure it's out-of-region.
  const zipEvaluable = !zipConfigured || zipKnown;
  const stateEvaluable = !stateConfigured || stateKnown;
  if (zipEvaluable && stateEvaluable) {
    const reason =
      zipConfigured && stateConfigured ? 'region_mismatch' : zipConfigured ? 'zip_mismatch' : 'state_mismatch';
    return { allowed: false, decided: true, reason, meta };
  }
  return { allowed: false, decided: false, reason: 'region_undetermined', meta };
}

export default orderMatchesRegion;
