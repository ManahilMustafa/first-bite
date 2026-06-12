import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderEmail } from '../src/detect/emailParser.js';
import {
  ORDER_EMAIL_HTML,
  ORDER_EMAIL_TEXT,
  ORDER_EMAIL_SUBJECT,
  NON_ORDER_EMAIL_HTML,
} from './fixtures/orderEmail.js';

test('parses order id from the real HTML email', () => {
  const r = parseOrderEmail({ html: ORDER_EMAIL_HTML, subject: ORDER_EMAIL_SUBJECT });
  assert.equal(r.isOrder, true);
  assert.equal(r.orderId, '266-03335');
});

test('extracts ACCEPT and DECLINE links (entities decoded)', () => {
  const r = parseOrderEmail({ html: ORDER_EMAIL_HTML });
  assert.match(r.acceptUrl, /\/order\/accept\?id=266-03335/);
  assert.ok(r.acceptUrl.includes('&tok=abc123XYZ'), 'ampersand entity decoded');
  assert.match(r.declineUrl, /\/order\/decline\?id=266-03335/);
});

test('extracts structured fields and parses the fee', () => {
  const r = parseOrderEmail({ html: ORDER_EMAIL_HTML });
  assert.equal(r.fields['Client Name'], 'Shellpoint Mortgage Services - Collateral Management');
  assert.equal(r.fields['Borrower(s)'], 'LAURENE E GORDON');
  assert.equal(r.address, '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613');
  assert.equal(r.zip, '34613');
  assert.equal(r.zipPrefix, '34');
  assert.equal(r.state, 'FL');
  // Prefers Net Vendor's Fee.
  assert.equal(r.fee, 46);
});

test('parses the plain-text variant including nearby accept URL', () => {
  const r = parseOrderEmail({ text: ORDER_EMAIL_TEXT, subject: ORDER_EMAIL_SUBJECT });
  assert.equal(r.isOrder, true);
  assert.equal(r.orderId, '266-03335');
  assert.match(r.acceptUrl, /order\/accept\?id=266-03335/);
  assert.match(r.declineUrl, /order\/decline\?id=266-03335/);
});

test('rejects non-order emails', () => {
  const r = parseOrderEmail({ html: NON_ORDER_EMAIL_HTML });
  assert.equal(r.isOrder, false);
});
