import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderTimeline } from '../src/util/orderTimeline.js';

test('a simple successful accept produces a clean, chronological timeline', () => {
  const events = [
    {
      ts: 1000,
      source: 'gmail',
      action: 'accept',
      accepted: true,
      outcome: 'accepted',
      durationMs: 200,
      paths: { email: { ok: true, outcome: 'accepted', steps: ['email_get'] } },
    },
  ];
  const tl = buildOrderTimeline(events);
  const labels = tl.map((t) => t.label);
  assert.ok(labels.some((l) => /Detected via inbox email/.test(l)));
  assert.ok(labels.some((l) => /Region Check.*matched/.test(l)));
  assert.ok(labels.some((l) => /Email Link Attempt started/.test(l)));
  assert.ok(labels.some((l) => /Accept succeeded/.test(l)));
  // chronological
  for (let i = 1; i < tl.length; i++) assert.ok(tl[i].ts >= tl[i - 1].ts);
});

test('a login bounce + retry surfaces a Login Retry entry (from duplicate email_get steps)', () => {
  const events = [
    {
      ts: 1000,
      source: 'gmail',
      action: 'accept',
      accepted: true,
      outcome: 'accepted',
      durationMs: 500,
      paths: { email: { ok: true, outcome: 'accepted', steps: ['email_get', 'email_get'] } },
    },
  ];
  const tl = buildOrderTimeline(events);
  assert.ok(tl.some((t) => /Login Retry/.test(t.label)));
});

test('a portal retry (reauthed flag) surfaces a Portal Retry entry', () => {
  const events = [
    {
      ts: 1000,
      source: 'portal',
      action: 'accept',
      accepted: true,
      outcome: 'accepted',
      durationMs: 500,
      paths: { portal: { ok: true, outcome: 'accepted', reauthed: true, otpFetched: true } },
    },
  ];
  const tl = buildOrderTimeline(events);
  assert.ok(tl.some((t) => /Portal Retry/.test(t.label)));
  assert.ok(tl.some((t) => /OTP/.test(t.label)));
});

test('multiple attempts across time all appear, merged and sorted', () => {
  const events = [
    { ts: 1000, source: 'gmail', action: 'skip', reason: 'region_unknown' },
    { ts: 5000, source: 'gmail', action: 'accept', accepted: true, outcome: 'accepted', durationMs: 100 },
  ];
  const tl = buildOrderTimeline(events);
  assert.ok(tl[0].ts <= tl[tl.length - 1].ts);
  assert.ok(tl.some((t) => /Region Check.*could not be determined/.test(t.label)));
  assert.ok(tl.some((t) => /Accept succeeded/.test(t.label)));
});

test('timeline labels never leak raw internal outcome codes verbatim without translation', () => {
  const events = [
    {
      ts: 1000,
      source: 'gmail',
      action: 'accept',
      accepted: false,
      outcome: 'needs_login',
      durationMs: 100,
      paths: { email: { ok: false, outcome: 'needs_login', steps: ['email_get'] } },
    },
  ];
  const tl = buildOrderTimeline(events);
  const resultLine = tl.find((t) => /^Accept/.test(t.label));
  assert.match(resultLine.label, /login required/i);
});
