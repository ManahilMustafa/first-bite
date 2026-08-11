import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLatencyReport, formatLatencyReport } from '../src/util/latencyReport.js';

function attempt(overrides = {}) {
  return {
    action: 'accept',
    accepted: true,
    declined: false,
    source: 'gmail',
    detectionLatencyMs: 500,
    lockWaitMs: 1,
    durationMs: 200,
    verifyDurationMs: 50,
    totalMs: 751,
    ...overrides,
  };
}

test('sample size only counts real accept/decline attempts, not skip/unattributed rows', () => {
  const events = [
    attempt(),
    { action: 'skip', reason: 'region_unknown' },
    { action: 'unattributed' },
  ];
  const report = buildLatencyReport(events);
  assert.equal(report.sampleSize, 1);
});

test('computes correct percentiles for a known distribution', () => {
  // 10 events with durationMs 100..1000 in steps of 100 — easy to hand-verify.
  const events = Array.from({ length: 10 }, (_, i) => attempt({ durationMs: (i + 1) * 100 }));
  const report = buildLatencyReport(events);
  const s = report.stages.durationMs;
  assert.equal(s.count, 10);
  assert.equal(s.min, 100);
  assert.equal(s.max, 1000);
  assert.equal(s.p50, 600); // floor(0.5*10)=5 -> sorted[5] = 600
  assert.equal(s.avg, 550);
});

test('identifies the bottleneck as the additive stage with the highest p50', () => {
  const events = Array.from({ length: 5 }, () =>
    attempt({ detectionLatencyMs: 500, lockWaitMs: 1, durationMs: 200, verifyDurationMs: 50 })
  );
  const report = buildLatencyReport(events);
  assert.equal(report.bottleneck.key, 'detectionLatencyMs');
});

test('totalMs is never mistaken for the bottleneck even though it is numerically largest', () => {
  const events = Array.from({ length: 5 }, () => attempt());
  const report = buildLatencyReport(events);
  assert.notEqual(report.bottleneck.key, 'totalMs');
});

test('splits by source (gmail vs portal) independently', () => {
  const events = [
    attempt({ source: 'gmail', durationMs: 100 }),
    attempt({ source: 'portal', durationMs: 900 }),
  ];
  const report = buildLatencyReport(events);
  assert.equal(report.bySource.gmail.durationMs.p50, 100);
  assert.equal(report.bySource.portal.durationMs.p50, 900);
});

test('splits by result: accepted / declined / failed', () => {
  const events = [
    attempt({ accepted: true, declined: false, durationMs: 100 }),
    attempt({ accepted: false, declined: true, durationMs: 200 }),
    attempt({ accepted: false, declined: false, durationMs: 300 }),
  ];
  const report = buildLatencyReport(events);
  assert.equal(report.byResult.accepted.durationMs.count, 1);
  assert.equal(report.byResult.declined.durationMs.count, 1);
  assert.equal(report.byResult.failed.durationMs.count, 1);
});

test('a stage with no numeric data (e.g. detectionLatencyMs never anchored) reports no data, not zero', () => {
  const events = [attempt({ detectionLatencyMs: null })];
  const report = buildLatencyReport(events);
  assert.equal(report.stages.detectionLatencyMs.count, undefined);
});

test('empty input produces a zero-sample report with no bottleneck (never crashes)', () => {
  const report = buildLatencyReport([]);
  assert.equal(report.sampleSize, 0);
  assert.equal(report.bottleneck, null);
});

test('formatLatencyReport renders a readable report and handles the empty case', () => {
  const empty = formatLatencyReport(buildLatencyReport([]));
  assert.match(empty, /No real attempts/);

  const events = Array.from({ length: 3 }, () => attempt());
  const text = formatLatencyReport(buildLatencyReport(events));
  assert.match(text, /BOTTLENECK/);
  assert.match(text, /Detection latency/);
});

test('outcomeCounts tallies accepted/declined/failed attempts with rates', () => {
  const events = [
    attempt({ accepted: true, declined: false }),
    attempt({ accepted: true, declined: false }),
    attempt({ accepted: false, declined: true }),
    attempt({ accepted: false, declined: false }),
  ];
  const report = buildLatencyReport(events);
  assert.deepEqual(report.outcomeCounts, {
    accepted: 2,
    declined: 1,
    failed: 1,
    total: 4,
    acceptRate: 0.5,
    declineRate: 0.25,
    failRate: 0.25,
  });
});

test('outcomeCounts rates are null (not NaN) for an empty report', () => {
  const report = buildLatencyReport([]);
  assert.deepEqual(report.outcomeCounts, {
    accepted: 0,
    declined: 0,
    failed: 0,
    total: 0,
    acceptRate: null,
    declineRate: null,
    failRate: null,
  });
});

test('formatLatencyReport prints the accept/decline/fail rate line', () => {
  const events = [
    attempt({ accepted: true, declined: false }),
    attempt({ accepted: false, declined: false }),
  ];
  const text = formatLatencyReport(buildLatencyReport(events));
  assert.match(text, /1 accepted \(50\.0%\)/);
  assert.match(text, /0 declined \(0\.0%\)/);
  assert.match(text, /1 failed \(50\.0%\)/);
});
