#!/usr/bin/env node
// Production latency report CLI — reads real (non-preview) order events and
// prints a stage-by-stage latency breakdown, so the next optimization target
// is picked from evidence, not a guess.
//
// Usage:
//   node scripts/latency-report.mjs                 # plain-text report
//   node scripts/latency-report.mjs --json           # machine-readable
//   node scripts/latency-report.mjs --since=<epochMs> # only orders after this time
//   ORDER_EVENTS_STORE=./data/orders.log.jsonl node scripts/latency-report.mjs
import { OrderEventsStore } from '../src/store/orderEventsStore.js';
import { buildLatencyReport, formatLatencyReport } from '../src/util/latencyReport.js';

async function loadDotEnv() {
  try {
    const { readFile } = await import('node:fs/promises');
    const txt = await readFile(new URL('../.env', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env, rely on real env */
  }
}

async function main() {
  await loadDotEnv();
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const sinceArg = args.find((a) => a.startsWith('--since='));
  const since = sinceArg ? Number(sinceArg.split('=')[1]) : undefined;

  const store = new OrderEventsStore();
  const events = await store.list({ dryRun: false, since, limit: Number.MAX_SAFE_INTEGER });
  const report = buildLatencyReport(events);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatLatencyReport(report));
  }
}

main().catch((e) => {
  console.error('latency-report failed:', e);
  process.exit(1);
});
