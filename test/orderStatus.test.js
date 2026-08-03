import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFinalStatus, PENDING_FRESH_MS, STATUS } from '../src/util/orderStatus.js';

function ev(overrides = {}) {
  return { ts: 1000, orderId: '1', accountId: 'a', account: 'A', action: 'accept', ...overrides };
}

const FRESH_NOW = 1000 + 1000; // 1s after the event — well within the freshness window
const STALE_NOW = 1000 + PENDING_FRESH_MS + 1; // just past the freshness window

test('an eventual success wins even after earlier failed attempts', () => {
  const events = [
    ev({ ts: 1000, action: 'accept', accepted: false, outcome: 'needs_login' }),
    ev({ ts: 2000, action: 'accept', accepted: true, outcome: 'accepted' }),
  ];
  const { status } = computeFinalStatus(events);
  assert.equal(status, STATUS.ACCEPTED);
});

test('a successful decline is reported as Declined, not Outside Region', () => {
  const events = [ev({ action: 'decline', declined: true, outcome: 'declined', reason: 'region_mismatch' })];
  const { status, reason } = computeFinalStatus(events);
  assert.equal(status, STATUS.DECLINED);
  assert.match(reason, /outside your service area/i);
});

test('region_unknown skip maps to Outside Region with a plain-language reason', () => {
  const events = [ev({ action: 'skip', reason: 'region_unknown', accepted: false, declined: false })];
  const { status, reason } = computeFinalStatus(events);
  assert.equal(status, STATUS.OUTSIDE_REGION);
  assert.doesNotMatch(reason, /region_unknown/); // no raw internal code leaking through
  assert.match(reason, /service area|region/i);
});

test('a FRESH unattributed order maps to Pending with an actionable plain-language reason', () => {
  const events = [ev({ action: 'unattributed', accountId: null })];
  const { status, reason } = computeFinalStatus(events, FRESH_NOW);
  assert.equal(status, STATUS.PENDING);
  assert.doesNotMatch(reason, /unattributed/i);
});

test('a FRESH needs_login (retry exhausted) maps to Pending, not a raw internal code', () => {
  const events = [ev({ outcome: 'needs_login', accepted: false })];
  const { status, reason } = computeFinalStatus(events, FRESH_NOW);
  assert.equal(status, STATUS.PENDING);
  assert.doesNotMatch(reason, /needs_login/);
});

// Audit finding (2026-07-13): 78 orders sat in "Pending" indefinitely — 77
// unattributed emails from a single 3-day-old batch, 1 needs_login attempt
// from 44 hours prior — because nothing in this system ever retries an
// unresolved order on its own. None of them were "genuinely still being
// processed". Pending must only mean that; anything older is Failed.

test('a STALE unattributed order (no automatic path to ever resolve) reclassifies to Failed', () => {
  const events = [ev({ action: 'unattributed', accountId: null })];
  const { status, reason } = computeFinalStatus(events, STALE_NOW);
  assert.equal(status, STATUS.FAILED);
  assert.match(reason, /won.t resolve on its own/i);
});

test('a STALE needs_login (never retried) reclassifies to Failed', () => {
  const events = [ev({ outcome: 'needs_login', accepted: false })];
  const { status, reason } = computeFinalStatus(events, STALE_NOW);
  assert.equal(status, STATUS.FAILED);
  assert.doesNotMatch(reason, /needs_login/);
});

test('a FRESH unverified decline stays Pending; a STALE one reclassifies to Failed', () => {
  const events = [ev({ action: 'decline', outcome: 'unverified', declined: false })];
  const freshResult = computeFinalStatus(events, FRESH_NOW);
  assert.equal(freshResult.status, STATUS.PENDING);
  const staleResult = computeFinalStatus(events, STALE_NOW);
  assert.equal(staleResult.status, STATUS.FAILED);
});

test('a FRESH unverified accept stays Pending (not Accepted); STALE → Failed', () => {
  const events = [ev({ action: 'accept', outcome: 'unverified', accepted: false })];
  const freshResult = computeFinalStatus(events, FRESH_NOW);
  assert.equal(freshResult.status, STATUS.PENDING);
  assert.match(freshResult.reason, /confirm/i);
  assert.notEqual(freshResult.status, STATUS.ACCEPTED);
  const staleResult = computeFinalStatus(events, STALE_NOW);
  assert.equal(staleResult.status, STATUS.FAILED);
});

test('still_available maps to Failed — never Accepted', () => {
  const events = [ev({ action: 'accept', outcome: 'still_available', accepted: false })];
  const { status, reason } = computeFinalStatus(events);
  assert.equal(status, STATUS.FAILED);
  assert.match(reason, /available/i);
});

test('taken-by-another-vendor maps to Failed with a plain reason', () => {
  const events = [ev({ outcome: 'taken', accepted: false })];
  const { status, reason } = computeFinalStatus(events);
  assert.equal(status, STATUS.FAILED);
  assert.match(reason, /another vendor/i);
});

test('an unrecognized/technical outcome still falls back to Failed with SOME reason (never blank)', () => {
  const events = [ev({ outcome: 'something-new-we-have-not-seen', accepted: false })];
  const { status, reason } = computeFinalStatus(events);
  assert.equal(status, STATUS.FAILED);
  assert.ok(reason && reason.length > 0);
});
