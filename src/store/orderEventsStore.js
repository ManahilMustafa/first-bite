// Order events store — an append-only log of every detected order and what the
// bot did with it (accept / decline / skip / unattributed). Powers the dashboard
// "orders feed" and the per-user day/week/month statistics.
//
// Storage is JSONL (one event per line) for cheap, crash-safe appends. Volume is
// low (orders trickle in), so reads parse the whole file and aggregate in memory.
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY = 86400000;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export class OrderEventsStore {
  constructor({ path = process.env.ORDER_EVENTS_STORE || './data/orders.log.jsonl' } = {}) {
    this.path = path;
    this._writeChain = Promise.resolve(); // serialize appends to avoid interleaving
  }

  /** Append one event. `ts` defaults to now; callers may pass it for determinism. */
  record(event) {
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    this._writeChain = this._writeChain
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line, 'utf8');
      })
      .catch(() => {}); // never let a logging failure break the hot path
    return this._writeChain;
  }

  async _readAll() {
    try {
      const txt = await readFile(this.path, 'utf8');
      const out = [];
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          /* skip a corrupt line */
        }
      }
      return out;
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  /** Set of `${accountId}:${orderId}` keys already recorded (for dedup on backfill). */
  async recordedKeys() {
    const all = await this._readAll();
    return new Set(all.map((e) => `${e.accountId || ''}:${e.orderId}`));
  }

  /** Recent events, newest first. Optional filters. */
  async list({ limit = 100, accountId, action } = {}) {
    let all = await this._readAll();
    if (accountId) all = all.filter((e) => e.accountId === accountId);
    if (action) all = all.filter((e) => e.action === action);
    all.reverse();
    return all.slice(0, limit);
  }

  /**
   * Per-account stats over rolling windows (last 24h / 7d / 30d), plus overall.
   * @param {number} [now] epoch ms (injectable for tests)
   */
  async stats(now = Date.now()) {
    const all = await this._readAll();
    const overall = blank();
    const byAccount = new Map();

    for (const e of all) {
      tally(overall, e);
      const key = e.accountId || '(unattributed)';
      if (!byAccount.has(key)) {
        byAccount.set(key, {
          accountId: e.accountId || null,
          label: e.account || key,
          total: blank(),
          day: blank(),
          week: blank(),
          month: blank(),
        });
      }
      const a = byAccount.get(key);
      if (e.account) a.label = e.account;
      const age = now - (e.ts || 0);
      tally(a.total, e);
      if (age <= DAY) tally(a.day, e);
      if (age <= WEEK) tally(a.week, e);
      if (age <= MONTH) tally(a.month, e);
    }

    return { overall, byAccount: [...byAccount.values()] };
  }
}

function blank() {
  return { detected: 0, accepted: 0, declined: 0, skipped: 0, unattributed: 0 };
}

function tally(bucket, e) {
  bucket.detected++;
  if (e.accepted) bucket.accepted++;
  if (e.declined) bucket.declined++;
  if (e.action === 'skip') bucket.skipped++;
  if (e.action === 'unattributed') bucket.unattributed++;
}

export default OrderEventsStore;
