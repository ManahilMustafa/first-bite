import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddressMeta, orderMatchesRegion } from '../src/util/regionFilter.js';

test('parseAddressMeta extracts ZIP prefix and state', () => {
  const m = parseAddressMeta('8140 NIGHTINGALE RD WEEKI WACHEE FL 34613');
  assert.equal(m.zip, '34613');
  assert.equal(m.zipPrefix, '34');
  assert.equal(m.state, 'FL');
});

test('parseAddressMeta takes the ZIP, not a 5-digit house number', () => {
  // Real captured address: house number 13167 must NOT be read as the ZIP.
  const m = parseAddressMeta('13167 DON LOOP SPRING HILL FL 34609');
  assert.equal(m.zip, '34609');
  assert.equal(m.zipPrefix, '34');
  assert.equal(m.state, 'FL');
});

test('parseAddressMeta handles ZIP+4', () => {
  const m = parseAddressMeta('100 MAIN ST DALLAS TX 75001-1234');
  assert.equal(m.zip, '75001');
  assert.equal(m.state, 'TX');
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

test('matches ZIP prefixes longer than 2 digits against the full ZIP', () => {
  const r = orderMatchesRegion({ regionZipPrefixes: ['346'] }, { zip: '34613' });
  assert.equal(r.allowed, true);
  const r2 = orderMatchesRegion({ regionZipPrefixes: ['347'] }, { zip: '34613' });
  assert.equal(r2.allowed, false);
});

// OR across configured dimensions: matching EITHER ZIP or state is in-region.
test('both rules set: a state match accepts even when ZIP does not match', () => {
  const account = { regionZipPrefixes: ['75'], regionStates: ['FL'] };
  const r = orderMatchesRegion(account, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, true, 'state FL matches even though ZIP 34 is not in [75]');
});

test('both rules set: a ZIP match accepts even when state does not match', () => {
  const account = { regionZipPrefixes: ['34'], regionStates: ['CA'] };
  const r = orderMatchesRegion(account, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, true, 'ZIP 34 matches even though state FL is not CA');
});

test('both rules set: neither matches → confident decline (decided)', () => {
  const account = { regionZipPrefixes: ['75'], regionStates: ['CA'] };
  const r = orderMatchesRegion(account, { address: '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613' });
  assert.equal(r.allowed, false);
  assert.equal(r.decided, true);
});

test('state rule but order has no parseable state → undetermined, not a decline', () => {
  // ZIP present, but nothing to evaluate the state rule against.
  const r = orderMatchesRegion({ regionStates: ['FL'] }, { zip: '34613' });
  assert.equal(r.allowed, false);
  assert.equal(r.decided, false, 'cannot confirm out-of-region → caller should skip, not decline');
});
