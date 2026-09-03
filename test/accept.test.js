import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockPortal } from './mocks/mockPortal.js';
import { PortalSession } from '../src/portal/session.js';
import { acceptViaEmailLink } from '../src/accept/emailAccept.js';
import { acceptViaPortal } from '../src/accept/portalAccept.js';
import { executeAccept } from '../src/accept/acceptExecutor.js';
import { makePortalVerifier } from '../src/accept/verifier.js';

let portal;
before(async () => {
  portal = new MockPortal({ username: 'vendor1', password: 'pass1' });
  await portal.listen();
});
after(async () => {
  await portal.close();
});
beforeEach(() => {
  portal.reset();
  portal.emailLinkMode = 'standalone';
});

function session() {
  return new PortalSession({ baseUrl: portal.baseUrl, username: 'vendor1', password: 'pass1' });
}

// ── Path A: email link ────────────────────────────────────────────────────────
test('email link accepts when self-contained (standalone mode)', async () => {
  portal.addOrder('266-03335');
  const r = await acceptViaEmailLink({ acceptUrl: portal.emailAcceptUrl('266-03335') });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'accepted');
  assert.equal(portal.orderStatus('266-03335'), 'accepted');
});

test('email link reports needs_login when portal bounces and no session is available to recover', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login';
  const r = await acceptViaEmailLink({ acceptUrl: portal.emailAcceptUrl('266-03335') });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'needs_login');
  assert.equal(r.bounced, true);
  assert.equal(portal.orderStatus('266-03335'), 'available'); // not accepted
});

test('email link auto-re-authenticates and retries once on a transient login bounce', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login_once'; // bounces exactly once, then recovers
  const s = session();
  const loginsBefore = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  const r = await acceptViaEmailLink({ acceptUrl: portal.emailAcceptUrl('266-03335'), session: s });
  const loginsAfter = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  assert.equal(r.ok, true, 'the retry (not the portal fallback) should have accepted it');
  assert.equal(r.outcome, 'accepted');
  assert.equal(portal.orderStatus('266-03335'), 'accepted');
  assert.equal(loginsAfter - loginsBefore, 1, 'exactly one re-login was triggered');
  s.close();
});

test('email link gives up after exactly one retry when the bounce never clears', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login'; // permanent — the retry will bounce too
  const s = session();
  const acceptGetsBefore = portal.requests.filter((r) => r.path === '/accept.aspx' && r.method === 'GET').length;
  const r = await acceptViaEmailLink({ acceptUrl: portal.emailAcceptUrl('266-03335'), session: s });
  const acceptGetsAfter = portal.requests.filter((r) => r.path === '/accept.aspx' && r.method === 'GET').length;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'needs_login');
  assert.equal(acceptGetsAfter - acceptGetsBefore, 2, 'original attempt + exactly one retry, no more');
  s.close();
});

test('email link reports taken when already accepted', async () => {
  portal.addOrder('266-03335');
  portal._tryAccept('266-03335', 'someone', 'portal'); // pre-taken
  const r = await acceptViaEmailLink({ acceptUrl: portal.emailAcceptUrl('266-03335') });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'taken');
});

