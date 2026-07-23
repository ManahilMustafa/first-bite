import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockPortal } from './mocks/mockPortal.js';
import { AccountWorker } from '../src/worker/worker.js';
import { MemoryLock } from '../src/lock/memoryLock.js';

// Integration tests use sub-second polls; disable the production floor.
process.env.PORTAL_POLL_FLOOR_MS = '0';

let portal;
before(async () => {
  portal = new MockPortal({ username: 'vendor1', password: 'pass1' });
  portal.addUser('vendor2', 'pass2');
  await portal.listen();
});
after(async () => {
  await portal.close();
});
beforeEach(() => {
  portal.reset();
  portal.emailLinkMode = 'standalone';
});

function makeWorker(creds, lock, opts = {}) {
  return new AccountWorker({
    account: {
      id: creds.username,
      label: creds.username,
      portalBaseUrl: portal.baseUrl,
      portalUsername: creds.username,
      portalPassword: creds.password,
      pollIntervalMs: 40,
    },
    lock,
    ...opts,
  });
}

const waitFor = async (cond, timeout = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

test('end-to-end: poller detects a new order and the worker accepts it', async () => {
  const lock = new MemoryLock();
  const events = [];
  const worker = makeWorker({ username: 'vendor1', password: 'pass1' }, lock, {
    onResult: (e) => events.push(e),
  });
  try {
    await worker.start(); // baseline primed with zero orders

    const appearedAt = Date.now();
    portal.addOrder('266-03335', { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });

    const ok = await waitFor(
      () => portal.orderStatus('266-03335') === 'accepted' && events.length >= 1,
      5000
    );
    assert.equal(ok, true, 'order should be accepted and event reported');
    assert.equal(events[0].accepted, true);

    const latency = Date.now() - appearedAt;
    assert.ok(latency < 1500, `detection->accept latency ${latency}ms within bound`);
  } finally {
    await worker.stop();
  }
});

test('region filter DECLINES out-of-region orders and ACCEPTS in-region ones', async () => {
  const lock = new MemoryLock();
  const worker = new AccountWorker({
    account: {
      id: 'vendor1',
      label: 'vendor1',
      portalBaseUrl: portal.baseUrl,
      portalUsername: 'vendor1',
      portalPassword: 'pass1',
      pollIntervalMs: 40,
      regionZipPrefixes: ['32'],
    },
    lock,
    poll: false,
  });
  try {
    await worker.start();

    // Out-of-region: FL 34613 (prefix 34) is not in ['32'] → actively declined.
    const oor = portal.addOrder('266-03335', {
      address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613',
      emailOwner: 'vendor1',
    });
    const declined = await worker.handleOrder({
      orderId: oor,
      source: 'gmail',
      acceptUrl: portal.emailAcceptUrl(oor),
      declineUrl: portal.emailDeclineUrl(oor),
      address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613',
    });
    assert.equal(declined.action, 'decline');
    assert.equal(declined.declined, true);
    assert.equal(declined.reason, 'zip_mismatch');
    assert.equal(worker.stats.declined, 1);
    assert.equal(portal.orderStatus(oor), 'declined');

    // In-region: Jacksonville FL 32207 (prefix 32) → accepted.
    portal.addOrder('900-00002', { address: '100 MAIN ST JACKSONVILLE FL 32207' });
    const accepted = await worker.handleOrder({
      orderId: '900-00002',
      source: 'portal',
      address: '100 MAIN ST JACKSONVILLE FL 32207',
    });
    assert.equal(accepted.accepted, true);
  } finally {
    await worker.stop();
  }
});

test('dedup: two concurrent detections of the same order cause ONE accept', async () => {
  const lock = new MemoryLock();
  portal.addOrder('900-00001');
  const worker = makeWorker({ username: 'vendor1', password: 'pass1' }, lock, { poll: false });
  await worker.start();

  const [a, b] = await Promise.all([
    worker.handleOrder({ orderId: '900-00001', source: 'gmail' }),
    worker.handleOrder({ orderId: '900-00001', source: 'portal' }),
  ]);

  const accepted = [a, b].filter((r) => r.accepted).length;
  const deduped = [a, b].filter((r) => r.deduped).length;
  assert.equal(accepted, 1, 'exactly one accept');
  assert.equal(deduped, 1, 'the other was deduped by the lock');

  // Only ONE accept attempt reached the portal for this order.
  const attempts = portal.acceptAttempts.filter((x) => x.orderId === '900-00001');
  assert.equal(attempts.length, 1, 'lock prevented a duplicate accept call');
  await worker.stop();
});

test('race: two accounts compete for one broadcast order, exactly one wins', async () => {
  const lock = new MemoryLock();
  portal.addOrder('777-00007');

  const w1 = makeWorker({ username: 'vendor1', password: 'pass1' }, lock, { poll: false });
  const w2 = makeWorker({ username: 'vendor2', password: 'pass2' }, lock, { poll: false });
  await Promise.all([w1.start(), w2.start()]);

  const [r1, r2] = await Promise.all([
    w1.handleOrder({ orderId: '777-00007', source: 'portal' }),
    w2.handleOrder({ orderId: '777-00007', source: 'portal' }),
  ]);

  const winners = [r1, r2].filter((r) => r.accepted).length;
  const losers = [r1, r2].filter((r) => r.outcome === 'taken').length;
  assert.equal(winners, 1, 'exactly one account wins the order');
  assert.equal(losers, 1, 'the other sees it taken');
  assert.equal(portal.orderStatus('777-00007'), 'accepted');
  await Promise.all([w1.stop(), w2.stop()]);
});

test('accepted lock is retained so a late duplicate cannot re-fire', async () => {
  const lock = new MemoryLock();
  portal.addOrder('555-00005');
  const worker = makeWorker({ username: 'vendor1', password: 'pass1' }, lock, { poll: false });
  await worker.start();

  const first = await worker.handleOrder({ orderId: '555-00005', source: 'portal' });
  assert.equal(first.accepted, true);

  const late = await worker.handleOrder({ orderId: '555-00005', source: 'gmail' });
  assert.equal(late.deduped, true, 'late duplicate is suppressed by retained lock');

  const attempts = portal.acceptAttempts.filter((x) => x.orderId === '555-00005');
  assert.equal(attempts.length, 1);
  await worker.stop();
});
