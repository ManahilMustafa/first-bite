import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePubSubPush,
  decodeGmailMessage,
  GmailWatcher,
} from '../src/detect/gmailWatcher.js';
import { ORDER_EMAIL_HTML, ORDER_EMAIL_SUBJECT } from './fixtures/orderEmail.js';

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

// A central-inbox message: forwarded from vendor@gmail.com, BCC original means
// To: is the AMC, and the central inbox address appears in a Delivered-To.
function centralMessage({ headers, html = ORDER_EMAIL_HTML } = {}) {
  return {
    id: 'msg1',
    payload: {
      headers: headers || [
        { name: 'Subject', value: ORDER_EMAIL_SUBJECT },
        { name: 'To', value: 'notifications@valuelinkams.com' },
        { name: 'Delivered-To', value: 'central@ops.example.com' },
        { name: 'Delivered-To', value: 'vendor@gmail.com' },
        { name: 'X-Forwarded-For', value: 'vendor@gmail.com central@ops.example.com' },
      ],
      parts: [{ mimeType: 'text/html', body: { data: b64url(html) } }],
    },
  };
}

function fetchFor(message) {
  return async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT' });
    if (String(url).includes('/history')) {
      return jsonResponse({ historyId: '99', history: [{ messagesAdded: [{ message: { id: 'msg1' } }] }] });
    }
    if (String(url).includes('/messages/msg1')) return jsonResponse(message);
    throw new Error('unexpected url ' + url);
  };
}

function pushBody(emailAddress = 'central@ops.example.com', historyId = 60) {
  const inner = JSON.stringify({ emailAddress, historyId });
  return { message: { data: Buffer.from(inner).toString('base64'), messageId: 'm' } };
}

test('decodes a Pub/Sub push envelope', () => {
  const out = decodePubSubPush(pushBody('a@gmail.com', 12345));
  assert.equal(out.emailAddress, 'a@gmail.com');
  assert.equal(out.historyId, '12345');
});

test('decodes a Gmail message into html/text/subject/headers', () => {
  const d = decodeGmailMessage(centralMessage());
  assert.equal(d.subject, ORDER_EMAIL_SUBJECT);
  assert.match(d.html, /ACCEPT ORDER/);
  assert.ok(Array.isArray(d.headers));
  assert.ok(d.headers.some((h) => h.name === 'X-Forwarded-For'));
});

test('handlePush attributes a forwarded order to the registered user and emits it', async () => {
  const orders = [];
  let savedHistory = null;
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => 'RT',
    resolveUser: (address) =>
      address === 'vendor@gmail.com' ? { id: 'acct1', label: 'v1', forwardingEmail: 'vendor@gmail.com' } : null,
    getHistoryId: async () => '50',
    saveHistoryId: async (hid) => {
      savedHistory = hid;
    },
    onOrder: (o) => orders.push(o),
    fetchImpl: fetchFor(centralMessage()),
  });

  const res = await watcher.handlePush(pushBody());

  assert.equal(res.handled, 1);
  assert.equal(res.unattributed, 0);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '266-03335');
  assert.equal(orders[0].accountId, 'acct1');
  assert.equal(orders[0].forwardingEmail, 'vendor@gmail.com');
  assert.match(orders[0].acceptUrl, /order\/accept/);
  assert.match(orders[0].declineUrl, /order\/decline/);
  assert.equal(orders[0].source, 'gmail');
  assert.equal(savedHistory, '99');
});

function messageWithId(id, html = ORDER_EMAIL_HTML) {
  return {
    id,
    payload: {
      headers: [
        { name: 'Subject', value: ORDER_EMAIL_SUBJECT },
        { name: 'To', value: 'notifications@valuelinkams.com' },
        { name: 'Delivered-To', value: 'central@ops.example.com' },
        { name: 'Delivered-To', value: 'vendor@gmail.com' },
        { name: 'X-Forwarded-For', value: 'vendor@gmail.com central@ops.example.com' },
      ],
      parts: [{ mimeType: 'text/html', body: { data: b64url(html) } }],
    },
  };
}

