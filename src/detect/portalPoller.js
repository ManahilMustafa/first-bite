// Portal poller — the reliable, bounded detector.
//
// Polls the authenticated New Orders page every N ms and emits any order id it
// hasn't seen before. Email/push can be delayed; the portal is the source of
// truth, so this guarantees detection within one poll interval regardless of
// email behaviour. Tighter interval = lower latency but higher ban risk.
import { logger } from '../util/logger.js';
import { parseAddressMeta } from '../util/regionFilter.js';

const ORDER_ID_RE = /\b(\d{2,4}-\d{4,6})\b/g; // e.g. 266-03335

export class PortalPoller {
  /**
   * @param {object} opts
   * @param {import('../portal/session.js').PortalSession} opts.session
   * @param {(order:{orderId:string, source:'portal'})=>void} opts.onOrder
   * @param {number} [opts.intervalMs]
   * @param {(html:string)=>string[]} [opts.parseOrders] custom order-id extractor
   * @param {string} [opts.newOrdersPath]
   */
  constructor({ session, onOrder, intervalMs, parseOrders, newOrdersPath, log }) {
    this.session = session;
    this.onOrder = onOrder;
    this.intervalMs = intervalMs ?? (Number(process.env.PORTAL_POLL_INTERVAL_MS) || 2000);
    this.parseOrders = parseOrders || defaultParseOrders;
    this.newOrdersPath = newOrdersPath || session.routes.newOrders;
    this.log = (log || logger)(`poller:${session.username}`);
    this.seen = new Set();
    this._timer = null;
    this._running = false;
    this._stopped = false;
    this.stats = { polls: 0, errors: 0, detected: 0, lastPollMs: 0 };
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
    if (this._timer || this._stopped) return;
    const tick = async () => {
      if (this._running || this._stopped) return;
      this._running = true;
      // The order can't have been visible any earlier than the START of the
      // PREVIOUS tick (that's the last time we checked and it wasn't there) —
      // the only honest detection-latency bound we have for a portal-only
      // order (there's no origination timestamp to anchor to, unlike email).
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
      } catch (e) {
        this.stats.errors++;
        this.log.warn('poll error', { err: String(e) });
      } finally {
        this.stats.lastPollMs = Number(process.hrtime.bigint() - t0) / 1e6;
        this._running = false;
      }
    };
    this._timer = setInterval(tick, this.intervalMs);
    // Fire one immediately so we don't wait a full interval on startup.
    tick();
    this.log.info('poller started', { intervalMs: this.intervalMs });
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
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
