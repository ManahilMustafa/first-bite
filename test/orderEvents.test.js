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

test('list() filters by dryRun and since', async () => {
  const s = newStore();
  await s.record({ ts: 1000, accountId: 'a', orderId: '1', action: 'accept', accepted: true, dryRun: false });
  await s.record({ ts: 2000, accountId: 'a', orderId: '2', action: 'detected', outcome: 'would_accept', dryRun: true });
  await s.record({ ts: 3000, accountId: 'a', orderId: '3', action: 'accept', accepted: true }); // no dryRun field at all

  const live = await s.list({ dryRun: false });
  assert.deepEqual(live.map((e) => e.orderId).sort(), ['1', '3'], 'missing dryRun field counts as live');

  const scans = await s.list({ dryRun: true });
  assert.deepEqual(scans.map((e) => e.orderId), ['2']);

  const both = await s.list({});
  assert.equal(both.length, 3, 'omitting dryRun returns everything');

  const recent = await s.list({ since: 2500 });
  assert.deepEqual(recent.map((e) => e.orderId), ['3']);
  await rm(s.path, { force: true });
});

test('legacy events (recorded before the dryRun flag existed) are classified without it', async () => {
  const s = newStore();
  // Pre-existing 'detected' rows are exclusively a scan artifact — the live
  // pipeline never uses that action name — so they count as dryRun regardless.
  await s.record({ ts: 1000, orderId: '1', action: 'detected', outcome: 'would_accept' });
  // A legacy live miss always carried a `candidates` array (even empty).
  await s.record({ ts: 2000, orderId: '2', action: 'unattributed', candidates: [] });
  // A legacy scan-recorded miss never did.
  await s.record({ ts: 3000, orderId: '3', action: 'unattributed' });

  const live = await s.list({ dryRun: false });
  assert.deepEqual(live.map((e) => e.orderId), ['2']);

  const scans = await s.list({ dryRun: true });
  assert.deepEqual(scans.map((e) => e.orderId).sort(), ['1', '3']);
  await rm(s.path, { force: true });
});

test('stats() excludes dryRun (inbox-scan preview) events entirely', async () => {
  const s = newStore();
  const now = 1_700_000_000_000;
  await s.record({ ts: now - 1000, accountId: 'a', account: 'A', orderId: '1', action: 'accept', accepted: true, dryRun: false });
  await s.record({ ts: now - 1000, accountId: 'a', account: 'A', orderId: '2', action: 'detected', outcome: 'would_accept', dryRun: true });

  const st = await s.stats(now);
  assert.equal(st.overall.detected, 1, 'the dry-run preview must not inflate real stats');
  const a = st.byAccount.find((x) => x.accountId === 'a');
  assert.equal(a.total.detected, 1);
  await rm(s.path, { force: true });
});

test('liveOrders() collapses repeated attempts for the same order into ONE record', async () => {
  const s = newStore();
  await s.record({
    ts: 1000, accountId: 'a', account: 'A', orderId: '266-1', source: 'gmail',
    action: 'accept', accepted: false, outcome: 'needs_login', dryRun: false,
  });
  await s.record({
    ts: 2000, accountId: 'a', account: 'A', orderId: '266-1', source: 'gmail',
    action: 'accept', accepted: true, outcome: 'accepted', dryRun: false,
  });
  // A different order, and a dry-run preview that must never leak into liveOrders().
  await s.record({ ts: 1500, accountId: 'a', account: 'A', orderId: '266-2', action: 'skip', reason: 'region_unknown', dryRun: false });
  await s.record({ ts: 1600, accountId: 'a', account: 'A', orderId: '266-3', action: 'detected', outcome: 'would_accept', dryRun: true });

  const orders = await s.liveOrders();
  assert.equal(orders.length, 2, 'the scan preview (266-3) must be excluded, and 266-1 collapsed to one row');

  const o1 = orders.find((o) => o.orderId === '266-1');
  assert.equal(o1.status, 'accepted', 'the eventual success wins over the earlier needs_login attempt');
  assert.equal(o1.attemptCount, 2);
  assert.equal(o1.firstDetectedAt, 1000);
  assert.equal(o1.lastUpdatedAt, 2000);
  assert.ok(o1.timeline.length > 0);

  const o2 = orders.find((o) => o.orderId === '266-2');
  assert.equal(o2.status, 'outside_region');
  await rm(s.path, { force: true });
});

test('liveOrders() respects since (activation cutoff) and sorts newest-updated first', async () => {
  const s = newStore();
  await s.record({ ts: 1000, accountId: 'a', account: 'A', orderId: '1', action: 'accept', accepted: true, dryRun: false });
  await s.record({ ts: 5000, accountId: 'a', account: 'A', orderId: '2', action: 'accept', accepted: true, dryRun: false });

  const all = await s.liveOrders();
  assert.deepEqual(all.map((o) => o.orderId), ['2', '1'], 'newest lastUpdatedAt first');

  const sinceCut = await s.liveOrders({ since: 3000 });
  assert.deepEqual(sinceCut.map((o) => o.orderId), ['2']);
  await rm(s.path, { force: true });
});