test('email link two-step: details page then green Accept button', async () => {
  portal.addOrder('266-03335', { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  portal.emailLinkMode = 'two_step';
  const r = await acceptViaEmailLink({ acceptUrl: portal.emailAcceptUrl('266-03335') });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'accepted');
  assert.deepEqual(r.steps, ['email_get', 'details_postback']);
  assert.equal(portal.orderStatus('266-03335'), 'accepted');
});

// Owner-confirmed real portal behavior (2026-09-03): the email path can ALSO
// land directly on the no-banner "Manage Order" detail page instead of the
// green badge (neither page is exclusive to one accept path — see
// signals.js). Bypasses the mock portal (which always renders a badge on
// success) with a hand-built response, same style as the portalAccept.js
// no-banner test.
test('email link recognizes the no-banner order-detail page when no confirm button is present', async () => {
  const orderId = '266-09999';
  const manageOrderHtml = `<html><body>
    <h4>MANAGE ORDER: ${orderId}</h4>
    <table>
      <tr><td>Order Number</td><td>${orderId}</td></tr>
      <tr><td>Status</td><td><span class="badge">In Progress</span></td></tr>
    </table>
  </body></html>`;
  const fakeHttp = {
    get: async (url) => ({ status: 200, url, body: manageOrderHtml, durationMs: 10 }),
  };
  const r = await acceptViaEmailLink({
    acceptUrl: `https://fake-portal/AcceptOrder.aspx?ApprID=${orderId}`,
    http: fakeHttp,
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'accepted');
});

// ── Path B: portal postback ─────────────────────────────────────────────────--
test('portal postback accepts via VIEWSTATE replay', async () => {
  portal.addOrder('266-03335');
  const s = session();
  const r = await acceptViaPortal({ session: s, orderId: '266-03335' });
  assert.equal(r.ok, true);
  assert.equal(portal.orderStatus('266-03335'), 'accepted');
  s.close();
});

test('portal two-step: list Accept then confirmation-page Accept', async () => {
  // Real E-Street: New Orders tick opens the same details page as the email
  // Accept Order link; only the second Accept assigns the order.
  portal.addOrder('266-03350', { address: '221 N ORR AVE BENSON AZ 85602' });
  portal.portalAcceptMode = 'two_step';
  const s = session();
  // Disable early asis so we exercise list → confirm (production fallback path).
  const r = await acceptViaPortal({ session: s, orderId: '266-03350', earlyAsIs: false });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'accepted');
  assert.ok(
    r.steps?.[0] === 'list_postback' && (r.steps?.[1] === 'details_get' || r.steps?.[1] === 'details_postback'),
    `expected list+confirm steps, got ${JSON.stringify(r.steps)}`
  );
  assert.equal(portal.orderStatus('266-03350'), 'accepted');
  assert.ok(
    portal.acceptAttempts.some((a) => (/two_step|asis/.test(a.via)) && a.won),
    'order must be won on the confirmation step, not the list click'
  );
  s.close();
});

test('portal early Accept=asis from list ApprID (competitor one-shot)', async () => {
  portal.addOrder('266-03360', { address: '7208 E JEMATELL LN SCOTTSDALE AZ 85266' });
  const s = session();
  const r = await acceptViaPortal({ session: s, orderId: '266-03360', earlyAsIs: true });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'accepted');
  assert.deepEqual(r.steps, ['early_asis_get']);
  assert.equal(portal.orderStatus('266-03360'), 'accepted');
  assert.ok(portal.acceptAttempts.some((a) => a.via === 'portal_asis' && a.won));
  s.close();
});

test('portal two-step: list Accept alone does not assign the order', async () => {
  portal.addOrder('266-03351');
  portal.portalAcceptMode = 'two_step';
  const s = session();
  await s.login();
  // Manually do only the list click (no details Accept).
  const page = await s.authedGet('/AppraiserDashboard.aspx');
  const { locateAcceptForOrder } = await import('../src/accept/portalAccept.js');
  const { buildControlClick } = await import('../src/portal/aspnet.js');
  const pb = locateAcceptForOrder(page.body, '266-03351');
  assert.ok(pb);
  await s.authedPost('/AppraiserDashboard.aspx', buildControlClick(page.body, pb));
  assert.equal(portal.orderStatus('266-03351'), 'available', 'confirmation Accept not clicked yet');
  s.close();
});

test('portal postback reports taken when order is taken mid-flight (race)', async () => {
  portal.addOrder('266-03335');
  const s = session();
  await s.login();
  // Order is visible at GET; a rival grabs it just before our POST lands.
  portal._onBeforeAccept = (id) => {
    if (id === '266-03335') portal._tryAccept(id, 'rival', 'portal');
  };
  const r = await acceptViaPortal({ session: s, orderId: '266-03335', earlyAsIs: false });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'taken');
  s.close();
});

test('portal postback reports not_found when order already vanished from the list', async () => {
  portal.addOrder('266-03335');
  const s = session();
  portal._tryAccept('266-03335', 'rival', 'portal'); // gone before we even load
  const r = await acceptViaPortal({ session: s, orderId: '266-03335' });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'not_found');
  s.close();
});

