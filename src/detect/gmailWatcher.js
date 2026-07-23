// Gmail detector — ONE central inbox that every user forwards their orders into.
//
// Architecture (single-mailbox, multi-user):
//   - ONE GCP project / Pub/Sub topic / subscription / webhook.
//   - ONE operator OAuth refresh token + ONE users.watch() (renew daily; the
//     watch expires after 7 days) + ONE historyId cursor.
//   - A Pub/Sub push hits the webhook with { emailAddress, historyId } for the
//     central inbox. We call history.list from the stored cursor, fetch new
//     messages, parse order emails, ATTRIBUTE each to the user it was forwarded
//     from (via the forwarding headers), and emit the order to that user.
//
// Email delivery + forwarding + Pub/Sub tail latency are inherently seconds, so
// this is a REDUNDANCY detector that also supplies the email's self-contained
// ACCEPT/DECLINE links; the per-user portal poller is the fast path.
import { parseOrderEmail } from './emailParser.js';
import { extractRecipientCandidates } from './attribution.js';
import { orderMatchesRegion } from '../util/regionFilter.js';
import { logger } from '../util/logger.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Decode the base64-encoded Pub/Sub push envelope into { emailAddress, historyId }. */
export function decodePubSubPush(reqBody) {
  const data = reqBody?.message?.data;
  if (!data) throw new Error('Pub/Sub push missing message.data');
  const json = Buffer.from(data, 'base64').toString('utf8');
  const parsed = JSON.parse(json);
  return {
    emailAddress: parsed.emailAddress,
    historyId: String(parsed.historyId),
    messageId: reqBody.message.messageId,
    publishTime: reqBody.message.publishTime,
  };
}

/**
 * Decode a Gmail message payload (base64url body parts) into
 * { html, text, subject, headers, internalDate }. `headers` is the raw payload
 * header array, needed for attribution (Delivered-To / X-Forwarded-For / etc).
 * `internalDate` (epoch ms, Gmail's own receipt timestamp for the message) is
 * the only honest anchor we have for "when did this order actually become
 * available" — used to measure real detection latency, not a guess.
 */
export function decodeGmailMessage(message) {
  const headers = message.payload?.headers || [];
  const subject = headers.find((h) => h.name?.toLowerCase() === 'subject')?.value || '';
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
  const internalDate = message.internalDate ? Number(message.internalDate) : null;
  return { html, text, subject, headers, internalDate };
}

export class GmailWatcher {
  /**
   * @param {object} opts
   * @param {object} opts.oauth { clientId, clientSecret }
   * @param {()=>Promise<string|null>} opts.getRefreshToken  central inbox refresh token
   * @param {(address:string)=>(object|null|Promise<object|null>)} opts.resolveUser
   *        return the account registered for a forwarding address, else null
   * @param {()=>Promise<string|null>} opts.getHistoryId      central cursor getter
   * @param {(historyId:string)=>Promise<void>} opts.saveHistoryId
   * @param {(order:object)=>void} opts.onOrder
   * @param {string[]} [opts.excludeAddresses]  never attribute to these (e.g. the central inbox)
   * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
   */
  constructor({
    oauth,
    getRefreshToken,
    resolveUser,
    getHistoryId,
    saveHistoryId,
    onOrder,
    onUnattributed,
    excludeAddresses = [],
    fetchImpl = fetch,
    log = logger,
  }) {
    this.oauth = oauth;
    this.getRefreshToken = getRefreshToken;
    this.resolveUser = resolveUser;
    this.getHistoryId = getHistoryId;
    this.saveHistoryId = saveHistoryId;
    this.onOrder = onOrder;
    this.onUnattributed = onUnattributed; // quarantined orders (no registered user)
    this.excludeAddresses = excludeAddresses;
    this.fetch = fetchImpl;
    this.log = log('gmail');
  }

