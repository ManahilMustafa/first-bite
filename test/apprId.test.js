import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractApprIdNearOrder, acceptAsIsUrl } from '../src/accept/apprId.js';

test('extractApprIdNearOrder finds ViewAppraisal link beside order id', () => {
  const html = `
    <tr><td><a href="ViewAppraisal.aspx?ApprID=262600">268-08547</a></td>
    <td><input type="image" name="ctl00$cphBody$grdNewOrders$ctl02$imgBtnBroadcastAccept$268-08547" title="accept" /></td></tr>
  `;
  assert.equal(extractApprIdNearOrder(html, '268-08547'), '262600');
});

test('extractApprIdNearOrder returns null when order missing', () => {
  assert.equal(extractApprIdNearOrder('<a href="ViewAppraisal.aspx?ApprID=1">x</a>', '268-00000'), null);
});

test('acceptAsIsUrl builds broadcast confirm URL', () => {
  const session = { url: (p) => `https://estreetamc.spurams.com${p}` };
  assert.equal(
    acceptAsIsUrl(session, '262600'),
    'https://estreetamc.spurams.com/AcceptBroadcastAppraisal.aspx?ApprID=262600&Accept=asis'
  );
});
