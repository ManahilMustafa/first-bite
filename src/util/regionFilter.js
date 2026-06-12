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
  const zipMatch = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = zipMatch ? zipMatch[1] : null;
  const zipPrefix = zip ? zip.slice(0, 2) : null;

  // Prefer "ST 34613" pattern immediately before the ZIP.
  let state = null;
  if (zip) {
    const beforeZip = address.slice(0, address.indexOf(zip));
    const stMatch = beforeZip.match(/\b([A-Z]{2})\s*$/);
    if (stMatch && US_STATES.has(stMatch[1])) state = stMatch[1];
  }
  if (!state) {
    const anySt = address.match(/\b([A-Z]{2})\s+\d{5}\b/);
    if (anySt && US_STATES.has(anySt[1])) state = anySt[1];
  }

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
 * @param {object} account
 * @param {{address?:string, zip?:string, state?:string}} orderMeta
 * @returns {{allowed:boolean, reason?:string, meta:object}}
 */
export function orderMatchesRegion(account, orderMeta = {}) {
  const { zips, states } = ruleLists(account);
  if (!zips.length && !states.length) {
    return { allowed: true, reason: 'no_rules', meta: {} };
  }

  const parsed = parseAddressMeta(orderMeta.address || '');
  const zip = orderMeta.zip || parsed.zip;
  const zipPrefix = zip ? String(zip).slice(0, 2) : parsed.zipPrefix;
  const state = (orderMeta.state || parsed.state || '').toUpperCase() || null;
  const meta = { zip, zipPrefix, state, address: orderMeta.address };

  if (zips.length) {
    const zipOk = zipPrefix && zips.some((p) => zipPrefix.startsWith(String(p)));
    if (!zipOk) return { allowed: false, reason: 'zip_mismatch', meta };
  }
  if (states.length) {
    const stateOk = state && states.includes(state);
    if (!stateOk) return { allowed: false, reason: 'state_mismatch', meta };
  }

  return { allowed: true, meta };
}

export default orderMatchesRegion;
