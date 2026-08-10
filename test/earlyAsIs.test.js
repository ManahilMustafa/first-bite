// Proves the early-Accept=asis confirm step races GET vs POST (via the same
// raceConfirmAccept already used by the list-postback confirm step) instead
// of a bare sequential POST that eats the full HTTP timeout before falling
// back. Production evidence (orders 268-08682/268-08906/268-08993): a bare
// `await session.authedPost(...)` there cost a consistent ~3.1-3.2s
// (ACCEPT_HTTP_TIMEOUT_MS) on every loss, because the confirm POST never
// resolved before its own timeout fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { acceptViaPortal } from '../src/accept/portalAccept.js';
import { PortalSession } from '../src/portal/session.js';
import { logger } from '../src/util/logger.js';

const ORDER_ID = '900-00099';
const APPR_ID = '9999';

const NEW_ORDERS_HTML = `<html><body>
  <div>Order ${ORDER_ID} <a href="ViewAppraisal.aspx?ApprID=${APPR_ID}">View</a></div>
</body></html>`;

// Landed here after the FIRST early-asis GET — a confirm UI, not a decisive
// outcome yet. Its form action already carries Accept=asis (real-portal
// shape), which is what lets raceConfirmAccept try a second, decisive GET.
const CONFIRM_UI_HTML = `<html><body>
  <form action="/ConfirmAccept.aspx?ApprID=${APPR_ID}&amp;Accept=asis" method="post">
    <input type="hidden" name="__VIEWSTATE" value="vs" />
    <input type="submit" name="btnAcceptAppraisal" value="Accept Appraisal" />
  </form>
</body></html>`;

const TAKEN_HTML = `<html><body>This order is no longer available.</body></html>`;

// Real production shape (268-09741/268-09800/268-09831/268-09929): the
// confirm page's own form action is the EXACT SAME Accept=asis URL we just
// GET'd to land on it — a second GET there is provably redundant.
const CONFIRM_UI_SAME_URL_HTML = `<html><body>
  <form action="/AcceptBroadcastAppraisal.aspx?ApprID=${APPR_ID}&amp;Accept=asis" method="post">
    <input type="hidden" name="__VIEWSTATE" value="vs" />
    <input type="submit" name="btnAcceptAppraisal" value="Accept Appraisal" />
  </form>
</body></html>`;

function silentLog() {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
}

/**
 * A fake session for tryEarlyAcceptAsIs's confirm step.
 * @param {'hang'|'resolve'} postBehavior  'hang' simulates the real failure
 *        (POST never resolves before its own timeout — like production);
 *        'resolve' answers quickly with TAKEN_HTML, for the fallback test.
 */
