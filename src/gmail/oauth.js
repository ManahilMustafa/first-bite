// Google OAuth helpers for Gmail read-only access (internal tool use).

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Build the Google consent URL. `state` should encode the target account id. */
export function buildGoogleAuthUrl({ clientId, redirectUri, state, scopes = [GMAIL_READONLY_SCOPE] }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: state || '',
  });
  return `${OAUTH_AUTH_URL}?${params}`;
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCodeForTokens(
  { clientId, clientSecret, code, redirectUri },
  fetchImpl = fetch
) {
  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OAuth code exchange failed (${res.status}): ${err}`);
  }
  return res.json();
}

/** Encode account id into OAuth state (opaque to Google, parsed on callback). */
export function encodeOAuthState(accountId) {
  return Buffer.from(JSON.stringify({ accountId, ts: Date.now() }), 'utf8').toString('base64url');
}

export function decodeOAuthState(state) {
  try {
    const json = Buffer.from(state, 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed?.accountId) throw new Error('missing accountId');
    return parsed;
  } catch (e) {
    throw new Error(`invalid OAuth state: ${e.message}`);
  }
}

export default { buildGoogleAuthUrl, exchangeCodeForTokens, encodeOAuthState, decodeOAuthState };
