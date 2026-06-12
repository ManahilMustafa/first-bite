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

test('email link reports needs_login when portal bounces (the unknown)', async () => {
  portal.addOrder('266-03335');
  portal.emailLinkMode = 'needs_login';
  const r = await acceptViaEmailLink({ acceptUrl: portal.emailAcceptUrl('266-03335') });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'needs_login');
  assert.equal(r.bounced, true);
  assert.equal(portal.orderStatus('266-03335'), 'available'); // not accepted
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
  const res = await s.authedPost('/Orders/NewOrders.aspx', {
    __VIEWSTATE: 'forged',
    __EVENTVALIDATION: 'forged',
    __EVENTTARGET: 'ctl00$MainContent$gvOrders$btnAccept',
    __EVENTARGUMENT: '266-03335',
  });
  assert.match(res.body, /session has expired/i);
  assert.equal(portal.orderStatus('266-03335'), 'available');
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