  async accessTokenFor(refreshToken) {
    // Cache the access token until ~1 min before expiry. Without this, frequent
    // polling would hit Google's token endpoint on every tick and get throttled.
    const now = Date.now();
    if (this._tok && this._tok.rt === refreshToken && this._tok.exp > now + 60000) {
      return this._tok.at;
    }
    const res = await this.fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.oauth.clientId,
        client_secret: this.oauth.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`OAuth token refresh failed: ${res.status}`);
    const j = await res.json();
    this._tok = { at: j.access_token, rt: refreshToken, exp: now + (Number(j.expires_in) || 3600) * 1000 };
    return j.access_token;
  }

  async api(accessToken, path) {
    const res = await this.fetch(`${GMAIL_API}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Gmail API ${path} -> ${res.status}`);
    return res.json();
  }

  /** Fetch the authenticated Gmail address. */
  async getProfile(accessToken) {
    return this.api(accessToken, '/users/me/profile');
  }

  /** Register/renew the watch for the central inbox (call daily; expires in 7 days). */
  async registerWatch(accessToken, topicName) {
    const res = await this.fetch(`${GMAIL_API}/users/me/watch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterAction: 'include' }),
    });
    if (!res.ok) throw new Error(`watch failed: ${res.status}`);
    return res.json(); // { historyId, expiration }
  }

  /** Attribute a parsed message to a registered user via its forwarding headers. */
  async _attribute(headers, centralAddress) {
    const candidates = extractRecipientCandidates(headers, {
      excludeAddresses: [...this.excludeAddresses, centralAddress].filter(Boolean),
    });
    for (const c of candidates) {
      const account = await this.resolveUser(c.address);
      if (account) return { account, address: c.address, via: c.via, candidates };
    }
    return { account: null, candidates };
  }

  /** Handle one Pub/Sub push: pull new messages since the cursor, attribute, emit. */
  async handlePush(pushBody) {
    const { emailAddress, historyId } = decodePubSubPush(pushBody);
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) {
      this.log.warn('gmail push but central inbox not connected');
      return { handled: 0 };
    }
    const accessToken = await this.accessTokenFor(refreshToken);
    const startId = (await this.getHistoryId()) || historyId;
    return this._pull(accessToken, startId, emailAddress);
  }

  /**
   * Poll the central inbox on a timer — the fetch path when there is no Pub/Sub
   * push (no public webhook). Pulls everything new since the stored cursor and
   * routes it through the same attribute → emit pipeline as a push. No-ops until
   * the inbox is connected. Self-heals a stale cursor (Gmail keeps ~1 week of
   * history) by re-seeding from the current mailbox state.
   */
  async poll() {
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) return { handled: 0, connected: false };
    const accessToken = await this.accessTokenFor(refreshToken);
    let startId = await this.getHistoryId();
    // Fetch the profile only when we must (unknown cursor or unknown central
    // address). Steady-state polls then cost just a single history.list call.
    if (!startId || !this._centralAddress) {
      const profile = await this.getProfile(accessToken);
      this._centralAddress = profile.emailAddress;
      if (!startId) startId = String(profile.historyId);
    }
    try {
      return await this._pull(accessToken, startId, this._centralAddress);
    } catch (e) {
      if (/-> 404/.test(String(e.message))) {
        const profile = await this.getProfile(accessToken);
        this._centralAddress = profile.emailAddress;
        this.log.warn('history cursor stale — re-seeding', { from: startId, to: profile.historyId });
        await this.saveHistoryId(String(profile.historyId));
        return { handled: 0, reseeded: true };
      }
      throw e;
    }
  }

  /** Pull messages added since `startId`, attribute each, emit, advance cursor. */
  async _pull(accessToken, startId, centralAddress) {
    const hist = await this.api(
      accessToken,
      `/users/me/history?startHistoryId=${encodeURIComponent(startId)}&historyTypes=messageAdded`
    );

    const messageIds = new Set();
    for (const h of hist.history || []) {
      for (const ma of h.messagesAdded || []) messageIds.add(ma.message.id);
    }

    let handled = 0;
    let unattributed = 0;
    for (const id of messageIds) {
      const msg = await this.api(accessToken, `/users/me/messages/${id}?format=full`);
      const decoded = decodeGmailMessage(msg);
      const order = parseOrderEmail(decoded);
      if (!order.isOrder || !order.orderId) continue;

      this.log.info('order detected', { orderId: order.orderId, source: 'gmail', address: order.address });

      const { account, address, via, candidates } = await this._attribute(decoded.headers, centralAddress);
      if (!account) {
        // Quarantine: a real order we cannot tie to a registered user. NEVER act
        // on an order we can't attribute — that would touch the wrong account.
        unattributed++;
        this.log.warn('order email could not be attributed to a user', {
          orderId: order.orderId,
          candidates: candidates.map((c) => c.address),
        });
        if (this.onUnattributed) {
          try {
            this.onUnattributed({
              orderId: order.orderId,
              address: order.address,
              state: order.state,
              zip: order.zip,
              source: 'gmail',
              forwardingEmail: candidates[0]?.address || null, // the address we found (e.g. from BCC/forward)
              via: candidates[0]?.via || null,
              candidates: candidates.map((c) => c.address),
            });
          } catch {
            /* recording must never break the pull */
          }
        }
        continue;
      }

      handled++;
      this.log.info('order email attributed', {
        orderId: order.orderId,
        account: account.label || account.id,
        forwardedFrom: address,
        via,
      });
      this.onOrder({
        orderId: order.orderId,
        acceptUrl: order.acceptUrl,
        declineUrl: order.declineUrl,
        address: order.address,
        zip: order.zip,
        state: order.state,
        source: 'gmail',
        accountId: account.id,
        forwardingEmail: address,
        // Gmail's own receipt timestamp for this message — the only honest
        // anchor for "when did this order actually become available" over
        // email. Lets handleOrder() measure real detection latency instead of
        // guessing from our own poll interval.
        emailReceivedAt: decoded.internalDate,
      });
    }

    // Advance the central cursor.
    if (hist.historyId) await this.saveHistoryId(String(hist.historyId));
    return { handled, unattributed };
  }

  /**
   * SAFE TEST: scan recent inbox messages and report what WOULD happen for each
   * order — attribution + the per-user region decision — WITHOUT touching any
   * portal (no accept, no decline). Read-only; needs only gmail.readonly.
   * @param {object} [opts]
   * @param {number} [opts.max]    how many recent messages to scan
   * @param {string} [opts.query]  Gmail search query
   * @returns {Promise<{scanned:number, orders:object[]}>}
   */
  async dryRunRecent({ max = 10, query = 'from:valuelinkams.com' } = {}) {
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) throw new Error('central inbox not connected');
    const accessToken = await this.accessTokenFor(refreshToken);
    const profile = await this.getProfile(accessToken);

    const list = await this.api(
      accessToken,
      `/users/me/messages?maxResults=${encodeURIComponent(max)}&q=${encodeURIComponent(query)}`
    );

    const orders = [];
    for (const m of list.messages || []) {
      const msg = await this.api(accessToken, `/users/me/messages/${m.id}?format=full`);
      const decoded = decodeGmailMessage(msg);
      const order = parseOrderEmail(decoded);
      if (!order.isOrder || !order.orderId) continue;

      const { account, address, via, candidates } = await this._attribute(decoded.headers, profile.emailAddress);
      let decision = 'unattributed';
      let region;
      if (account) {
        region = orderMatchesRegion(account, { address: order.address, zip: order.zip, state: order.state });
        decision = region.allowed ? 'WOULD_ACCEPT' : region.decided ? 'WOULD_DECLINE' : 'SKIP_undetermined';
      }
      orders.push({
        orderId: order.orderId,
        address: order.address,
        state: order.state,
        zip: order.zip,
        accountId: account ? account.id || null : null,
        attributedTo: account ? account.label || account.id : null,
        forwardingEmail: address || null,
        via: via || null,
        decision,
        reason: region?.reason,
        regionRule: account ? { states: account.regionStates, zipPrefixes: account.regionZipPrefixes } : undefined,
        unmatchedCandidates: account ? undefined : (candidates || []).map((c) => ({ address: c.address, via: c.via })),
      });
    }
    return { scanned: (list.messages || []).length, orders };
  }
}

export default GmailWatcher;
