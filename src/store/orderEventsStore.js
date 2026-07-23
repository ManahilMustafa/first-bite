// Order events store — an append-only log of every detected order and what the
// bot did with it (accept / decline / skip / unattributed). Powers the dashboard
// "orders feed" and the per-user day/week/month statistics.
//
// Storage is JSONL (one event per line) for cheap, crash-safe appends. Volume is
// low (orders trickle in), so reads parse the whole file and aggregate in memory.
import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computeFinalStatus } from '../util/orderStatus.js';
import { buildOrderTimeline } from '../util/orderTimeline.js';

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

  /**
   * Recent events, newest first. Optional filters.
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {string} [opts.accountId]
   * @param {string} [opts.action]
   * @param {boolean} [opts.dryRun]  when set, keep only events whose `dryRun` flag
   *        matches exactly — `true` for inbox-scan/backfill results (never real
   *        actions), `false` for real live detections. Omit to return both.
   * @param {number} [opts.since]  epoch ms — keep only events at or after this time
   *        (e.g. an account's `activatedAt`, to hide pre-go-live history).
   */
  async list({ limit = 100, accountId, action, dryRun, since } = {}) {
    let all = await this._readAll();
    if (accountId) all = all.filter((e) => e.accountId === accountId);
    if (action) all = all.filter((e) => e.action === action);
    if (dryRun !== undefined) all = all.filter((e) => isDryRun(e) === dryRun);
    if (since !== undefined) all = all.filter((e) => (e.ts || 0) >= since);
    all.reverse();
    return all.slice(0, limit);
  }

  /**
   * The customer-facing Orders view: every LIVE (non-preview) order, collapsed
   * to ONE record per order — however many times it was actually detected or
   * retried — with a single final status/reason plus its full technical
   * timeline available for the expandable detail view.
   *
   * Pure in-memory grouping over already-persisted local data: no Gmail/portal
   * calls, so this is always fast regardless of what the bot is doing live.
   *
   * @param {object} [opts]
   * @param {number} [opts.since]  epoch ms cutoff (e.g. earliest account activatedAt)
   * @param {string} [opts.accountId]
   * @param {number} [opts.limit]  max ORDERS returned (not raw rows)
   */
  async liveOrders({ since, accountId, limit = 200 } = {}) {
    const raw = await this.list({ dryRun: false, since, accountId, limit: Number.MAX_SAFE_INTEGER });

    const groups = new Map();
    for (const e of raw) {
      const key = `${e.accountId || ''}:${e.orderId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }

    const orders = [];
    for (const events of groups.values()) {
      const sorted = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const last = sorted[sorted.length - 1];
      const first = sorted[0];
      const { status, reason } = computeFinalStatus(sorted);
      orders.push({
        orderId: last.orderId,
        accountId: last.accountId || null,
        account: last.account || null,
        forwardingEmail: last.forwardingEmail || null,
        address: last.address || first.address || null,
        state: last.state || first.state || null,
        status,
        reason,
        firstDetectedAt: first.ts || null,
        lastUpdatedAt: last.ts || null,
        attemptCount: sorted.length,
        timeline: buildOrderTimeline(sorted),
      });
    }

    orders.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
    return orders.slice(0, limit);
  }

  /**
   * Per-account stats over rolling windows (last 24h / 7d / 30d), plus overall.
   * Inbox-scan/backfill results (`dryRun: true`) are excluded — they're previews
   * of what the bot WOULD do, not real activity, and would otherwise inflate the
   * real detected/accepted/declined counts.
   * @param {number} [now] epoch ms (injectable for tests)
   */
  async stats(now = Date.now()) {
    const all = (await this._readAll()).filter((e) => !isDryRun(e));
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

/**
 * Whether an event is an inbox-scan/backfill PREVIEW rather than real activity.
 * New events always carry an explicit `dryRun` flag; this only exists for
 * backward compatibility with events recorded before that flag was added:
 *  - `action: 'detected'` is emitted EXCLUSIVELY by the scan endpoint — the live
 *    pipeline only ever records accept/decline/skip/unattributed — so it's
 *    unambiguously a preview regardless of the (missing) flag.
 *  - a legacy `unattributed` row is otherwise ambiguous (both the live
 *    onUnattributed handler and the old scan handler used that action name),
 *    but the live handler has always attached a `candidates` array (even when
 *    empty) and the old scan handler never did — so its absence means "scan".
 */
function isDryRun(e) {
  if (e.dryRun !== undefined) return !!e.dryRun;
  if (e.action === 'detected') return true;
  if (e.action === 'unattributed') return e.candidates === undefined;
  return false;
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
