// Portal poller — the reliable, bounded detector.
//
// Polls the authenticated New Orders page every N ms and emits any order id it
// hasn't seen before. Email/push can be delayed; the portal is the source of
// truth, so this guarantees detection within one poll interval regardless of
// email behaviour. Tighter interval = lower latency but higher ban risk.
//
// On 403/429/timeout: exponential backoff. After N consecutive block signals,
// open a circuit — pause portal polling (Gmail detection still runs) until
// cooldown expires or resume() is called.
import { logger } from '../util/logger.js';
import { parseAddressMeta } from '../util/regionFilter.js';
import { PortalHttpError } from '../portal/session.js';

const ORDER_ID_RE = /\b(\d{2,4}-\d{4,6})\b/g; // e.g. 266-03335

const DEFAULT_INTERVAL_MS = 10000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;

function resolveFloorMs() {
  if (process.env.PORTAL_POLL_FLOOR_MS === undefined || process.env.PORTAL_POLL_FLOOR_MS === '') {
    return 5000;
  }
  return Number(process.env.PORTAL_POLL_FLOOR_MS);
}

function resolveCircuitThreshold() {
  const n = Number(process.env.PORTAL_CIRCUIT_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function resolveCooldownMs() {
  const n = Number(process.env.PORTAL_CIRCUIT_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}

/** @param {unknown} err */
export function isBlockSignal(err) {
  if (err instanceof PortalHttpError && err.isThrottle) return true;
  if (err && typeof err === 'object' && 'status' in err) {
    const s = /** @type {{status?:number}} */ (err).status;
    if (s === 403 || s === 429) return true;
  }
  const code = err && typeof err === 'object' && 'code' in err ? String(/** @type {{code?:string}} */ (err).code) : '';
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|ABORT/i.test(code)) return true;
  const msg = String(err?.message || err || '');
  if (/Portal HTTP (403|429)|status (403|429)|ETIMEDOUT|ECONNRESET|timeout/i.test(msg)) return true;
  return false;
}

export class PortalPoller {
  /**
   * @param {object} opts
   * @param {import('../portal/session.js').PortalSession} opts.session
   * @param {(order:{orderId:string, source:'portal'})=>void} opts.onOrder
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.minIntervalMs] override floor (tests: 0)
   * @param {number} [opts.circuitThreshold]
   * @param {number} [opts.cooldownMs]
   * @param {(html:string)=>string[]} [opts.parseOrders] custom order-id extractor
   * @param {string} [opts.newOrdersPath]
   */
  constructor({
    session,
    onOrder,
    intervalMs,
    minIntervalMs,
    circuitThreshold,
    cooldownMs,
    parseOrders,
    newOrdersPath,
    log,
  }) {
    this.session = session;
    this.onOrder = onOrder;

    const floor =
      minIntervalMs !== undefined && minIntervalMs !== null
        ? Number(minIntervalMs)
        : resolveFloorMs();
    let requested =
      intervalMs ?? (Number(process.env.PORTAL_POLL_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
    if (!Number.isFinite(requested) || requested <= 0) requested = DEFAULT_INTERVAL_MS;
    if (floor > 0 && requested < floor) {
      (log || logger)('poller').warn('poll interval below floor — clamping', {
        requested,
        floor,
      });
      requested = floor;
    }
    this.intervalMs = requested;
    this.circuitThreshold = circuitThreshold ?? resolveCircuitThreshold();
    this.cooldownMs = cooldownMs ?? resolveCooldownMs();

    this.parseOrders = parseOrders || defaultParseOrders;
    this.newOrdersPath = newOrdersPath || session.routes.newOrders;
    this.log = (log || logger)(`poller:${session.username}`);
    this.seen = new Set();
    this._timer = null;
    this._cooldownTimer = null;
    this._running = false;
    this._stopped = false;
    this._lastPollAt = null;
    this.paused = false;
    this.pauseReason = null;
    this.pausedAt = null;
    this.consecutiveBlockErrors = 0;
    this.backoffLevel = 0;
    this.currentBackoffMs = this.intervalMs;
    this.stats = {
      polls: 0,
      errors: 0,
      blockSignals: 0,
      circuitOpens: 0,
      detected: 0,
      lastPollMs: 0,
    };
  }

  /** Mark the current orders as already-seen without emitting (baseline). */
  async primeBaseline() {
    try {
      const page = await this.session.authedGet(this.newOrdersPath);
      for (const id of this.parseOrders(page.body)) this.seen.add(id);
      this.log.info('baseline primed', { count: this.seen.size });
    } catch (e) {
      this.log.warn('baseline prime failed', { err: String(e) });
    }
  }

  start() {
    if (this._stopped) return;
    if (this.paused) return;
    if (this._timer) return;
    this.log.info('poller started', { intervalMs: this.intervalMs });
    this._schedule(0);
  }

  stop() {
    this._stopped = true;
    this._clearTimers();
  }

  /**
   * Clear the circuit breaker and resume polling at the base interval.
   * Used by the control-plane resume endpoint and after cooldown probe success.
   */
  resume() {
    this._clearCooldownTimer();
    this.paused = false;
    this.pauseReason = null;
    this.pausedAt = null;
    this.consecutiveBlockErrors = 0;
    this.backoffLevel = 0;
    this.currentBackoffMs = this.intervalMs;
    this._stopped = false;
    this._clearPollTimer();
    this.log.info('poller resumed');
    this._schedule(0);
  }

  /** Snapshot for orchestrator.status() / dashboard. */
  statusSnapshot() {
    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      pausedAt: this.pausedAt,
      backoffMs: this.currentBackoffMs,
      consecutiveBlockErrors: this.consecutiveBlockErrors,
      intervalMs: this.intervalMs,
      stats: { ...this.stats },
    };
  }

  _schedule(delayMs) {
    if (this._stopped || this.paused) return;
    this._clearPollTimer();
    this.currentBackoffMs = delayMs;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._tick();
    }, delayMs);
    this._timer.unref?.();
  }

  _clearPollTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _clearCooldownTimer() {
    if (this._cooldownTimer) {
      clearTimeout(this._cooldownTimer);
      this._cooldownTimer = null;
    }
  }

  _clearTimers() {
    this._clearPollTimer();
    this._clearCooldownTimer();
  }

  async _tick() {
    if (this._running || this._stopped || this.paused) return;
    this._running = true;
    // Bound for portal detection latency: order wasn't present as of the last
    // successful poll start. First tick has no anchor (null is honest).
    const previousPollAt = this._lastPollAt;
    this._lastPollAt = Date.now();
    const t0 = process.hrtime.bigint();
    try {
      const page = await this.session.authedGet(this.newOrdersPath);
      const ids = this.parseOrders(page.body);
      for (const id of ids) {
        if (!this.seen.has(id)) {
          this.seen.add(id);
          this.stats.detected++;
          this.log.info('NEW order detected', { orderId: id });
          try {
            const address = extractAddressNearOrder(page.body, id);
            const meta = parseAddressMeta(address || '');
            this.onOrder({
              orderId: id,
              source: 'portal',
              address,
              zip: meta.zip,
              state: meta.state,
              previousPollAt,
            });
          } catch (e) {
            this.log.error('onOrder handler threw', { err: String(e) });
          }
        }
      }
      this.stats.polls++;
      this.consecutiveBlockErrors = 0;
      this.backoffLevel = 0;
      this.currentBackoffMs = this.intervalMs;
      this._schedule(this.intervalMs);
    } catch (e) {
      this.stats.errors++;
      if (isBlockSignal(e)) {
        this.stats.blockSignals++;
        this.consecutiveBlockErrors++;
        this.backoffLevel++;
        const delay = Math.min(this.intervalMs * 2 ** (this.backoffLevel - 1), BACKOFF_CAP_MS);
        this.currentBackoffMs = delay;
        this.log.warn('poll block/throttle signal', {
          err: String(e),
          consecutive: this.consecutiveBlockErrors,
          nextDelayMs: delay,
        });
        if (this.consecutiveBlockErrors >= this.circuitThreshold) {
          this._openCircuit(String(e?.message || e));
        } else {
          this._schedule(delay);
        }
      } else {
        this.log.warn('poll error', { err: String(e) });
        this._schedule(this.intervalMs);
      }
    } finally {
      this.stats.lastPollMs = Number(process.hrtime.bigint() - t0) / 1e6;
      this._running = false;
    }
  }

  _openCircuit(reason) {
    this.stats.circuitOpens++;
    this.paused = true;
    this.pauseReason = reason || 'circuit_open';
    this.pausedAt = new Date().toISOString();
    this._clearPollTimer();
    this.log.warn('portal poller circuit OPEN — pausing portal polls (Gmail still active)', {
      reason: this.pauseReason,
      cooldownMs: this.cooldownMs,
      threshold: this.circuitThreshold,
    });
    if (this.cooldownMs > 0) {
      this._cooldownTimer = setTimeout(() => this._cooldownProbe(), this.cooldownMs);
      this._cooldownTimer.unref?.();
    }
  }

  async _cooldownProbe() {
    this._cooldownTimer = null;
    if (this._stopped) return;
    this.log.info('circuit cooldown elapsed — probing portal');
    this.paused = false;
    this.pauseReason = null;
    this.pausedAt = null;
    this.consecutiveBlockErrors = 0;
    this.backoffLevel = 0;
    // One immediate tick; on block signal it will count toward a fresh circuit.
    this._schedule(0);
  }
}

/** Pull a property address from HTML near an order id (for region filtering). */
export function extractAddressNearOrder(html, orderId) {
  const idx = html.indexOf(orderId);
  if (idx === -1) return undefined;
  const window = html
    .slice(Math.max(0, idx - 800), idx + 800)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = window.match(/([0-9][0-9A-Za-z .,'/-]{8,90}\b[A-Z]{2}\s+\d{5}\b)/);
  return m ? m[1].trim() : undefined;
}

/** Default: pull order-number tokens (e.g. 266-03335) out of the page text. */
export function defaultParseOrders(html) {
  const ids = new Set();
  let m;
  ORDER_ID_RE.lastIndex = 0;
  while ((m = ORDER_ID_RE.exec(html))) ids.add(m[1]);
  return [...ids];
}

export default PortalPoller;
