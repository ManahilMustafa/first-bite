import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecipientCandidates, attributeOrder } from '../src/detect/attribution.js';

test('ignores the BCC To: (AMC sender) and surfaces the real recipient', () => {
  const headers = [
    { name: 'From', value: 'E Street <notifications@valuelinkams.com>' },
    { name: 'To', value: 'notifications@valuelinkams.com' },
    { name: 'Delivered-To', value: 'central@ops.example.com' },
    { name: 'Delivered-To', value: 'vendor@gmail.com' },
  ];
  const cands = extractRecipientCandidates(headers, { excludeAddresses: ['central@ops.example.com'] });
  const addrs = cands.map((c) => c.address);
  assert.ok(addrs.includes('vendor@gmail.com'));
  assert.ok(!addrs.includes('notifications@valuelinkams.com'), 'AMC sender domain excluded by default');
  assert.ok(!addrs.includes('central@ops.example.com'), 'central inbox excluded');
});

test('prefers the most trustworthy header first', () => {
  const headers = [
    { name: 'X-Gm-Original-To', value: 'primary@user.com' },
    { name: 'X-Forwarded-For', value: 'secondary@user.com central@ops.example.com' },
    { name: 'Delivered-To', value: 'central@ops.example.com' },
  ];
  const cands = extractRecipientCandidates(headers, { excludeAddresses: ['central@ops.example.com'] });
  assert.equal(cands[0].address, 'primary@user.com');
  assert.equal(cands[0].via, 'x-gm-original-to');
});

test('parses Received: ... for <addr> as a fallback', () => {
  const headers = [
    { name: 'Received', value: 'by 10.0.0.1 with SMTP id x; for <vendor@gmail.com>; Wed, 11 Jun 2026' },
    { name: 'To', value: 'notifications@valuelinkams.com' },
  ];
  const cands = extractRecipientCandidates(headers);
  assert.ok(cands.some((c) => c.address === 'vendor@gmail.com' && c.via === 'received'));
});

test('accepts a plain-object header map too', () => {
  const cands = extractRecipientCandidates({ 'Delivered-To': 'vendor@gmail.com' });
  assert.equal(cands[0].address, 'vendor@gmail.com');
});

test('attributeOrder picks the first candidate that maps to a registered user', () => {
  const headers = [
    { name: 'Delivered-To', value: 'central@ops.example.com' },
    { name: 'X-Forwarded-For', value: 'unknown@nobody.com vendor-tx@gmail.com central@ops.example.com' },
  ];
  const registered = new Set(['vendor-tx@gmail.com']);
  const r = attributeOrder(
    headers,
    (addr) => (registered.has(addr) ? { id: 'tx', forwardingEmail: addr } : null),
    { excludeAddresses: ['central@ops.example.com'] }
  );
  assert.ok(r);
  assert.equal(r.account.id, 'tx');
  assert.equal(r.address, 'vendor-tx@gmail.com');
});

test('attributeOrder returns null when nobody matches', () => {
  const headers = [{ name: 'Delivered-To', value: 'stranger@gmail.com' }];
  const r = attributeOrder(headers, () => null);
  assert.equal(r, null);
});
