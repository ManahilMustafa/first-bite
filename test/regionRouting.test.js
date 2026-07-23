// Per-user region routing: the SAME kind of order is accepted for one user and
// actively declined for another, purely from each user's own region rule.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockPortal } from './mocks/mockPortal.js';
import { AccountWorker } from '../src/worker/worker.js';
import { MemoryLock } from '../src/lock/memoryLock.js';

const FL_ADDR = '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613';
const TX_ADDR = '100 MAIN ST DALLAS TX 75001';

let portal;
before(async () => {
  portal = new MockPortal({ username: 'flvendor', password: 'p' });
  portal.addUser('txvendor', 'p');
  await portal.listen();
});
after(async () => {
  await portal.close();
});
beforeEach(() => {
  portal.reset();
  portal.emailLinkMode = 'standalone';
});

function makeWorker(username, region, lock, opts = {}) {
  return new AccountWorker({
    account: {
      id: username,
      label: username,
      portalBaseUrl: portal.baseUrl,
      portalUsername: username,
      portalPassword: 'p',
      ...region,
    },
    lock,
    poll: false,
    ...opts,
  });
}

function emailOrder(id, addr, meta) {
  return {
    orderId: id,
    source: 'gmail',
    acceptUrl: portal.emailAcceptUrl(id),
    declineUrl: portal.emailDeclineUrl(id),
    address: addr,
    ...meta,
  };
}

test('FL user (zip rule) ACCEPTS an in-region FL order', async () => {
  const w = makeWorker('flvendor', { regionZipPrefixes: ['32', '33', '34'] }, new MemoryLock());
  await w.start();
  const id = portal.addOrder('266-1001', { address: FL_ADDR, emailOwner: 'flvendor' });
  const ev = await w.handleOrder(emailOrder(id, FL_ADDR, { zip: '34613', state: 'FL' }));
  assert.equal(ev.action, 'accept');
  assert.equal(ev.accepted, true);
  assert.equal(portal.orderStatus(id), 'accepted');
  await w.stop();
});

test('FL user (zip rule) DECLINES an out-of-region TX order', async () => {
  const w = makeWorker('flvendor', { regionZipPrefixes: ['32', '33', '34'] }, new MemoryLock());
  await w.start();
  const id = portal.addOrder('266-2002', { address: TX_ADDR, emailOwner: 'flvendor' });
  const ev = await w.handleOrder(emailOrder(id, TX_ADDR, { zip: '75001', state: 'TX' }));
  assert.equal(ev.action, 'decline');
  assert.equal(ev.declined, true);
  assert.equal(portal.orderStatus(id), 'declined');
  await w.stop();
});

test('same TX order: FL user declines it, TX user accepts it', async () => {
  const fl = makeWorker('flvendor', { regionZipPrefixes: ['32', '33', '34'] }, new MemoryLock());
  const tx = makeWorker('txvendor', { regionStates: ['TX'] }, new MemoryLock());
  await fl.start();
  await tx.start();

  const flId = portal.addOrder('266-3003', { address: TX_ADDR, emailOwner: 'flvendor' });
  const txId = portal.addOrder('266-3004', { address: TX_ADDR, emailOwner: 'txvendor' });

  const flEv = await fl.handleOrder(emailOrder(flId, TX_ADDR, { zip: '75001', state: 'TX' }));
  const txEv = await tx.handleOrder(emailOrder(txId, TX_ADDR, { zip: '75001', state: 'TX' }));

  assert.equal(flEv.action, 'decline');
  assert.equal(portal.orderStatus(flId), 'declined');
  assert.equal(txEv.action, 'accept');
  assert.equal(portal.orderStatus(txId), 'accepted');

  await fl.stop();
  await tx.stop();
});

test('region undetermined (no parseable zip/state) is skipped, not declined', async () => {
  const w = makeWorker('flvendor', { regionZipPrefixes: ['32', '33', '34'] }, new MemoryLock());
  await w.start();
  const id = portal.addOrder('266-4004', { address: FL_ADDR });
  const ev = await w.handleOrder({
    orderId: id,
    source: 'gmail',
    acceptUrl: portal.emailAcceptUrl(id),
    declineUrl: portal.emailDeclineUrl(id),
    address: undefined,
    zip: undefined,
    state: undefined,
  });
  assert.equal(ev.action, 'skip');
  assert.equal(ev.reason, 'region_unknown');
  assert.equal(portal.orderStatus(id), 'available'); // untouched
  await w.stop();
});

test('poller-detected out-of-region order declines via the portal (no email link)', async () => {
  const w = makeWorker('flvendor', { regionStates: ['FL'] }, new MemoryLock());
  await w.start();
  const id = portal.addOrder('266-5005', { address: TX_ADDR });
  // source 'portal' => no acceptUrl/declineUrl; decline must go through the portal.
  const ev = await w.handleOrder({ orderId: id, source: 'portal', address: TX_ADDR, zip: '75001', state: 'TX' });
  assert.equal(ev.action, 'decline');
  assert.equal(ev.declined, true);
  assert.equal(portal.orderStatus(id), 'declined');
  await w.stop();
});

test('decline falls back to the portal when the email DECLINE link bounces to login', async () => {
  portal.emailLinkMode = 'needs_login';
  const w = makeWorker('flvendor', { regionStates: ['FL'] }, new MemoryLock());
  await w.start();
  const id = portal.addOrder('266-6006', { address: TX_ADDR, emailOwner: 'flvendor' });
  const ev = await w.handleOrder(emailOrder(id, TX_ADDR, { zip: '75001', state: 'TX' }));
  assert.equal(ev.declined, true);
  assert.equal(portal.orderStatus(id), 'declined');
  await w.stop();
});

test('a second detection of the same order is deduped (exactly-once)', async () => {
  const lock = new MemoryLock();
  const w = makeWorker('flvendor', { regionZipPrefixes: ['34'] }, lock);
  await w.start();
  const id = portal.addOrder('266-7007', { address: FL_ADDR, emailOwner: 'flvendor' });
  const first = await w.handleOrder(emailOrder(id, FL_ADDR, { zip: '34613', state: 'FL' }));
  const second = await w.handleOrder(emailOrder(id, FL_ADDR, { zip: '34613', state: 'FL' }));
  assert.equal(first.accepted, true);
  assert.equal(second.deduped, true);
  await w.stop();
});
