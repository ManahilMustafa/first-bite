// Lock interface + factory.
//
// The lock guarantees EXACTLY-ONCE accept per order across the whole fleet:
// N Gmail webhooks + M portal pollers can all spot the same order, but only the
// first to acquire `order:<id>` proceeds to accept. Everything else no-ops.
//
// Contract:
//   acquire(key, ttlMs) -> Promise<boolean>   // true if THIS caller won
//   release(key)        -> Promise<void>
//   isHeld(key)         -> Promise<boolean>
//   close()             -> Promise<void>

import { MemoryLock } from './memoryLock.js';

export function orderLockKey(orderId) {
  return `order:${orderId}`;
}

/**
 * @param {object} opts
 * @param {'memory'|'redis'} [opts.backend]
 * @param {string} [opts.redisUrl]
 * @param {number} [opts.defaultTtlMs]
 */
export async function createLock({
  backend = process.env.LOCK_BACKEND || 'memory',
  redisUrl = process.env.REDIS_URL,
  defaultTtlMs = Number(process.env.ORDER_LOCK_TTL_MS) || 120000,
} = {}) {
  if (backend === 'redis') {
    // Lazy import so the `redis` package is only required when actually used.
    const { RedisLock } = await import('./redisLock.js');
    return RedisLock.connect({ redisUrl, defaultTtlMs });
  }
  return new MemoryLock({ defaultTtlMs });
}