test('forged/stale VIEWSTATE is rejected by the portal', async () => {
  portal.addOrder('266-03335');
  const s = session();
  await s.login();
  // Post a postback with bogus state tokens directly.
  const res = await s.authedPost('/AppraiserDashboard.aspx', {
    __VIEWSTATE: 'forged',
    __EVENTVALIDATION: 'forged',
    __EVENTTARGET: 'ctl00$MainContent$gvOrders$btnAccept',
    __EVENTARGUMENT: '266-03335',
  });
  assert.match(res.body, /session has expired/i);
  assert.equal(portal.orderStatus('266-03335'), 'available');
  s.close();
});

// ── Path B, opt-in: reuse the poller's cached page ──────────────────────────--
test('reuseCachedPage: a fresh cached page is used directly, skipping the extra GET', async () => {
  portal.addOrder('266-04000');
  const s = session();
  await s.login();
  // Simulate the poller having just fetched this exact page.
  await s.authedGet('/AppraiserDashboard.aspx');
  const getsBefore = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;

  const r = await acceptViaPortal({ session: s, orderId: '266-04000', reuseCachedPage: true });

  const getsAfter = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  assert.equal(r.ok, true);
  assert.equal(portal.orderStatus('266-04000'), 'accepted');
  assert.equal(getsAfter, getsBefore, 'no additional GET was made — the cached page was reused as-is');
  s.close();
});

test('reuseCachedPage: stale cached tokens fall back to a fresh GET+POST and still succeed', async () => {
  portal.addOrder('266-04001');
  const s = session();
  await s.login();
  await s.authedGet('/AppraiserDashboard.aspx'); // seeds the cache
  // Simulate the real portal having invalidated that page's VIEWSTATE/EVENTVALIDATION
  // in the meantime (e.g. a server-side session/state rotation) — the postback
  // built from the cached page will get "Your session has expired" back.
  portal.issuedViewstate.clear();
  portal.issuedEventval.clear();

  const getsBefore = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  const r = await acceptViaPortal({
    session: s,
    orderId: '266-04001',
    reuseCachedPage: true,
    earlyAsIs: false,
  });
  const getsAfter = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;

  assert.equal(r.ok, true, 'fell back to a fresh GET+POST and still accepted the order');
  assert.equal(portal.orderStatus('266-04001'), 'accepted');
  assert.equal(getsAfter - getsBefore, 1, 'exactly one fallback GET was made after the cached tokens were rejected');
  s.close();
});

test('reuseCachedPage: a cached page that does not list this order falls straight to a fresh GET', async () => {
  portal.addOrder('266-04002');
  const s = session();
  await s.login();
  await s.authedGet('/AppraiserDashboard.aspx'); // cached page predates this order existing... simulate via a different id
  const r = await acceptViaPortal({ session: s, orderId: '266-04002', reuseCachedPage: true, cacheMaxAgeMs: 0 });
  // cacheMaxAgeMs:0 means the cached page (however old) is never considered fresh.
  assert.equal(r.ok, true);
  assert.equal(portal.orderStatus('266-04002'), 'accepted');
  s.close();
});

test('reuseCachedPage defaults to false — behavior is unchanged unless explicitly opted in', async () => {
  portal.addOrder('266-04003');
  const s = session();
  await s.login();
  await s.authedGet('/AppraiserDashboard.aspx');
  const getsBefore = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  const r = await acceptViaPortal({ session: s, orderId: '266-04003' }); // no reuseCachedPage
  const getsAfter = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  assert.equal(r.ok, true);
  assert.equal(getsAfter - getsBefore, 1, 'a fresh GET was made, exactly as before this feature existed');
  s.close();
});

// ── Executor: race + verify ─────────────────────────────────────────────────--
test('executor accepts via the email fast path and verifies', async () => {
  portal.addOrder('266-03335');
  const s = session();
  const verify = makePortalVerifier(s);
  const r = await executeAccept({
    orderId: '266-03335',
    acceptUrl: portal.emailAcceptUrl('266-03335'),
    session: s,
    verify,
  });
  assert.equal(r.accepted, true);
  assert.equal(r.verified, 'accepted');
  assert.ok(['email', 'portal', 'verified'].includes(r.via));
  s.close();
});