test('_pull fetches/attributes/dispatches a batch of new order emails concurrently, not one at a time', async () => {
  const MESSAGE_LATENCY_MS = 40;
  let inFlight = 0;
  let maxInFlight = 0;
  const messages = { msgA: messageWithId('msgA'), msgB: messageWithId('msgB'), msgC: messageWithId('msgC') };

  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT' });
    if (u.includes('/history')) {
      return jsonResponse({
        historyId: '100',
        history: [
          {
            messagesAdded: [
              { message: { id: 'msgA' } },
              { message: { id: 'msgB' } },
              { message: { id: 'msgC' } },
            ],
          },
        ],
      });
    }
    const m = u.match(/\/messages\/(\w+)/);
    if (m) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, MESSAGE_LATENCY_MS));
      inFlight--;
      return jsonResponse(messages[m[1]]);
    }
    throw new Error('unexpected url ' + u);
  };

  const orders = [];
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => 'RT',
    resolveUser: (address) =>
      address === 'vendor@gmail.com' ? { id: 'acct1', label: 'v1', forwardingEmail: 'vendor@gmail.com' } : null,
    getHistoryId: async () => '50',
    saveHistoryId: async () => {},
    onOrder: (o) => orders.push(o),
    fetchImpl,
  });

  const startedAt = Date.now();
  const res = await watcher.handlePush(pushBody());
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.handled, 3);
  assert.equal(orders.length, 3);
  // 3 messages sequentially would cost >= 3 * MESSAGE_LATENCY_MS just for the
  // messages.get round-trips. Concurrent dispatch should land close to ONE
  // round-trip's worth of wall-clock time.
  assert.ok(
    elapsedMs < MESSAGE_LATENCY_MS * 2,
    `expected concurrent fetch (< ${MESSAGE_LATENCY_MS * 2}ms), took ${elapsedMs}ms`
  );
  assert.ok(maxInFlight >= 2, `expected overlapping in-flight message fetches, saw max ${maxInFlight}`);
});

test('_pull isolates one bad message so the rest of the batch and the cursor advance are not lost', async () => {
  let savedHistory = null;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT' });
    if (u.includes('/history')) {
      return jsonResponse({
        historyId: '101',
        history: [{ messagesAdded: [{ message: { id: 'bad' } }, { message: { id: 'good' } }] }],
      });
    }
    if (u.includes('/messages/bad')) return { ok: false, status: 500, json: async () => ({}) };
    if (u.includes('/messages/good')) return jsonResponse(messageWithId('good'));
    throw new Error('unexpected url ' + u);
  };

  const orders = [];
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => 'RT',
    resolveUser: (address) =>
      address === 'vendor@gmail.com' ? { id: 'acct1', label: 'v1', forwardingEmail: 'vendor@gmail.com' } : null,
    getHistoryId: async () => '50',
    saveHistoryId: async (hid) => {
      savedHistory = hid;
    },
    onOrder: (o) => orders.push(o),
    fetchImpl,
  });

  const res = await watcher.handlePush(pushBody());
  assert.equal(res.handled, 1, 'the good message should still be handled');
  assert.equal(orders.length, 1);
  assert.equal(savedHistory, '101', 'cursor should still advance despite one message failing');
});

test('handlePush quarantines an order it cannot attribute (no emit)', async () => {
  const orders = [];
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => 'RT',
    resolveUser: () => null, // nobody registered
    getHistoryId: async () => '50',
    saveHistoryId: async () => {},
    onOrder: (o) => orders.push(o),
    fetchImpl: fetchFor(centralMessage()),
  });

  const res = await watcher.handlePush(pushBody());
  assert.equal(res.handled, 0);
  assert.equal(res.unattributed, 1);
  assert.equal(orders.length, 0);
});

test('handlePush no-ops when the central inbox is not connected', async () => {
  const orders = [];
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => null,
    resolveUser: () => ({ id: 'acct1' }),
    getHistoryId: async () => null,
    saveHistoryId: async () => {},
    onOrder: (o) => orders.push(o),
    fetchImpl: async () => {
      throw new Error('should not fetch when disconnected');
    },
  });
  const res = await watcher.handlePush(pushBody());
  assert.equal(res.handled, 0);
  assert.equal(orders.length, 0);
});

