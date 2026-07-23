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

// ── Path B: portal postback ─────────────────────────────────────────────────--
test('portal postback accepts via VIEWSTATE replay', async () => {
  portal.addOrder('266-03335');
  const s = session();
  const r = await acceptViaPortal({ session: s, orderId: '266-03335' });
  assert.equal(r.ok, true);
  assert.equal(portal.orderStatus('266-03335'), 'accepted');
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
  const r = await acceptViaPortal({ session: s, orderId: '266-03335' });
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
  const r = await acceptViaPortal({ session: s, orderId: '266-04001', reuseCachedPage: true });
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
    portalOpts: { locateAccept: () => null },
    verify: lyingVerify,
  });
  assert.equal(r.accepted, false, 'must not claim a win when no path clicked Accept');
  assert.notEqual(r.via, 'verified');
  assert.equal(portal.orderStatus('266-03335'), 'available');
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
