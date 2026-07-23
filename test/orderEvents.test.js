import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { OrderEventsStore } from '../src/store/orderEventsStore.js';
import { createControlPlane } from '../src/controlPlane/server.js';

function newStore() {
  return new OrderEventsStore({ path: join(tmpdir(), `orders-${randomUUID()}.jsonl`) });
}

const DAY = 86400000;

test('records and lists newest-first, with action/account filters', async () => {
  const s = newStore();
  await s.record({ ts: 1000, accountId: 'a', account: 'A', orderId: '1', action: 'accept', accepted: true });
  await s.record({ ts: 2000, accountId: 'a', account: 'A', orderId: '2', action: 'decline', declined: true });
  await s.record({ ts: 3000, accountId: 'b', account: 'B', orderId: '3', action: 'skip' });

  const all = await s.list();
  assert.equal(all.length, 3);
  assert.equal(all[0].orderId, '3', 'newest first');

  const declines = await s.list({ action: 'decline' });
  assert.equal(declines.length, 1);
  assert.equal(declines[0].orderId, '2');

  const acctB = await s.list({ accountId: 'b' });
  assert.equal(acctB.length, 1);
  await rm(s.path, { force: true });
});

test('aggregates per-account day/week/month rolling windows', async () => {
  const s = newStore();
  const now = 1_700_000_000_000;
  await s.record({ ts: now - 1000, accountId: 'a', account: 'A', orderId: '1', action: 'accept', accepted: true }); // <24h
  await s.record({ ts: now - 3 * DAY, accountId: 'a', account: 'A', orderId: '2', action: 'decline', declined: true }); // <7d
  await s.record({ ts: now - 20 * DAY, accountId: 'a', account: 'A', orderId: '3', action: 'accept', accepted: true }); // <30d
  await s.record({ ts: now - 60 * DAY, accountId: 'a', account: 'A', orderId: '4', action: 'accept', accepted: true }); // older
  await s.record({ ts: now - 1000, accountId: null, account: '(unattributed)', orderId: '5', action: 'unattributed' });

  const st = await s.stats(now);
  const a = st.byAccount.find((x) => x.accountId === 'a');
  assert.equal(a.day.accepted, 1);
  assert.equal(a.day.detected, 1);
  assert.equal(a.week.detected, 2);
  assert.equal(a.week.declined, 1);
  assert.equal(a.month.detected, 3);
  assert.equal(a.total.detected, 4);
  assert.equal(a.total.accepted, 3);

  const un = st.byAccount.find((x) => x.accountId === null);
  assert.equal(un.total.unattributed, 1);
  assert.equal(st.overall.detected, 5);
  assert.equal(st.overall.accepted, 3);
  await rm(s.path, { force: true });
});

test('GET /api/orders and /api/stats serve recorded events (auth enforced)', async () => {
  const s = newStore();
  await s.record({ ts: Date.now(), accountId: 'a', account: 'A', orderId: '266-1', action: 'accept', accepted: true });
  await s.record({ ts: Date.now(), accountId: 'a', account: 'A', orderId: '266-2', action: 'decline', declined: true });

  const server = createControlPlane({
    store: {},
    orchestrator: { status: () => [] },
    eventsStore: s,
    config: { adminToken: 't' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let res = await fetch(`${base}/api/orders`); // no token
  assert.equal(res.status, 401);

  res = await fetch(`${base}/api/orders`, { headers: { authorization: 'Bearer t' } });
  const od = await res.json();
  assert.equal(od.orders.length, 2);

  res = await fetch(`${base}/api/orders?action=accept`, { headers: { authorization: 'Bearer t' } });
  assert.equal((await res.json()).orders.length, 1);

  res = await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer t' } });
  const stt = await res.json();
  assert.equal(stt.overall.accepted, 1);
  assert.equal(stt.overall.declined, 1);

  await new Promise((r) => server.close(r));
  await rm(s.path, { force: true });
});

test('POST /api/orders/scan backfills detected inbox orders, deduped', async () => {
  const s = newStore();
  const fakeWatcher = {
    dryRunRecent: async () => ({
      scanned: 2,
      orders: [
        { orderId: '266-A', accountId: 'a', attributedTo: 'A', forwardingEmail: 'a@vendor.com', address: '1 X FL 34668', state: 'FL', zip: '34668', via: 'x-forwarded-for', decision: 'WOULD_ACCEPT' },
        { orderId: '266-B', accountId: null, attributedTo: null, address: '2 Y FL 34609', state: 'FL', zip: '34609', decision: 'unattributed', unmatchedCandidates: [{ address: 'rick@vendor.com', via: 'x-forwarded-for' }] },
      ],
    }),
  };
  const server = createControlPlane({
    store: {},
    orchestrator: { status: () => [] },
    eventsStore: s,
    gmailWatcher: fakeWatcher,
    config: { adminToken: 't' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { headers: { authorization: 'Bearer t' } };

  let res = await fetch(`${base}/api/orders/scan`, { method: 'POST', ...auth });
  assert.equal((await res.json()).recorded, 2);

  // Re-scanning the same inbox records nothing new.
  res = await fetch(`${base}/api/orders/scan`, { method: 'POST', ...auth });
  assert.equal((await res.json()).recorded, 0);

  // Feed now shows both, with the detected/would action.
  res = await fetch(`${base}/api/orders`, auth);
  const od = await res.json();
  assert.equal(od.orders.length, 2);
  assert.ok(od.orders.some((o) => o.action === 'detected' && o.outcome === 'would_accept' && o.forwardingEmail === 'a@vendor.com'));
  // Unattributed row carries the address we DID find (so the operator can register it).
  assert.ok(od.orders.some((o) => o.action === 'unattributed' && o.forwardingEmail === 'rick@vendor.com'));

  await new Promise((r) => server.close(r));
  await rm(s.path, { force: true });
});
