// Production latency report — turns real, already-persisted order events into
// a stage-by-stage latency breakdown, so the next optimization target is
// picked from evidence, not a guess.
//
// Pipeline stages measured (see worker.js/acceptExecutor.js/declineExecutor.js
// for where each is captured):
//   detectionLatencyMs — order available -> we noticed it. Honest for Gmail
//     (anchored to the email's own receipt time); an UPPER BOUND for the
//     portal poller (anchored to the previous poll tick — no origination
//     timestamp exists to be exact about it).
//   lockWaitMs          — time to acquire the exactly-once lock.
//   durationMs          — the accept/decline race itself (Path A vs Path B).
//   verifyDurationMs    — confirming the outcome against the portal afterward.
//   totalMs             — detection -> final result, end to end.

const STAGES = [
  { key: 'detectionLatencyMs', label: 'Detection latency (order available → noticed)' },
  { key: 'lockWaitMs', label: 'Lock acquisition' },
  { key: 'durationMs', label: 'Accept/decline race (Path A vs Path B)' },
  { key: 'verifyDurationMs', label: 'Portal verify (confirm outcome)' },
  { key: 'totalMs', label: 'Total (detection → final result)' },
];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function summarize(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
  };
}

function stageSummaries(attempts) {
  const out = {};
  for (const { key, label } of STAGES) {
    out[key] = { label, ...summarize(attempts.map((e) => e[key])) };
  }
  return out;
}

/**
 * @param {object[]} events  raw LIVE (non-dryRun) order events — real
 *        production data, e.g. from OrderEventsStore.list({ dryRun: false }).
 * @returns {{
 *   sampleSize: number,
 *   stages: object,
 *   bySource: {gmail: object, portal: object},
 *   byResult: {accepted: object, declined: object, failed: object},
 *   outcomeCounts: {accepted:number, declined:number, failed:number, total:number,
 *     acceptRate:number|null, declineRate:number|null, failRate:number|null},
 *   bottleneck: {key:string, label:string, p50:number}|null,
 * }}
 */
export function buildLatencyReport(events) {
  // Only real accept/decline attempts carry a race/verify to measure — skip
  // (region_unknown) and unattributed rows have no such pipeline.
  const attempts = events.filter((e) => e.action === 'accept' || e.action === 'decline');

  const stages = stageSummaries(attempts);

  // Per-attempt, not per-order: a lost order is commonly detected (and
  // attempted) by both the portal poller and the Gmail watcher, so a loss can
  // contribute two rows here while a win usually contributes one (the lock is
  // only released — letting a second detector retry — when the first attempt
  // did NOT accept). Treat this as a lower bound on the true per-order win
  // rate, not an exact one.
  const acceptedCount = attempts.filter((e) => e.accepted).length;
  const declinedCount = attempts.filter((e) => e.declined).length;
  const failedCount = attempts.length - acceptedCount - declinedCount;
  const outcomeCounts = {
    accepted: acceptedCount,
    declined: declinedCount,
    failed: failedCount,
    total: attempts.length,
    acceptRate: attempts.length ? acceptedCount / attempts.length : null,
    declineRate: attempts.length ? declinedCount / attempts.length : null,
    failRate: attempts.length ? failedCount / attempts.length : null,
  };

  const bySource = {
    gmail: stageSummaries(attempts.filter((e) => e.source === 'gmail')),
    portal: stageSummaries(attempts.filter((e) => e.source === 'portal')),
  };

  const byResult = {
    accepted: stageSummaries(attempts.filter((e) => e.accepted)),
    declined: stageSummaries(attempts.filter((e) => e.declined)),
    failed: stageSummaries(attempts.filter((e) => !e.accepted && !e.declined)),
  };

  // The bottleneck is whichever ADDITIVE stage (not totalMs, which is their
  // sum) has the highest p50 — the one that, on a typical order, eats the
  // most time. Ties broken by whichever appears first in STAGES.
  const additive = STAGES.filter((s) => s.key !== 'totalMs');
  let bottleneck = null;
  for (const { key, label } of additive) {
    const s = stages[key];
    if (s && s.p50 != null && (!bottleneck || s.p50 > bottleneck.p50)) {
      bottleneck = { key, label, p50: s.p50 };
    }
  }

  return { sampleSize: attempts.length, stages, bySource, byResult, outcomeCounts, bottleneck };
}

function fmt(ms) {
  return ms == null ? 'n/a' : `${Math.round(ms)}ms`;
}

function formatStageTable(stages, indent = '  ') {
  const lines = [];
  for (const s of Object.values(stages)) {
    if (s.count === undefined) {
      lines.push(`${indent}${s.label}: no data`);
      continue;
    }
    lines.push(
      `${indent}${s.label}: n=${s.count} min=${fmt(s.min)} p50=${fmt(s.p50)} p90=${fmt(s.p90)} p99=${fmt(s.p99)} max=${fmt(s.max)} avg=${fmt(s.avg)}`
    );
  }
  return lines;
}

/** Render a report (from buildLatencyReport) as plain text for a CLI/log. */
export function formatLatencyReport(report) {
  const lines = [];
  lines.push(`Production latency report — ${report.sampleSize} real accept/decline attempts`);
  if (report.sampleSize === 0) {
    lines.push('No real attempts with latency data yet.');
    return lines.join('\n');
  }
  const oc = report.outcomeCounts;
  if (oc) {
    const pct = (r) => (r == null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
    lines.push('');
    lines.push(
      `Outcome (per attempt, not per order — a loss is often logged twice, once per detector): ` +
        `${oc.accepted} accepted (${pct(oc.acceptRate)}), ${oc.declined} declined (${pct(oc.declineRate)}), ` +
        `${oc.failed} failed (${pct(oc.failRate)}) of ${oc.total}`
    );
  }

  lines.push('');
  lines.push('Overall:');
  lines.push(...formatStageTable(report.stages));

  for (const source of ['gmail', 'portal']) {
    const s = report.bySource[source];
    const n = Object.values(s)[0]?.count;
    if (!n) continue;
    lines.push('');
    lines.push(`By source — ${source}:`);
    lines.push(...formatStageTable(s));
  }

  lines.push('');
  if (report.bottleneck) {
    lines.push(
      `BOTTLENECK: "${report.bottleneck.label}" has the highest typical (p50) cost — ${fmt(report.bottleneck.p50)}.`
    );
    lines.push('Optimize only this stage next; re-run this report after to confirm the real, measured effect.');
  } else {
    lines.push('No bottleneck identified — not enough real data yet. Instrument, wait, re-run.');
  }
  return lines.join('\n');
}

export default buildLatencyReport;