function makeFakeSession({ postBehavior = 'hang', postDelayMs = 5000 } = {}) {
  let postCalls = 0;
  let getCalls = { early: 0, confirm: 0 };
  const timeline = [];

  const session = {
    url: (path) => `http://fake-portal${path}`,
    routes: { newOrders: '/AppraiserDashboard.aspx' },
    http: {
      get: (url, opts) => {
        timeline.push({ t: Date.now(), kind: 'get', url });
        if (url.includes('AcceptBroadcastAppraisal.aspx')) {
          getCalls.early++;
          return Promise.resolve({ status: 200, url, body: CONFIRM_UI_HTML, durationMs: 20 });
        }
        if (url.includes('ConfirmAccept.aspx')) {
          getCalls.confirm++;
          // Fast + decisive — this is the request that should win the race.
          return new Promise((resolve) =>
            setTimeout(() => resolve({ status: 200, url, body: TAKEN_HTML, durationMs: 60 }), 60)
          );
        }
        return Promise.reject(new Error('unexpected GET ' + url));
      },
    },
    authedGet: () => Promise.reject(new Error('authedGet should not be called in this test')),
    authedPost: (path, body, opts) => {
      postCalls++;
      timeline.push({ t: Date.now(), kind: 'post', path });
      if (postBehavior === 'resolve') {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ status: 200, url: path, body: TAKEN_HTML, durationMs: postDelayMs }), postDelayMs)
        );
      }
      // Simulates the real failure: this request never resolves before its
      // own HTTP timeout would fire (ACCEPT_HTTP_TIMEOUT_MS=3000 in prod).
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Request timeout: ${path}`)), postDelayMs)
      );
    },
  };
  return { session, getCallCounts: () => getCalls, postCallCount: () => postCalls, timeline };
}

test('early Accept=asis confirm step races GET vs POST — resolves fast even though the POST would hang', async () => {
  const { session, getCallCounts, postCallCount } = makeFakeSession({ postDelayMs: 5000 });

  const startedAt = Date.now();
  const result = await acceptViaPortal({
    session,
    orderId: ORDER_ID,
    prefetchedPage: { body: NEW_ORDERS_HTML, status: 200, url: 'http://fake-portal/AppraiserDashboard.aspx' },
    log: silentLog(),
    earlyAsIs: true,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'taken');
  assert.equal(result.timings?.earlyAsIs, true);
  // The whole thing must resolve using only the two fast GETs (20ms + 60ms),
  // nowhere near the 5000ms the POST was configured to hang for.
  assert.ok(elapsedMs < 1000, `expected fast resolution via the GET race, took ${elapsedMs}ms`);
  assert.equal(getCallCounts().early, 1);
  assert.equal(getCallCounts().confirm, 1);
  // The decisive GET should have won — the slow POST is never even started.
  assert.equal(postCallCount(), 0, 'the hanging POST should never be called once the GET is decisive');
});

test('early Accept=asis confirm step falls back to POST when the GET is inconclusive', async () => {
  const { session, postCallCount } = makeFakeSession({ postBehavior: 'resolve', postDelayMs: 30 });
  // Make the confirm-race GET inconclusive (still shows the confirm button,
  // same as the real portal mid-processing) so the race must fall through
  // to the POST to get a decisive answer.
  const originalGet = session.http.get;
  session.http.get = (url, opts) => {
    if (url.includes('ConfirmAccept.aspx')) {
      return Promise.resolve({ status: 200, url, body: CONFIRM_UI_HTML, durationMs: 15 });
    }
    return originalGet(url, opts);
  };

  const result = await acceptViaPortal({
    session,
    orderId: ORDER_ID,
    prefetchedPage: { body: NEW_ORDERS_HTML, status: 200, url: 'http://fake-portal/AppraiserDashboard.aspx' },
    log: silentLog(),
    earlyAsIs: true,
  });

  assert.equal(postCallCount(), 1, 'an inconclusive GET must still fall back to the POST');
  assert.equal(result.outcome, 'taken'); // TAKEN_HTML is what authedPost resolves with
});

test('early Accept=asis confirm step skips the redundant second GET when the form action is the same URL', async () => {
  let getCallsToAcceptUrl = 0;
  let postCalls = 0;
  const session = {
    url: (path) => `http://fake-portal${path}`,
    routes: { newOrders: '/AppraiserDashboard.aspx' },
    http: {
      get: (url) => {
        if (url.includes('AcceptBroadcastAppraisal.aspx')) {
          getCallsToAcceptUrl++;
          // Real-world shape: the confirm page's form action is THIS SAME URL.
          return Promise.resolve({ status: 200, url, body: CONFIRM_UI_SAME_URL_HTML, durationMs: 20 });
        }
        return Promise.reject(new Error('unexpected GET ' + url));
      },
    },
    authedGet: () => Promise.reject(new Error('authedGet should not be called in this test')),
    authedPost: (path, body, opts) => {
      postCalls++;
      return Promise.resolve({ status: 200, url: path, body: TAKEN_HTML, durationMs: 40 });
    },
  };

  const result = await acceptViaPortal({
    session,
    orderId: ORDER_ID,
    prefetchedPage: { body: NEW_ORDERS_HTML, status: 200, url: 'http://fake-portal/AppraiserDashboard.aspx' },
    log: silentLog(),
    earlyAsIs: true,
  });

  assert.equal(result.outcome, 'taken');
  // Only ONE GET to the Accept=asis URL (the initial probe) — the confirm
  // step must recognize its form action is the same URL and skip straight
  // to the POST instead of re-fetching something we already know the answer to.
  assert.equal(getCallsToAcceptUrl, 1, 'should not re-GET the same Accept=asis URL a second time');
  assert.equal(postCalls, 1);
});

// ── end-to-end: real PortalSession + HttpClient, not a mock ────────────────────
// Proves the FIRST early-asis GET actually gets cut off at earlyAsIsTimeoutMs
// (not the full accept timeout) — this is real timeout enforcement inside
// node:http, not something a fake session can fake its way past.
test('a hanging early Accept=asis GET is cut off at earlyAsIsTimeoutMs, not the full accept timeout', async () => {
  const EARLY_TIMEOUT_MS = 300;
  const FULL_TIMEOUT_MS = 5000; // deliberately much bigger — proves it's NOT this budget that saves us
  const SLOW_EARLY_GET_MS = 2000; // longer than EARLY_TIMEOUT_MS, shorter than FULL_TIMEOUT_MS

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/AcceptBroadcastAppraisal.aspx')) {
      const t = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>should never be read — too slow</html>');
      }, SLOW_EARLY_GET_MS);
      req.on('aborted', () => clearTimeout(t));
      return;
    }
    // List postback fallback — fast, decisive "taken".
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>This order is no longer available.</html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const session = new PortalSession({ baseUrl: `http://127.0.0.1:${port}`, username: 'u', password: 'p' });
    session.authenticated = true; // only exercising the accept path here, not login

    const html = `<html><body>
      <div>Order ${ORDER_ID} <a href="ViewAppraisal.aspx?ApprID=${APPR_ID}">View</a></div>
      <input type="image" name="imgBtnBroadcastAccept" title="Click here to accept this order" />
    </body></html>`;

    const startedAt = Date.now();
    const result = await acceptViaPortal({
      session,
      orderId: ORDER_ID,
      newOrdersPath: '/AppraiserDashboard.aspx',
      prefetchedPage: { body: html, status: 200, url: `http://127.0.0.1:${port}/AppraiserDashboard.aspx` },
      log: silentLog(),
      earlyAsIs: true,
      timeoutMs: FULL_TIMEOUT_MS,
      earlyAsIsTimeoutMs: EARLY_TIMEOUT_MS,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.outcome, 'taken'); // resolved via the list-postback fallback
    assert.ok(
      elapsedMs < SLOW_EARLY_GET_MS,
      `expected the early GET to be cut off well before ${SLOW_EARLY_GET_MS}ms, took ${elapsedMs}ms`
    );
    assert.ok(
      elapsedMs >= EARLY_TIMEOUT_MS,
      `should still take at least the early timeout (${EARLY_TIMEOUT_MS}ms), took ${elapsedMs}ms`
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
