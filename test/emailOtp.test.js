import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmailOtpFetcher } from '../src/portal/emailOtp.js';

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

function otpMessage({ id = 'm1', internalDate, code = '515344' }) {
  const body = Buffer.from(`Your verification code is ${code}. It expires soon.`, 'utf8').toString('base64');
  return {
    id,
    internalDate: String(internalDate),
    payload: { mimeType: 'text/plain', body: { data: body } },
  };
}

test('access token is fetched once and reused across multiple OTP fetches (cached)', async () => {
  let tokenCalls = 0;
  const now = Date.now();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      tokenCalls++;
      return jsonResponse({ access_token: 'AT', expires_in: 3600 });
    }
    if (u.includes('/messages?')) {
      return jsonResponse({ messages: [{ id: 'm1' }] });
    }
    if (u.includes('/messages/m1')) {
      return jsonResponse(otpMessage({ internalDate: now }));
    }
    throw new Error('unexpected url ' + u);
  };

  const fetchOtpCode = createGmailOtpFetcher({ oauth: { clientId: 'c', clientSecret: 's' }, getRefreshToken: async () => 'RT', fetchImpl });

  await fetchOtpCode({ sentAfter: now - 1000 });
  await fetchOtpCode({ sentAfter: now - 1000 });
  await fetchOtpCode({ sentAfter: now - 1000 });

  assert.equal(tokenCalls, 1, 'the OAuth token endpoint is only hit once, not once per login');
});

test('a new refresh token invalidates the cached access token', async () => {
  let tokenCalls = 0;
  let rt = 'RT1';
  const now = Date.now();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      tokenCalls++;
      return jsonResponse({ access_token: 'AT', expires_in: 3600 });
    }
    if (u.includes('/messages?')) return jsonResponse({ messages: [{ id: 'm1' }] });
    if (u.includes('/messages/m1')) return jsonResponse(otpMessage({ internalDate: now }));
    throw new Error('unexpected url ' + u);
  };

  const fetchOtpCode = createGmailOtpFetcher({ oauth: { clientId: 'c', clientSecret: 's' }, getRefreshToken: async () => rt, fetchImpl });
  await fetchOtpCode({ sentAfter: now - 1000 });
  rt = 'RT2';
  await fetchOtpCode({ sentAfter: now - 1000 });
  assert.equal(tokenCalls, 2);
});

test('candidate messages within one poll tick are fetched concurrently, not one-at-a-time', async () => {
  const now = Date.now();
  let concurrentInFlight = 0;
  let maxConcurrent = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT', expires_in: 3600 });
    if (u.includes('/messages?')) {
      return jsonResponse({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
    }
    if (u.includes('/messages/')) {
      concurrentInFlight++;
      maxConcurrent = Math.max(maxConcurrent, concurrentInFlight);
      await new Promise((r) => setTimeout(r, 20)); // simulate network latency
      concurrentInFlight--;
      const id = u.match(/messages\/(\w+)/)[1];
      // Only the last candidate actually has the code.
      return jsonResponse(otpMessage({ id, internalDate: now, code: id === 'm3' ? '999999' : '' }));
    }
    throw new Error('unexpected url ' + u);
  };

  const fetchOtpCode = createGmailOtpFetcher({ oauth: { clientId: 'c', clientSecret: 's' }, getRefreshToken: async () => 'RT', fetchImpl });
  const code = await fetchOtpCode({ sentAfter: now - 1000 });

  assert.equal(code, '999999');
  assert.equal(maxConcurrent, 3, 'all 3 candidates in the same poll tick were in flight at once');
});

test('a stale message (sent before this login attempt) is skipped, not returned', async () => {
  const now = Date.now();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT', expires_in: 3600 });
    if (u.includes('/messages?')) return jsonResponse({ messages: [{ id: 'old' }] });
    if (u.includes('/messages/old')) return jsonResponse(otpMessage({ id: 'old', internalDate: now - 60000, code: '111111' }));
    throw new Error('unexpected url ' + u);
  };
  const fetchOtpCode = createGmailOtpFetcher({ oauth: { clientId: 'c', clientSecret: 's' }, getRefreshToken: async () => 'RT', fetchImpl });
  const code = await fetchOtpCode({ sentAfter: now, timeoutMs: 1200 });
  assert.equal(code, null, 'a code from well before this login attempt must not be accepted');
});

test('extractCode reads E-Street "Login Verification Code" mail (code above valid-for line)', async () => {
  const { extractCode } = await import('../src/portal/emailOtp.js');
  const body = `Login Verification Code

Hi Patricia A Manara,

739495

This verification code is valid for 5 minutes.`;
  assert.equal(extractCode(body), '739495');
});

test('default Gmail OTP subject query matches Login Verification Code', async () => {
  let seenQ = '';
  const now = Date.now();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return jsonResponse({ access_token: 'AT', expires_in: 3600 });
    if (u.includes('/messages?')) {
      seenQ = decodeURIComponent(u.split('q=')[1] || '');
      return jsonResponse({ messages: [{ id: 'm1' }] });
    }
    if (u.includes('/messages/m1')) return jsonResponse(otpMessage({ internalDate: now, code: '424242' }));
    throw new Error('unexpected url ' + u);
  };
  const fetchOtpCode = createGmailOtpFetcher({ oauth: { clientId: 'c', clientSecret: 's' }, getRefreshToken: async () => 'RT', fetchImpl });
  await fetchOtpCode({ sentAfter: now - 1000 });
  assert.match(seenQ, /Login Verification Code/);
});