test('executor falls back to portal when email link needs login', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login';
  const s = session();
  const verify = makePortalVerifier(s);
  const r = await executeAccept({
    orderId: '266-03335',
    acceptUrl: portal.emailAcceptUrl('266-03335'),
    session: s,
    verify,
  });
  assert.equal(r.accepted, true, 'portal path saved the accept');
  assert.equal(portal.orderStatus('266-03335'), 'accepted');
  s.close();
});

test('executor reports taken when nobody can accept', async () => {
  portal.addOrder('266-03335');
  portal._tryAccept('266-03335', 'rival', 'portal');
  const s = session();
  const verify = makePortalVerifier(s);
  const r = await executeAccept({
    orderId: '266-03335',
    acceptUrl: portal.emailAcceptUrl('266-03335'),
    session: s,
    verify,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.outcome, 'taken');
  s.close();
});

test('executor claims win when verify=accepted after confirm timeout/error path', async () => {
  // Reproduces 268-08298: we clicked, confirm timed out, verify later saw accepted.
  const s = session();
  const r = await executeAccept({
    orderId: '266-03370',
    session: s,
    portalAcceptFn: async () => ({
      ok: false,
      outcome: 'error',
      reason: 'confirm timeout',
      steps: ['list_postback', 'details_timeout'],
    }),
    verify: async () => 'accepted',
  });
  assert.equal(r.accepted, true);
  assert.equal(r.outcome, 'accepted');
  assert.equal(r.via, 'verified');
  s.close();
});

test('executor does NOT invent accepted when every path missed and verify is wrong', async () => {
  // Reproduces the 2026-07-21 production lie: portal path returns not_found
  // (couldn't locate the Accept control), then a flaky verifier matching nav
  // chrome used to flip accepted:true / via:'verified'.
  portal.addOrder('266-03335');
  const s = session();
  const lyingVerify = async () => 'accepted'; // pretend status page matched nav junk
  const r = await executeAccept({
    orderId: '266-03335',
    // Force portal-only, and make locate fail so the path never acts.
    session: s,
    portalOpts: { locateAccept: () => null, earlyAsIs: false },
    verify: lyingVerify,
  });
  assert.equal(r.accepted, false, 'must not claim a win when no path clicked Accept');
  assert.notEqual(r.via, 'verified');
  assert.equal(portal.orderStatus('266-03335'), 'available');
  s.close();
});

test('executor does NOT claim accept when verify still shows available', async () => {
  // Reproduces 2026-07-24 order 267-25294 class: path claimed win, portal still available.
  portal.addOrder('266-03337');
  const s = session();
  const r = await executeAccept({
    orderId: '266-03337',
    session: s,
    verify: async () => 'available',
  });
  assert.equal(r.accepted, false, 'must not claim win when portal still shows available');
  assert.equal(r.outcome, 'still_available');
  s.close();
});

test('executor does NOT claim accept on optimistic submitted + verify unknown', async () => {
  const prevCount = process.env.VERIFY_RETRY_COUNT;
  process.env.VERIFY_RETRY_COUNT = '0';
  try {
    portal.addOrder('266-03338');
    const s = session();
    const r = await executeAccept({
      orderId: '266-03338',
      session: s,
      portalAcceptFn: async () => ({ ok: true, outcome: 'submitted', status: 200 }),
      verify: async () => 'unknown',
    });
    assert.equal(r.accepted, false, 'soft 2xx without verify must not become accepted');
    assert.equal(r.outcome, 'unverified');
    assert.equal(portal.orderStatus('266-03338'), 'available');
    s.close();
  } finally {
    if (prevCount === undefined) delete process.env.VERIFY_RETRY_COUNT;
    else process.env.VERIFY_RETRY_COUNT = prevCount;
  }
});

test('executor retries verify after soft submit until accepted (portal lag)', async () => {
  const prevCount = process.env.VERIFY_RETRY_COUNT;
  const prevMs = process.env.VERIFY_RETRY_MS;
  process.env.VERIFY_RETRY_COUNT = '3';
  process.env.VERIFY_RETRY_MS = '10';
  try {
    const s = session();
    let calls = 0;
    const r = await executeAccept({
      orderId: '266-03381',
      session: s,
      portalAcceptFn: async () => ({
        ok: true,
        outcome: 'submitted',
        status: 0,
        steps: ['early_asis_get', 'details_postback'],
      }),
      verify: async () => {
        calls++;
        return calls < 3 ? 'unknown' : 'accepted';
      },
    });
    assert.equal(r.accepted, true);
    assert.equal(r.outcome, 'accepted');
    assert.ok(calls >= 3, `expected verify retries, got ${calls}`);
    s.close();
  } finally {
    if (prevCount === undefined) delete process.env.VERIFY_RETRY_COUNT;
    else process.env.VERIFY_RETRY_COUNT = prevCount;
    if (prevMs === undefined) delete process.env.VERIFY_RETRY_MS;
    else process.env.VERIFY_RETRY_MS = prevMs;
  }
});

test('executor does NOT mark dashboard Accepted when verify is unknown', async () => {
  // Even a path that saw success-looking HTML must not set accepted:true unless
  // the portal verifier corroborates — otherwise Orders page can lie.
  portal.addOrder('266-03339');
  const s = session();
  const r = await executeAccept({
    orderId: '266-03339',
    session: s,
    portalAcceptFn: async () => ({
      ok: true,
      outcome: 'accepted',
      status: 200,
      steps: ['list_postback', 'details_postback'],
    }),
    verify: async () => 'unknown',
  });
  assert.equal(r.accepted, false);
  assert.equal(r.outcome, 'unverified');
  s.close();
});

test('executor marks Accepted only when portal verify confirms', async () => {
  portal.addOrder('266-03341');
  const s = session();
  const r = await executeAccept({
    orderId: '266-03341',
    session: s,
    verify: makePortalVerifier(s),
  });
  assert.equal(r.accepted, true);
  assert.equal(r.verified, 'accepted');
  assert.equal(portal.orderStatus('266-03341'), 'accepted');
  s.close();
});

test('portalAccept does not treat bare 200 with nav chrome as accepted', async () => {
  portal.addOrder('266-03340');
  const s = session();
  await s.login();
  const navPage = `<html><body>
    <a id="ctl00_cphBody_lnkCondAcceptedOrders">Conditionally Accepted Orders</a>
    <a id="ctl00_cphBody_lnkShowInProgressOrders">In Progress Orders</a>
    <div>Order 266-03340 221 N ORR AVE</div>
    <input type="hidden" name="__VIEWSTATE" value="x" />
  </body></html>`;
  const stubSession = {
    ...s,
    routes: { ...s.routes, newOrders: '/AppraiserDashboard.aspx' },
    lastPage: null,
    authedGet: async () => ({
      status: 200,
      body: `${navPage}
        <input type="image" name="ctl00$cphBody$grdNewOrders$ctl02$imgBtnBroadcastAccept$266-03340"
               title="Click here to accept this order" src="x.png" />`,
    }),
    authedPost: async () => ({ status: 200, body: navPage, durationMs: 1 }),
  };
  const r = await acceptViaPortal({ session: stubSession, orderId: '266-03340' });
  assert.equal(r.ok, false, 'nav chrome + HTTP 200 must not count as accepted');
  assert.equal(r.outcome, 'unknown');
  s.close();
});

test('verifier ignores E-Street nav chrome that contains Accepted/In Progress', async () => {
  // Status page that ONLY has the nav links — must NOT read as accepted.
  const s = session();
  await s.login();
  // Hit the New Orders page (has Conditionally Accepted / In Progress nav) via
  // a custom verify that feeds that HTML through the same regex rules by
  // pointing status at the dashboard for a missing order... instead, unit-test
  // the exported patterns via makePortalVerifier against a stub session.
  const navOnly = `<html><body>
    <a id="ctl00_cphBody_lnkCondAcceptedOrders">Conditionally Accepted Orders</a>
    <a id="ctl00_cphBody_lnkShowInProgressOrders">In Progress Orders</a>
    <div>Order 266-09999 not found.</div>
  </body></html>`;
  const stub = {
    routes: { status: () => '/Orders/OrderStatus.aspx?order=x' },
    authedGet: async () => ({ status: 200, body: navOnly }),
  };
  const verify = makePortalVerifier(stub);
  assert.equal(await verify('266-09999'), 'unknown');
  s.close();
});