test('aggregates per-account day/week/month rolling windows', async () => {
  const s = newStore();
  const now = 1_700_000_000_000;
  await s.record({ ts: now - 1000, accountId: 'a', account: 'A', orderId: '1', action: 'accept', accepted: true }); // <24h
  await s.record({ ts: now - 3 * DAY, accountId: 'a', account: 'A', orderId: '2', action: 'decline', declined: true }); // <7d
  await s.record({ ts: now - 20 * DAY, accountId: 'a', account: 'A', orderId: '3', action: 'accept', accepted: true }); // <30d
  await s.record({ ts: now - 60 * DAY, accountId: 'a', account: 'A', orderId: '4', action: 'accept', accepted: true }); // older
  // candidates:[] matches how the live onUnattributed handler always tags a
  // real (non-scan) unattributed detection — see isDryRun() in the store.
  await s.record({ ts: now - 1000, accountId: null, account: '(unattributed)', orderId: '5', action: 'unattributed', candidates: [] });

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
  // Every scan-recorded row is tagged dryRun so the live dashboard can hide it by default.
  assert.ok(od.orders.every((o) => o.dryRun === true));

  res = await fetch(`${base}/api/orders?dryRun=false`, auth);
  assert.equal((await res.json()).orders.length, 0, 'live-only view must not show scan previews');

  res = await fetch(`${base}/api/orders?dryRun=true`, auth);
  assert.equal((await res.json()).orders.length, 2);

  await new Promise((r) => server.close(r));
  await rm(s.path, { force: true });
});

test('GET /api/orders?since= hides events before the cutoff', async () => {
  const s = newStore();
  await s.record({ ts: 1000, accountId: 'a', account: 'A', orderId: '266-1', action: 'accept', accepted: true, dryRun: false });
  await s.record({ ts: 5000, accountId: 'a', account: 'A', orderId: '266-2', action: 'accept', accepted: true, dryRun: false });

  const server = createControlPlane({
    store: {},
    orchestrator: { status: () => [] },
    eventsStore: s,
    config: { adminToken: 't' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { headers: { authorization: 'Bearer t' } };

  const res = await fetch(`${base}/api/orders?since=3000`, auth);
  const od = await res.json();
  assert.deepEqual(od.orders.map((o) => o.orderId), ['266-2']);

  await new Promise((r) => server.close(r));
  await rm(s.path, { force: true });
});

test('GET /api/orders/live returns grouped orders and honors an accounts store activatedAt cutoff', async () => {
  const s = newStore();
  await s.record({ ts: 500, accountId: 'a', account: 'A', orderId: '266-1', action: 'accept', accepted: true, dryRun: false }); // before go-live
  await s.record({ ts: 1000, accountId: 'a', account: 'A', orderId: '266-1', action: 'accept', accepted: false, outcome: 'needs_login', dryRun: false });
  await s.record({ ts: 2000, accountId: 'a', account: 'A', orderId: '266-1', action: 'accept', accepted: true, outcome: 'accepted', dryRun: false });
  await s.record({ ts: 1600, accountId: 'a', account: 'A', orderId: '266-2', action: 'detected', outcome: 'would_accept', dryRun: true });

  const fakeStore = { list: async () => [{ activatedAt: 900 }] };
  const server = createControlPlane({
    store: fakeStore,
    orchestrator: { status: () => [] },
    eventsStore: s,
    config: { adminToken: 't' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { headers: { authorization: 'Bearer t' } };

  const res = await fetch(`${base}/api/orders/live`, auth);
  const od = await res.json();
  assert.equal(od.orders.length, 1, 'one grouped order (the dry-run preview is excluded)');
  assert.equal(od.orders[0].orderId, '266-1');
  assert.equal(od.orders[0].status, 'accepted');
  assert.equal(od.orders[0].attemptCount, 2, 'the ts:500 attempt is before the activatedAt cutoff and excluded');

  await new Promise((r) => server.close(r));
  await rm(s.path, { force: true });
});

test('GET /api/latency-report returns a stage breakdown for real events, excluding dry-run previews', async () => {
  const s = newStore();
  await s.record({
    ts: 1000, accountId: 'a', account: 'A', orderId: '1', action: 'accept', accepted: true, dryRun: false,
    detectionLatencyMs: 400, lockWaitMs: 1, durationMs: 150, verifyDurationMs: 30, totalMs: 581,
  });
  await s.record({ ts: 1500, accountId: 'a', account: 'A', orderId: '2', action: 'detected', outcome: 'would_accept', dryRun: true });

  const server = createControlPlane({
    store: {},
    orchestrator: { status: () => [] },
    eventsStore: s,
    config: { adminToken: 't' },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { headers: { authorization: 'Bearer t' } };

  const res = await fetch(`${base}/api/latency-report`, auth);
  const report = await res.json();
  assert.equal(report.sampleSize, 1, 'the dry-run preview must not count toward the report');
  assert.equal(report.stages.durationMs.count, 1);
  assert.equal(report.bottleneck.key, 'detectionLatencyMs');

  await new Promise((r) => server.close(r));
  await rm(s.path, { force: true });
});
