// Gmail detector — redundancy path via Gmail API + Cloud Pub/Sub push.
//
// Architecture (multi-account):
//   - ONE shared GCP project / Pub/Sub topic / subscription / webhook.
//   - Per account: one OAuth refresh token + one users.watch() (renew daily;
//     watch expires after 7 days) + its own historyId cursor.
//   - A Pub/Sub push hits the webhook with { emailAddress, historyId }. We look
//     up that account's token, call history.list from the stored cursor, fetch
//     new messages, parse order emails, and emit detected orders.
//
// Email delivery + Pub/Sub tail latency are inherently seconds, so this is a
// REDUNDANCY detector, never the millisecond path. Live use needs real OAuth
// tokens; the parsing/decoding logic here is unit-testable without them.
import { parseOrderEmail } from './emailParser.js';
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

/** Decode a Gmail message payload (base64url body parts) into { html, text, subject }. */
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
  return { html, text, subject };
}

export class GmailWatcher {
  /**
   * @param {object} opts
   * @param {object} opts.oauth { clientId, clientSecret }
   * @param {(emailAddress:string)=>Promise<{refreshToken:string, historyId?:string}>} opts.getAccount
   * @param {(emailAddress:string, historyId:string)=>Promise<void>} opts.saveHistoryId
   * @param {(order:{orderId:string, acceptUrl?:string, source:'gmail', account:string})=>void} opts.onOrder
   * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
   */
  constructor({ oauth, getAccount, saveHistoryId, onOrder, fetchImpl = fetch, log = logger }) {
    this.oauth = oauth;
    this.getAccount = getAccount;
    this.saveHistoryId = saveHistoryId;
    this.onOrder = onOrder;
    this.fetch = fetchImpl;
    this.log = log('gmail');
  }

  async accessTokenFor(refreshToken) {
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

  /** Register/renew the watch for an account (call daily; expires in 7 days). */
  async registerWatch(accessToken, topicName) {
    const res = await this.fetch(`${GMAIL_API}/users/me/watch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterAction: 'include' }),
    });
    if (!res.ok) throw new Error(`watch failed: ${res.status}`);
    return res.json(); // { historyId, expiration }
  }

  /** Handle one Pub/Sub push: pull new messages since the stored cursor, emit orders. */
  async handlePush(pushBody) {
    const { emailAddress, historyId } = decodePubSubPush(pushBody);
    const account = await this.getAccount(emailAddress);
    if (!account) {
      this.log.warn('push for unknown account', { emailAddress });
      return { handled: 0 };
    }
    const accessToken = await this.accessTokenFor(account.refreshToken);
    const startId = account.historyId || historyId;

    const hist = await this.api(
      accessToken,
      `/users/me/history?startHistoryId=${encodeURIComponent(startId)}&historyTypes=messageAdded`
    );

    const messageIds = new Set();
    for (const h of hist.history || []) {
      for (const ma of h.messagesAdded || []) messageIds.add(ma.message.id);
    }

    let handled = 0;
    for (const id of messageIds) {
      const msg = await this.api(accessToken, `/users/me/messages/${id}?format=full`);
      const decoded = decodeGmailMessage(msg);
      const order = parseOrderEmail(decoded);
      if (order.isOrder && order.orderId) {
        handled++;
        this.log.info('order email detected', { account: emailAddress, orderId: order.orderId });
        this.onOrder({
          orderId: order.orderId,
          acceptUrl: order.acceptUrl,
          address: order.address,
          zip: order.zip,
          state: order.state,
          source: 'gmail',
          account: emailAddress,
        });
      }
    }

    // Advance the per-account cursor.
    if (hist.historyId) await this.saveHistoryId(emailAddress, String(hist.historyId));
    return { handled };
  }
}

export default GmailWatcher;
