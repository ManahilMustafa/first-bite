// In-memory atomic lock for single-process deployments and tests.
//
// JS is single-threaded, so a Map check-and-set inside one synchronous tick is
// atomic — no two concurrent acquire() calls can both see the key absent.
// TTL auto-expiry mirrors Redis SET NX PX semantics so behaviour matches prod.
export class MemoryLock {
  constructor({ defaultTtlMs = 120000 } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.held = new Map(); // key -> expiresAtMs
  }

  _now() {
    return Date.now();
  }

  _sweep(key) {
    const exp = this.held.get(key);
    if (exp !== undefined && exp <= this._now()) this.held.delete(key);
  }

  async acquire(key, ttlMs = this.defaultTtlMs) {
    this._sweep(key);
    if (this.held.has(key)) return false; // someone else owns it
    this.held.set(key, this._now() + ttlMs);
    return true;
  }

  async release(key) {
    this.held.delete(key);
  }

  async isHeld(key) {
    this._sweep(key);
    return this.held.has(key);
  }

  async close() {
    this.held.clear();
  }
}
