import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findConfirmAcceptControl,
  looksAccepted,
  looksTaken,
  looksLikePortalError,
  isAcceptConfirmUrl,
} from '../src/accept/signals.js';

test('looksAccepted ignores E-Street nav chrome', () => {
  const nav = `<html><body>
    <a id="ctl00_cphBody_lnkCondAcceptedOrders">Conditionally Accepted Orders</a>
    <a id="ctl00_cphBody_lnkShowInProgressOrders">In Progress Orders</a>
  </body></html>`;
  assert.equal(looksAccepted(nav), false);
});

test('looksAccepted matches green-badge style success copy', () => {
  assert.equal(looksAccepted('<div class="badge">You have successfully accepted this order.</div>'), true);
  assert.equal(looksAccepted('Order 267-1 accepted. Assigned to you.'), true);
});

test('looksTaken matches broadcast miss', () => {
  assert.equal(looksTaken('Order 267-1 is no longer available.'), true);
});

test('findConfirmAcceptControl prefers Accept Order vs Accept Appraisal', () => {
  const html = `<form>
    <input type="submit" name="btnA" value="Accept Appraisal" />
    <input type="submit" name="btnO" value="Accept Order" />
  </form>`;
  assert.equal(findConfirmAcceptControl(html, 'order').target, 'btnO');
  assert.equal(findConfirmAcceptControl(html, 'appraisal').target, 'btnA');
});

test('isAcceptConfirmUrl matches real E-Street accept pages', () => {
  assert.equal(
    isAcceptConfirmUrl('https://estreetamc.spurams.com/AcceptAppraisal.aspx?ApprID=x&Accept=asis'),
    true
  );
  assert.equal(
    isAcceptConfirmUrl('https://x/AcceptBroadcastAppraisal.aspx?AppID=1&Accept=asis'),
    true
  );
  assert.equal(isAcceptConfirmUrl('https://x/AppraiserDashboard.aspx'), false);
});

test('looksLikePortalError detects ValueLink Error.aspx', () => {
  assert.equal(looksLikePortalError('', 'https://estreetamc.spurams.com/Error.aspx'), true);
  assert.equal(
    looksLikePortalError(
      '<title>ValueLink AMS - ERROR</title><p>An unexpected error occurred that caused the previous operation to fail.</p>'
    ),
    true
  );
  assert.equal(looksLikePortalError('<div>You have successfully accepted this order.</div>'), false);
});
