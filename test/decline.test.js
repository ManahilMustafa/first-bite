// Decline executor: an optimistic 'submitted' (2xx but no confirmation text) must
// be CONFIRMED by verify before we claim success — never reported as declined on a
// guess (an order we may still own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeDecline } from '../src/accept/declineExecutor.js';

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
