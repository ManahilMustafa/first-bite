// End-to-end MULTI-USER + MULTI-PORTAL proof: two vendors, each with their OWN
// E-Street portal (separate hosts/logins) and OWN forwarding email + region, all
// flowing through ONE central Gmail inbox. Verifies every forwarded email is
// attributed to the correct account, acted on THAT vendor's own portal, and
// judged by THAT vendor's region rule.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MockPortal } from './mocks/mockPortal.js';
import { AccountsStore } from '../src/store/accountsStore.js';
import { AccountWorker } from '../src/worker/worker.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MemoryLock } from '../src/lock/memoryLock.js';
import { GmailWatcher } from '../src/detect/gmailWatcher.js';

const KEY = Buffer.alloc(32, 1);

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function orderEmailHtml(portal, id, address) {
  return `<html><body>
    <p>An order for the property at ${address} (Order no. ${id}) is available, for the following service: BPO Exterior.</p>
    <table><tr><td>Property Address:</td><td>${address}</td></tr></table>
    <p>
      <a href="${portal.emailAcceptUrl(id)}">ACCEPT ORDER</a>
      <a href="${portal.emailDeclineUrl(id)}">DECLINE ORDER</a>
    </p>
  </body></html>`;
}

// A central-inbox message forwarded FROM `from` (rides in X-Forwarded-For).
function message(id, from, html) {
  return {
    id,
    payload: {
      headers: [
        { name: 'Subject', value: 'Accept or decline order' },
        { name: 'To', value: 'notifications@valuelinkams.com' },
        { name: 'Delivered-To', value: 'central@ops.example.com' },
        { name: 'X-Forwarded-For', value: `${from} central@ops.example.com` },
      ],
      parts: [{ mimeType: 'text/html', body: { data: b64url(html) } }],
    },
  };
}

let portalA;
let portalB;
let storePath;
before(async () => {
  // Two INDEPENDENT portals — one per vendor (different hosts + logins).
  portalA = new MockPortal({ username: 'vendorA', password: 'pa' });
  portalB = new MockPortal({ username: 'vendorB', password: 'pb' });
  await portalA.listen();
  await portalB.listen();
  storePath = join(tmpdir(), `multi-${randomUUID()}.json`);
});
after(async () => {
  await portalA.close();
  await portalB.close();
  await rm(storePath, { force: true });
});

test('multiple users + multiple portals routed independently through one inbox', async () => {
  const store = new AccountsStore({ path: storePath, key: KEY });
  const idA = await store.upsert({
    label: 'A', portalBaseUrl: portalA.baseUrl, portalUsername: 'vendorA', portalPassword: 'pa',
    forwardingEmail: 'a@vendor.com', regionStates: ['FL'],
  });
  const idB = await store.upsert({
    label: 'B', portalBaseUrl: portalB.baseUrl, portalUsername: 'vendorB', portalPassword: 'pb',
    forwardingEmail: 'b@vendor.com', regionStates: ['TX'],
  });

  const lock = new MemoryLock();
  const orchestrator = new Orchestrator({
    store,
    lock,
    workerFactory: (account) => new AccountWorker({ account, lock, poll: false }),
  });
  await orchestrator.sync();

  const FL1 = '100-0001'; // A, in-region (FL)  -> A accepts on portalA
  const TX2 = '100-0002'; // B, in-region (TX)  -> B accepts on portalB
  const TX3 = '100-0003'; // A, OUT-of-region   -> A declines on portalA
  portalA.addOrder(FL1, { address: '100 MAIN ST MIAMI FL 33101', emailOwner: 'vendorA' });
  portalB.addOrder(TX2, { address: '200 OAK ST DALLAS TX 75001', emailOwner: 'vendorB' });
  portalA.addOrder(TX3, { address: '300 ELM ST AUSTIN TX 78701', emailOwner: 'vendorA' });

  const msgs = {
    m1: message('m1', 'a@vendor.com', orderEmailHtml(portalA, FL1, '100 MAIN ST MIAMI FL 33101')),
    m2: message('m2', 'b@vendor.com', orderEmailHtml(portalB, TX2, '200 OAK ST DALLAS TX 75001')),
    m3: message('m3', 'a@vendor.com', orderEmailHtml(portalA, TX3, '300 ELM ST AUSTIN TX 78701')),
  };
  const fetchImpl = async (url) => {
    const s = String(url);
    if (s.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT' });
    if (s.includes('/history')) {
      return jsonResponse({
        historyId: '300',
        history: [{ messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }, { message: { id: 'm3' } }] }],
      });
    }
    const m = s.match(/\/messages\/(m\d)/);
    if (m) return jsonResponse(msgs[m[1]]);
    throw new Error('unexpected url ' + url);
  };

  const routed = [];
  const watcher = new GmailWatcher({
    oauth: { clientId: 'c', clientSecret: 's' },
    getRefreshToken: async () => 'RT',
    resolveUser: (addr) => store.findByForwardingEmail(addr), // attribution by forwardingEmail
    getHistoryId: async () => '250',
    saveHistoryId: async () => {},
    onOrder: (o) => routed.push(orchestrator.routeOrderToAccount(o.accountId, o)),
    fetchImpl,
  });

  const res = await watcher.handlePush({
    message: { data: Buffer.from(JSON.stringify({ emailAddress: 'central@ops.example.com', historyId: 300 })).toString('base64') },
  });
  assert.equal(res.handled, 3, 'all three attributed');
  const events = await Promise.all(routed);

  // Each order acted on its OWN vendor's portal, by the right login:
  assert.equal(portalA.orders.get(FL1).status, 'accepted');
  assert.equal(portalA.orders.get(FL1).acceptedBy, 'vendorA');
  assert.equal(portalB.orders.get(TX2).status, 'accepted');
  assert.equal(portalB.orders.get(TX2).acceptedBy, 'vendorB');
  assert.equal(portalA.orders.get(TX3).status, 'declined');
  assert.equal(portalA.orders.get(TX3).declinedBy, 'vendorA');

  // B's portal never saw A's orders, and vice-versa (isolation).
  assert.equal(portalB.orders.has(FL1), false);
  assert.equal(portalA.orders.has(TX2), false);

  // Event stream maps each order to the correct account + decision.
  const byOrder = Object.fromEntries(events.filter(Boolean).map((e) => [e.orderId, e]));
  assert.equal(byOrder[FL1].accountId, idA);
  assert.equal(byOrder[FL1].accepted, true);
  assert.equal(byOrder[TX2].accountId, idB);
  assert.equal(byOrder[TX2].accepted, true);
  assert.equal(byOrder[TX3].accountId, idA);
  assert.equal(byOrder[TX3].declined, true);

  await orchestrator.shutdown();
});

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}
