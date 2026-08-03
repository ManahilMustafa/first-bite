// Decline executor: an optimistic 'submitted' (2xx but no confirmation text) must
// be CONFIRMED by verify before we claim success — never reported as declined on a
// guess (an order we may still own).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeDecline } from '../src/accept/declineExecutor.js';
import { declineViaEmailLink } from '../src/accept/emailDecline.js';
import { declineViaPortal } from '../src/accept/portalDecline.js';
import { MockPortal } from './mocks/mockPortal.js';
import { PortalSession } from '../src/portal/session.js';

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

// ── Decline Path A: login-bounce recovery ───────────────────────────────────
test('decline link reports needs_login when portal bounces and no session is available to recover', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login';
  const r = await declineViaEmailLink({ declineUrl: portal.emailDeclineUrl('266-03335') });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'needs_login');
  assert.equal(r.bounced, true);
});

test('decline link auto-re-authenticates and retries once on a transient login bounce', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login_once'; // bounces exactly once, then recovers
  const s = session();
  const loginsBefore = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  const r = await declineViaEmailLink({ declineUrl: portal.emailDeclineUrl('266-03335'), session: s });
  const loginsAfter = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  assert.equal(r.ok, true, 'the retry (not the portal fallback) should have declined it');
  assert.equal(r.outcome, 'declined');
  assert.equal(portal.orderStatus('266-03335'), 'declined');
  assert.equal(loginsAfter - loginsBefore, 1, 'exactly one re-login was triggered');
  s.close();
});

test('decline link gives up after exactly one retry when the bounce never clears', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login'; // permanent — the retry will bounce too
  const s = session();
  const declineGetsBefore = portal.requests.filter((r) => r.path === '/decline.aspx' && r.method === 'GET').length;
  const r = await declineViaEmailLink({ declineUrl: portal.emailDeclineUrl('266-03335'), session: s });
  const declineGetsAfter = portal.requests.filter((r) => r.path === '/decline.aspx' && r.method === 'GET').length;
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'needs_login');
  assert.equal(declineGetsAfter - declineGetsBefore, 2, 'original attempt + exactly one retry, no more');
  s.close();
});

test('portal two-step: list Decline then confirmation-page Decline', async () => {
  portal.addOrder('266-05010');
  portal.portalDeclineMode = 'two_step';
  const s = session();
  const r = await declineViaPortal({ session: s, orderId: '266-05010' });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'declined');
  assert.deepEqual(r.steps, ['list_postback', 'details_postback']);
  assert.equal(portal.orderStatus('266-05010'), 'declined');
  s.close();
});

// ── Decline Path B, opt-in: reuse the poller's cached page ─────────────────--
test('reuseCachedPage (decline): a fresh cached page is used directly, skipping the extra GET', async () => {
  portal.addOrder('266-05000');
  const s = session();
  await s.login();
  await s.authedGet('/AppraiserDashboard.aspx'); // simulates the poller's last fetch
  const getsBefore = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;

  const r = await declineViaPortal({ session: s, orderId: '266-05000', reuseCachedPage: true });

  const getsAfter = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  assert.equal(r.ok, true);
  assert.equal(getsAfter, getsBefore, 'no additional GET was made — the cached page was reused as-is');
  s.close();
});

test('reuseCachedPage (decline): stale cached tokens fall back to a fresh GET+POST and still succeed', async () => {
  portal.addOrder('266-05001');
  const s = session();
  await s.login();
  await s.authedGet('/AppraiserDashboard.aspx');
  portal.issuedViewstate.clear();
  portal.issuedEventval.clear();

  const getsBefore = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  const r = await declineViaPortal({ session: s, orderId: '266-05001', reuseCachedPage: true });
  const getsAfter = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;

  assert.equal(r.ok, true, 'fell back to a fresh GET+POST and still declined the order');
  assert.equal(getsAfter - getsBefore, 1, 'exactly one fallback GET was made after the cached tokens were rejected');
  s.close();
});

test('reuseCachedPage (decline) defaults to false — behavior is unchanged unless explicitly opted in', async () => {
  portal.addOrder('266-05002');
  const s = session();
  await s.login();
  await s.authedGet('/AppraiserDashboard.aspx');
  const getsBefore = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  const r = await declineViaPortal({ session: s, orderId: '266-05002' }); // no reuseCachedPage
  const getsAfter = portal.requests.filter((r) => r.path === '/AppraiserDashboard.aspx' && r.method === 'GET').length;
  assert.equal(r.ok, true);
  assert.equal(getsAfter - getsBefore, 1, 'a fresh GET was made, exactly as before this feature existed');
  s.close();
});

// Minimal portal session whose New Orders page carries a Decline postback control,
// and whose postback returns 2xx with NO "declined"/"gone" text → 'submitted'.
function submittedSession() {
  const html = `<form action="/n">
    <input type="hidden" name="__VIEWSTATE" value="v" />
    <input type="hidden" name="__EVENTVALIDATION" value="e" />
    <tr><td>Order no. 266-0001</td>
    <a href="javascript:__doPostBack('btnDecline','266-0001')">Decline</a></tr>
  </form>`;
  return {
    routes: { newOrders: '/n' },
    http: undefined,
    authedGet: async () => ({ body: html, status: 200 }),
    authedPost: async () => ({ body: '<div>Saved.</div>', status: 200, durationMs: 1 }),
  };
}

test('submitted + verify "unknown" is NOT reported as declined', async () => {
  const r = await executeDecline({
    orderId: '266-0001',
    session: submittedSession(),
    verify: async () => 'unknown',
  });
  assert.equal(r.declined, false);
  assert.equal(r.outcome, 'unverified');
});

test('submitted + verify "available" IS confirmed as declined', async () => {
  const r = await executeDecline({
    orderId: '266-0001',
    session: submittedSession(),
    verify: async () => 'available',
  });
  assert.equal(r.declined, true);
  assert.equal(r.outcome, 'declined');
});

test('submitted + verify "accepted" means the decline did NOT take', async () => {
  const r = await executeDecline({
    orderId: '266-0001',
    session: submittedSession(),
    verify: async () => 'accepted',
  });
  assert.equal(r.declined, false);
  assert.equal(r.outcome, 'still_assigned');
});

test('an explicit "declined" confirmation stands even if verify is unknown', async () => {
  const session = submittedSession();
  session.authedPost = async () => ({ body: '<div>Order declined.</div>', status: 200, durationMs: 1 });
  const r = await executeDecline({
    orderId: '266-0001',
    session,
    verify: async () => 'unknown',
  });
  assert.equal(r.declined, true);
  assert.equal(r.outcome, 'declined');
});
