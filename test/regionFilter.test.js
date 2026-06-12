import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddressMeta, orderMatchesRegion } from '../src/util/regionFilter.js';

test('parseAddressMeta extracts ZIP prefix and state', () => {
  const m = parseAddressMeta('8140 NIGHTINGALE RD WEEKI WACHEE FL 34613');
  assert.equal(m.zip, '34613');
  assert.equal(m.zipPrefix, '34');
  assert.equal(m.state, 'FL');
});

test('orderMatchesRegion passes when no rules configured', () => {
  const r = orderMatchesRegion({}, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, true);
});

test('orderMatchesRegion rejects ZIP outside allowed prefixes', () => {
  const account = { regionZipPrefixes: ['32', '33'] };
  const r = orderMatchesRegion(account, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'zip_mismatch');
});

test('orderMatchesRegion accepts matching ZIP prefix', () => {
  const account = { regionZipPrefixes: ['34'] };
  const r = orderMatchesRegion(account, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, true);
});

test('orderMatchesRegion accepts matching state', () => {
  const account = { regionStates: ['FL', 'TX'] };
  const r = orderMatchesRegion(account, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, true);
});

test('orderMatchesRegion rejects wrong state', () => {
  const account = { regionStates: ['CA'] };
  const r = orderMatchesRegion(account, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'state_mismatch');
});
