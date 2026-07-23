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
  const res = await s.authedGet('/AppraiserDashboard.aspx');
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
  const res = await s.authedGet('/AppraiserDashboard.aspx');
  assert.match(res.body, /New Orders/); // recovered, not stuck on login
  s.close();
});

test('authedGet retries once on a bare request timeout', async () => {
  portal.addOrder('100-00002');
  const s = newSession();
  await s.login();
  const realGet = s.http.get.bind(s.http);
  let calls = 0;
  s.http.get = (...args) => {
    calls++;
    if (calls === 1) return Promise.reject(new Error(`Request timeout: ${args[0]}`));
    return realGet(...args);
  };
  const res = await s.authedGet('/AppraiserDashboard.aspx');
  assert.match(res.body, /New Orders/);
  assert.equal(calls, 2, 'first call timed out, second call succeeded');
  s.close();
});

test('authedGet does not retry a timeout more than once', async () => {
  const s = newSession();
  await s.login();
  s.http.get = () => Promise.reject(new Error('Request timeout: /AppraiserDashboard.aspx'));
  await assert.rejects(() => s.authedGet('/AppraiserDashboard.aspx'), /timeout/i);
  s.close();
});

test('concurrent login calls are de-duplicated', async () => {
  const s = newSession();
  const before = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  await Promise.all([s.login(), s.login(), s.login()]);
  const after = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  assert.equal(after - before, 1, 'only one login POST despite 3 concurrent calls');
  s.close();
});

test('login requires the emailed OTP code when the portal challenges it', async () => {
  portal.emailOtpRequired = true;
  portal.otpCode = '515344';
  let sentAfter = null;
  const s = newSession({
    fetchOtpCode: async ({ sentAfter: t }) => {
      sentAfter = t;
      return portal.otpCode;
    },
  });
  await s.login();
  assert.equal(s.authenticated, true);
  assert.ok(sentAfter, 'fetchOtpCode was invoked with a sentAfter timestamp');
  s.close();
});

test('login fails when the OTP code is wrong', async () => {
  portal.emailOtpRequired = true;
  portal.otpCode = '515344';
  const s = newSession({
    fetchOtpCode: async () => '000000',
  });
  await assert.rejects(() => s.login(), /login failed/i);
  s.close();
});

// ── session cookie persistence (resume across a process restart) ────────────
function fakeCookieStore() {
  const byAccount = new Map();
  return {
    async get(accountId) {
      return byAccount.get(accountId) || null;
    },
    async save(accountId, cookies) {
      byAccount.set(accountId, cookies);
    },
  };
}

test('a second session reuses a saved cookie instead of logging in (no OTP re-prompt)', async () => {
  portal.emailOtpRequired = true;
  portal.otpCode = '515344';
  const cookieStore = fakeCookieStore();

  // First "process": logs in fresh, hits the OTP challenge, and its cookie
  // gets persisted as a side effect of login() succeeding.
  const s1 = newSession({
    cookieStore,
    accountId: 'acct-1',
    fetchOtpCode: async () => portal.otpCode,
  });
  await s1.login();
  assert.equal(s1.authenticated, true);
  s1.close();

  // Second "process" (simulates a restart): same cookieStore + accountId, but
  // fetchOtpCode would throw if ever called — proving OTP is never re-requested.
  const loginPostsBefore = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  const s2 = newSession({
    cookieStore,
    accountId: 'acct-1',
    fetchOtpCode: async () => {
      throw new Error('should not be called — session should have resumed from the saved cookie');
    },
  });
  await s2.login();
  assert.equal(s2.authenticated, true);
  const loginPostsAfter = portal.requests.filter((r) => r.path === '/login.aspx' && r.method === 'POST').length;
  assert.equal(loginPostsAfter, loginPostsBefore, 'no fresh login POST — the saved cookie was reused');

  // And the resumed session actually works for real requests, not just the flag.
  portal.addOrder('300-00001');
  const res = await s2.authedGet('/AppraiserDashboard.aspx');
  assert.match(res.body, /300-00001/);
  s2.close();
});

test('falls back to a fresh login when the saved cookie is no longer valid', async () => {
  portal.emailOtpRequired = true;
  portal.otpCode = '515344';
  const cookieStore = fakeCookieStore();

  const s1 = newSession({ cookieStore, accountId: 'acct-1', fetchOtpCode: async () => portal.otpCode });
  await s1.login();
  s1.close();

  // Simulate server-side session loss (cookie on disk is now stale).
  portal.sessions.clear();

  let otpCalled = false;
  const s2 = newSession({
    cookieStore,
    accountId: 'acct-1',
    fetchOtpCode: async () => {
      otpCalled = true;
      return portal.otpCode;
    },
  });
  await s2.login();
  assert.equal(s2.authenticated, true);
  assert.equal(otpCalled, true, 'stale cookie was rejected, so a fresh login (with OTP) happened');
  s2.close();
});
