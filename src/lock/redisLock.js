// Redis-backed lock for multi-process fleets. Uses SET key value NX PX ttl,
// the canonical atomic "acquire if absent with expiry" primitive. Release uses
// a check-and-delete Lua script so a worker only releases a lock it still owns
// (prevents releasing a lock that already expired and was re-acquired elsewhere).
//
// Requires the optional `redis` package:  npm install redis
import { randomUUID } from 'node:crypto';

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export class RedisLock {
  constructor(client, { defaultTtlMs = 120000 } = {}) {
    this.client = client;
    this.defaultTtlMs = defaultTtlMs;
    this.tokens = new Map(); // key -> our ownership token
  }

  static async connect({ redisUrl = 'redis://127.0.0.1:6379', defaultTtlMs = 120000 } = {}) {
    let redis;
    try {
      redis = await import('redis');
    } catch {
      throw new Error('LOCK_BACKEND=redis requires the "redis" package: npm install redis');
    }
    const client = redis.createClient({ url: redisUrl });
    client.on('error', () => {}); // surfaced via acquire failures; don't crash the process
    await client.connect();
    return new RedisLock(client, { defaultTtlMs });
  }

  async acquire(key, ttlMs = this.defaultTtlMs) {
    const token = randomUUID();
    const ok = await this.client.set(key, token, { NX: true, PX: ttlMs });
    if (ok === 'OK') {
      this.tokens.set(key, token);
      return true;
    }
    return false;
  }

  async release(key) {
    const token = this.tokens.get(key);
    if (!token) return;
    try {
      await this.client.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
    } finally {
      this.tokens.delete(key);
    }
  }

  async isHeld(key) {
    return (await this.client.exists(key)) === 1;
  }

  async close() {
    try {
      await this.client.quit();
    } catch {
      /* ignore */
    }
  }
}
