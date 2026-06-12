import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
beforeEach(() => portal.reset());

function newSession(overrides = {}) {
  return new PortalSession({
    baseUrl: portal.baseUrl,
    username: 'vendor1',
    password: 'pass1',
    ...overrides,
  });
}

test('login succeeds with valid credentials', async () => {
  const s = newSession();
  await s.login();
  assert.equal(s.authenticated, true);
  s.close();
});

test('login fails with bad credentials', async () => {
  const s = newSession({ password: 'wrong' });
  await assert.rejects(() => s.login(), /login failed/i);
  s.close();
});

test('authedGet auto-logs-in then returns the protected page', async () => {
  portal.addOrder('266-03335');
  const s = newSession();
  const res = await s.authedGet('/Orders/NewOrders.aspx');
  assert.match(res.body, /New Orders/);
  assert.match(res.body, /266-03335/);
  s.close();
});

test('expired session triggers transparent re-login', async () => {
  portal.addOrder('100-00001');
  const s = newSession();
  await s.login();
  // Simulate server-side session loss.
  portal.sessions.clear();
  const res = await s.authedGet('/Orders/NewOrders.aspx');
  assert.match(res.body, /New Orders/); // recovered, not stuck on login
  s.close();
});

test('concurrent login calls are de-duplicated', async () => {
  const s = newSession();
  const before = portal.requests.filter((r) => r.path === '/Account/Login.aspx' && r.method === 'POST').length;
  await Promise.all([s.login(), s.login(), s.login()]);
  const after = portal.requests.filter((r) => r.path === '/Account/Login.aspx' && r.method === 'POST').length;
  assert.equal(after - before, 1, 'only one login POST despite 3 concurrent calls');
  s.close();
});
