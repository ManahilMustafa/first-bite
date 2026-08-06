import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PortalPoller, isBlockSignal, isAbortError } from '../src/detect/portalPoller.js';
import { PortalHttpError, PortalSession } from '../src/portal/session.js';

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

  test('hold() cancels an in-flight tick instead of making an accept/decline wait for it', async () => {
    let started = false;
    let abortedSeen = false;
    const session = {
      username: 'u',
      routes: { newOrders: '/Orders/NewOrders.aspx' },
      // A signal-aware fake: only resolves the GET early if cancelled, exactly
      // like the real HttpClient does once hold() calls AbortController.abort().
      authedGet: (path, { signal } = {}) =>
        new Promise((resolve, reject) => {
          started = true;
          const timer = setTimeout(() => resolve({ status: 200, body: '' }), 2000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            abortedSeen = true;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            err.code = 'ABORT_ERR';
            reject(err);
          });
        }),
    };
    const poller = new PortalPoller({ session, onOrder: () => {}, intervalMs: 50, minIntervalMs: 0 });
    poller.start();
    await waitFor(() => started, 2000);

    const holdAt = Date.now();
    poller.hold('accept');
    await waitFor(() => abortedSeen, 500);
    const cancelLatency = Date.now() - holdAt;

    assert.equal(abortedSeen, true, 'hold() should cancel the in-flight tick');
    assert.ok(cancelLatency < 200, `expected near-instant cancel, took ${cancelLatency}ms`);
    assert.equal(poller.stats.errors, 0, 'an intentional cancel must not count as a poll error');
    assert.equal(poller.stats.blockSignals, 0, 'an intentional cancel must not trip block/circuit logic');
    assert.ok(poller.stats.preempted >= 1);

    poller.release('accept');
    poller.stop();
  });

  test('isBlockSignal never treats our own abort as a portal block/throttle signal', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    assert.equal(isAbortError(err), true);
    assert.equal(isBlockSignal(err), false);
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

describe('end-to-end: real PortalSession + HttpClient, not a mock', () => {
  function startTwoPathServer(slowPath, slowMs) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.url.startsWith(slowPath)) {
          const t = setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html>slow page, no order id here</html>');
          }, slowMs);
          req.on('aborted', () => clearTimeout(t));
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>fast page</html>');
        }
      });
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  test('hold() frees the real exclusive gate fast — an accept does not wait out a slow poll', async () => {
    const SLOW_MS = 2000;
    const server = await startTwoPathServer('/orders', SLOW_MS);
    try {
      const { port } = server.address();
      const session = new PortalSession({ baseUrl: `http://127.0.0.1:${port}`, username: 'u', password: 'p' });
      session.authenticated = true; // only exercising the gate/abort path here, not login

      const poller = new PortalPoller({
        session,
        onOrder: () => {},
        intervalMs: 10000,
        minIntervalMs: 0,
        newOrdersPath: '/orders',
      });

      const tickPromise = poller._tick();
      await sleep(50); // let the slow /orders GET actually dispatch and acquire the gate

      poller.hold('accept'); // simulates AccountWorker._accept()
      const acceptStarted = Date.now();
      const acceptRes = await session.authedGet('/fast-page'); // stands in for the accept/decline POST path
      const acceptLatencyMs = Date.now() - acceptStarted;

      assert.equal(acceptRes.body, '<html>fast page</html>');
      assert.ok(
        acceptLatencyMs < SLOW_MS / 2,
        `accept's request should not queue behind the aborted poll (${acceptLatencyMs}ms, poll would have taken ${SLOW_MS}ms)`
      );

      poller.release('accept');
      await tickPromise;
    } finally {
      await new Promise((r) => server.close(r));
    }
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
