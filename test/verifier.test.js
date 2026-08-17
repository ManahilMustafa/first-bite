import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePortalVerifier, classifyNearOrder, classifyStatusHtml } from '../src/accept/verifier.js';

function fakeSession({ statusRoute, statusBody, newOrdersBody, inProgressBody } = {}) {
  const calls = [];
  return {
    calls,
    routes: {
      newOrders: '/NewOrders.aspx',
      status: statusRoute ? (orderId) => `/Status.aspx?id=${orderId}` : undefined,
    },
    async authedGet(path, opts) {
      calls.push({ method: 'GET', path, opts });
      if (statusRoute && path.startsWith('/Status.aspx')) return { body: statusBody || '' };
      return { body: newOrdersBody || '' };
    },
    async authedPost(path, body, opts) {
      calls.push({ method: 'POST', path, body, opts });
      return { body: inProgressBody || '' };
    },
  };
}

test('every verify() request carries a bounded timeoutMs, not the HttpClient default', async () => {
  const session = fakeSession({ newOrdersBody: '268-1111 accepted by you' });
  const verify = makePortalVerifier(session);
  await verify('268-1111');
  assert.ok(session.calls.length > 0);
  for (const call of session.calls) {
    assert.equal(typeof call.opts.timeoutMs, 'number');
    assert.ok(call.opts.timeoutMs > 0);
  }
});

test('VERIFY_HTTP_TIMEOUT_MS env override is honored', async () => {
  process.env.VERIFY_HTTP_TIMEOUT_MS = '777';
  try {
    const session = fakeSession({ newOrdersBody: '268-1111 accepted by you' });
    const verify = makePortalVerifier(session);
    await verify('268-1111');
    assert.equal(session.calls[0].opts.timeoutMs, 777);
  } finally {
    delete process.env.VERIFY_HTTP_TIMEOUT_MS;
  }
});

test('verify resolves accepted from the New Orders row without needing In Progress', async () => {
  const session = fakeSession({ newOrdersBody: '268-2222 accepted by vendor' });
  const verify = makePortalVerifier(session);
  assert.equal(await verify('268-2222'), 'accepted');
  assert.equal(session.calls.some((c) => c.method === 'POST'), false);
});

test('verify falls through to In Progress Orders when the order left New Orders', async () => {
  const session = fakeSession({
    newOrdersBody: `<a href="#" onclick="__doPostBack('ctl00$InProgressOrders','')">In Progress Orders</a>`,
    inProgressBody: '268-3333 in progress',
  });
  const verify = makePortalVerifier(session);
  assert.equal(await verify('268-3333'), 'accepted');
});

test('classifyNearOrder distinguishes accepted-by-us from taken-by-another', () => {
  assert.equal(classifyNearOrder('268-4444 assigned to another vendor', '268-4444'), 'taken');
  assert.equal(classifyNearOrder('268-4444 accepted by you', '268-4444'), 'accepted');
});

test('classifyStatusHtml prefers explicit taken/accepted/available signals', () => {
  assert.equal(classifyStatusHtml('no longer available', 'x'), 'taken');
  assert.equal(classifyStatusHtml('accepted by vendor', 'x'), 'accepted');
});