test('poll() fetches new forwarded orders since the cursor and routes them', async () => {
  const orders = [];
  let savedHistory = null;
  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT' });
    if (s.includes('/profile')) return jsonResponse({ emailAddress: 'central@ops.example.com', historyId: '100' });
    if (s.includes('/history')) {
      return jsonResponse({ historyId: '120', history: [{ messagesAdded: [{ message: { id: 'msg1' } }] }] });
    }
    if (s.includes('/messages/msg1')) return jsonResponse(centralMessage());
    throw new Error('unexpected url ' + url);
  };
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => 'RT',
    resolveUser: (a) => (a === 'vendor@gmail.com' ? { id: 'acct1', forwardingEmail: 'vendor@gmail.com' } : null),
    getHistoryId: async () => '90',
    saveHistoryId: async (hid) => {
      savedHistory = hid;
    },
    onOrder: (o) => orders.push(o),
    fetchImpl,
  });

  const res = await watcher.poll();
  assert.equal(res.handled, 1);
  assert.equal(orders[0].orderId, '266-03335');
  assert.equal(orders[0].accountId, 'acct1');
  assert.equal(savedHistory, '120'); // cursor advanced
});

test('poll() no-ops when the inbox is not connected', async () => {
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => null,
    resolveUser: () => null,
    getHistoryId: async () => null,
    saveHistoryId: async () => {},
    onOrder: () => {},
    fetchImpl: async () => {
      throw new Error('should not fetch when disconnected');
    },
  });
  const res = await watcher.poll();
  assert.equal(res.handled, 0);
  assert.equal(res.connected, false);
});

function dryRunFetch(message) {
  return async (url) => {
    const s = String(url);
    if (s.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT' });
    if (s.includes('/profile')) return jsonResponse({ emailAddress: 'central@ops.example.com', historyId: '100' });
    if (s.includes('/messages/msg1')) return jsonResponse(message);
    if (s.includes('/messages')) return jsonResponse({ messages: [{ id: 'msg1' }] });
    throw new Error('unexpected url ' + url);
  };
}

function dryRunWatcher(resolveUser, message = centralMessage()) {
  return new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => 'RT',
    resolveUser,
    getHistoryId: async () => null,
    saveHistoryId: async () => {},
    onOrder: () => {
      throw new Error('dry-run must NOT emit/act on orders');
    },
    fetchImpl: dryRunFetch(message),
  });
}

test('dryRunRecent reports WOULD_ACCEPT for an in-region user (no portal action)', async () => {
  const w = dryRunWatcher((a) =>
    a === 'vendor@gmail.com' ? { id: 'fl', label: 'fl', forwardingEmail: 'vendor@gmail.com', regionStates: ['FL'] } : null
  );
  const rep = await w.dryRunRecent({ max: 5 });
  assert.equal(rep.orders.length, 1);
  assert.equal(rep.orders[0].decision, 'WOULD_ACCEPT');
  assert.equal(rep.orders[0].attributedTo, 'fl');
  assert.equal(rep.orders[0].orderId, '266-03335');
});

test('dryRunRecent reports WOULD_DECLINE for an out-of-region user', async () => {
  const w = dryRunWatcher((a) =>
    a === 'vendor@gmail.com' ? { id: 'tx', label: 'tx', forwardingEmail: 'vendor@gmail.com', regionStates: ['TX'] } : null
  );
  const rep = await w.dryRunRecent({ max: 5 });
  assert.equal(rep.orders[0].decision, 'WOULD_DECLINE');
});

test('dryRunRecent flags an order it cannot attribute', async () => {
  const w = dryRunWatcher(() => null);
  const rep = await w.dryRunRecent({ max: 5 });
  assert.equal(rep.orders[0].decision, 'unattributed');
  assert.ok(rep.orders[0].unmatchedCandidates.some((c) => c.address === 'vendor@gmail.com'));
});

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}
