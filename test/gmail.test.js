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

test('decodes a Pub/Sub push envelope', () => {
  const inner = JSON.stringify({ emailAddress: 'a@gmail.com', historyId: 12345 });
  const push = {
    message: { data: Buffer.from(inner).toString('base64'), messageId: 'm1', publishTime: 'now' },
  };
  const out = decodePubSubPush(push);
  assert.equal(out.emailAddress, 'a@gmail.com');
  assert.equal(out.historyId, '12345');
});

test('decodes a Gmail message into html/text/subject', () => {
  const message = {
    payload: {
      headers: [{ name: 'Subject', value: ORDER_EMAIL_SUBJECT }],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('plain body') } },
        { mimeType: 'text/html', body: { data: b64url(ORDER_EMAIL_HTML) } },
      ],
    },
  };
  const d = decodeGmailMessage(message);
  assert.equal(d.subject, ORDER_EMAIL_SUBJECT);
  assert.match(d.html, /ACCEPT ORDER/);
  assert.equal(d.text, 'plain body');
});

test('handlePush fetches new messages and emits a detected order (mocked fetch)', async () => {
  const orders = [];
  const message = {
    id: 'msg1',
    payload: {
      headers: [{ name: 'Subject', value: ORDER_EMAIL_SUBJECT }],
      parts: [{ mimeType: 'text/html', body: { data: b64url(ORDER_EMAIL_HTML) } }],
    },
  };

  // Mock the Google endpoints.
  const fetchImpl = async (url, init) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'AT' });
    }
    if (String(url).includes('/history')) {
      return jsonResponse({ historyId: '99', history: [{ messagesAdded: [{ message: { id: 'msg1' } }] }] });
    }
    if (String(url).includes('/messages/msg1')) {
      return jsonResponse(message);
    }
    throw new Error('unexpected url ' + url);
  };

  let savedHistory = null;
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getAccount: async (email) =>
      email === 'vendor@gmail.com' ? { refreshToken: 'RT', historyId: '50' } : null,
    saveHistoryId: async (email, hid) => {
      savedHistory = { email, hid };
    },
    onOrder: (o) => orders.push(o),
    fetchImpl,
  });

  const inner = JSON.stringify({ emailAddress: 'vendor@gmail.com', historyId: 60 });
  const res = await watcher.handlePush({ message: { data: Buffer.from(inner).toString('base64'), messageId: 'm' } });

  assert.equal(res.handled, 1);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].orderId, '266-03335');
  assert.match(orders[0].acceptUrl, /order\/accept/);
  assert.equal(orders[0].source, 'gmail');
  assert.deepEqual(savedHistory, { email: 'vendor@gmail.com', hid: '99' });
});

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}
