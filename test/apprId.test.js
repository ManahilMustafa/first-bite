import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractApprIdNearOrder, acceptAsIsUrl } from '../src/accept/apprId.js';

test('extractApprIdNearOrder picks the nearest ApprID, not the first one in the window', () => {
  // Two orders share the same 2000-char window; the neighbor's link (wrong
  // ApprID) sits before our order's own link (correct ApprID) in scan order —
  // reproduces production order 268-10185 picking up 263517 instead of 264238.
  const html =
    `<div>Order 268-99999 <a href="ViewAppraisal.aspx?ApprID=263517">View</a></div>` +
    'x'.repeat(200) +
    `<div>Order 268-10185 <a href="ViewAppraisal.aspx?ApprID=264238">View</a></div>`;

  assert.equal(extractApprIdNearOrder(html, '268-10185'), '264238');
});

test('extractApprIdNearOrder still finds an ApprID that only appears before the order id', () => {
  const html = `<a href="ViewAppraisal.aspx?ApprID=111222">View</a> Order 268-10185`;
  assert.equal(extractApprIdNearOrder(html, '268-10185'), '111222');
});

test('extractApprIdNearOrder returns null when the order id is not present', () => {
  assert.equal(extractApprIdNearOrder('<div>no orders here</div>', '268-10185'), null);
});

test('extractApprIdNearOrder falls back to a looser pattern only when stricter ones have no match at all', () => {
  const html = `<div>Order 268-10185 <a href="/Foo.aspx?ApprID=555">x</a></div>`;
  assert.equal(extractApprIdNearOrder(html, '268-10185'), '555');
});

test('acceptAsIsUrl builds the Accept=asis URL for a given ApprID', () => {
  const session = { url: (p) => `https://estreetamc.spurams.com${p}` };
  assert.equal(
    acceptAsIsUrl(session, '264238'),
    'https://estreetamc.spurams.com/AcceptBroadcastAppraisal.aspx?ApprID=264238&Accept=asis'
  );
});
