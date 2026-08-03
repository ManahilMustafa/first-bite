import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PortalPoller, isBlockSignal } from '../src/detect/portalPoller.js';
import { PortalHttpError } from '../src/portal/session.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('isBlockSignal', () => {
  test('detects PortalHttpError 403/429', () => {
    assert.equal(isBlockSignal(new PortalHttpError(403)), true);
    assert.equal(isBlockSignal(new PortalHttpError(429)), true);
    assert.equal(isBlockSignal(new PortalHttpError(500)), false);
  });

  test('detects timeout-like errors', () => {
    const err = new Error('connect ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    assert.equal(isBlockSignal(err), true);
  });
});

describe('PortalPoller interval floor', () => {
  test('clamps below floor when minIntervalMs is set', () => {
    const session = {
      username: 'u',
      routes: { newOrders: '/Orders/NewOrders.aspx' },
      authedGet: async () => ({ status: 200, body: '' }),
    };
    const poller = new PortalPoller({
      session,
      onOrder: () => {},
      intervalMs: 1000,
      minIntervalMs: 5000,
    });
    assert.equal(poller.intervalMs, 5000);
  });

  test('allows fast interval when floor is 0', () => {
    const session = {
      username: 'u',
      routes: { newOrders: '/Orders/NewOrders.aspx' },
      authedGet: async () => ({ status: 200, body: '' }),
    };
    const poller = new PortalPoller({
      session,
      onOrder: () => {},
      intervalMs: 40,
      minIntervalMs: 0,
    });
    assert.equal(poller.intervalMs, 40);
  });
});

describe('PortalPoller backoff + circuit', () => {
  test('429 lengthens backoff then circuit opens after threshold', async () => {
    let calls = 0;
    const session = {
      username: 'u',
      routes: { newOrders: '/Orders/NewOrders.aspx' },
      authedGet: async () => {
        calls++;
        throw new PortalHttpError(429);
      },
    };
    const poller = new PortalPoller({
      session,
      onOrder: () => {},
      intervalMs: 20,
      minIntervalMs: 0,
      circuitThreshold: 5,
      cooldownMs: 60_000,
    });
    poller.start();

    await waitFor(() => poller.paused === true, 3000);
    assert.equal(poller.paused, true);
    assert.ok(poller.stats.blockSignals >= 5);
    assert.equal(poller.stats.circuitOpens, 1);
    assert.ok(poller.currentBackoffMs >= 20);
    // After circuit open, no more immediate polls.
    const callsAtPause = calls;
    await sleep(80);
    assert.equal(calls, callsAtPause);

    poller.stop();
  });

  test('resume clears pause and polls again', async () => {
    let fail = true;
    let calls = 0;
    const session = {
      username: 'u',
      routes: { newOrders: '/Orders/NewOrders.aspx' },
      authedGet: async () => {
        calls++;
        if (fail) throw new PortalHttpError(403);
        return { status: 200, body: 'order 266-03335 somewhere' };
      },
    };
    const poller = new PortalPoller({
      session,
      onOrder: () => {},
      intervalMs: 30,
      minIntervalMs: 0,
      circuitThreshold: 3,
      cooldownMs: 60_000,
      parseOrders: (html) => (html.includes('266-03335') ? ['266-03335'] : []),
    });
    poller.start();
    await waitFor(() => poller.paused === true, 3000);
    assert.equal(poller.paused, true);

    fail = false;
    poller.resume();
    await waitFor(() => poller.stats.polls >= 1, 2000);
    assert.equal(poller.paused, false);
    assert.ok(calls > 3);
    poller.stop();
  });

  test('hold that overlaps a timer does not kill the poll loop', async () => {
    let calls = 0;
    const session = {
      username: 'u',
      routes: { newOrders: '/Orders/NewOrders.aspx' },
      authedGet: async () => {
        calls++;
        return { status: 200, body: '' };
      },
    };
    const poller = new PortalPoller({
      session,
      onOrder: () => {},
      intervalMs: 30,
      minIntervalMs: 0,
      circuitThreshold: 99,
      cooldownMs: 60_000,
    });
    poller.start();
    await waitFor(() => calls >= 1, 2000);
    poller.hold('accept');
    // Let at least one scheduled tick fire while held (old bug: returned without reschedule).
    await sleep(80);
    const callsWhileHeld = calls;
    poller.release('accept');
    await waitFor(() => calls > callsWhileHeld, 2000);
    poller.stop();
  });

  test('cooldown probe restarts polling after pause', async () => {
    let failCount = 0;
    const session = {
      username: 'u',
      routes: { newOrders: '/Orders/NewOrders.aspx' },
      authedGet: async () => {
        failCount++;
        if (failCount <= 3) throw new PortalHttpError(403);
        return { status: 200, body: '' };
      },
    };
    const poller = new PortalPoller({
      session,
      onOrder: () => {},
      intervalMs: 15,
      minIntervalMs: 0,
      circuitThreshold: 3,
      cooldownMs: 50,
    });
    poller.start();
    await waitFor(() => poller.paused === true, 2000);
    assert.equal(poller.paused, true);
    await waitFor(() => poller.stats.polls >= 1, 2000);
    assert.equal(poller.paused, false);
    poller.stop();
  });
});

describe('PortalHttpError from session surface', () => {
  test('isThrottle flags 403 and 429', () => {
    assert.equal(new PortalHttpError(403).isThrottle, true);
    assert.equal(new PortalHttpError(429).isThrottle, true);
    assert.equal(new PortalHttpError(401).isThrottle, false);
  });
});

async function waitFor(cond, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await cond()) return true;
    await sleep(10);
  }
  throw new Error('waitFor timeout');
}
