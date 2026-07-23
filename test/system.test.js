import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AccountsStore } from '../src/store/accountsStore.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MemoryLock } from '../src/lock/memoryLock.js';
import { createControlPlane } from '../src/controlPlane/server.js';

const KEY = Buffer.alloc(32, 3).toString('base64');

// Polls a condition until true — used where a background orchestrator.sync()
// needs to catch up with an HTTP response that no longer awaits it.
async function waitFor(predicate, message, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  assert.fail(`timed out waiting for: ${message}`);
}

let storePath;
beforeEach(() => {
  storePath = join(tmpdir(), `accts-${randomUUID()}.json`);
});
afterEach(async () => {
  await rm(storePath, { force: true });
});

function newStore() {
  return new AccountsStore({ path: storePath, key: Buffer.from(KEY, 'base64') });
}

// ── store ───────────────────────────────────────────────────────────────────
test('store encrypts secrets at rest and decrypts on read', async () => {
  const store = newStore();
  const id = await store.upsert({
    label: 'acct1',
    portalBaseUrl: 'http://x',
    portalUsername: 'u',
    portalPassword: 'topsecret-PLAINTEXT-pw',
    gmailRefreshToken: 'refreshtoken-PLAINTEXT-xyz',
  });

  // Raw file must NOT contain the plaintext secrets.
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(storePath, 'utf8');
  assert.ok(!raw.includes('topsecret-PLAINTEXT-pw'), 'password not stored in plaintext');
  assert.ok(!raw.includes('refreshtoken-PLAINTEXT-xyz'), 'refresh token not stored in plaintext');

  // Read back decrypts.
  const acct = await store.get(id);
  assert.equal(acct.portalPassword, 'topsecret-PLAINTEXT-pw');
  assert.equal(acct.gmailRefreshToken, 'refreshtoken-PLAINTEXT-xyz');
});

test('store setActive/listActive/remove behave', async () => {
  const store = newStore();
  const id = await store.upsert({ label: 'a', portalBaseUrl: 'x', portalUsername: 'u', portalPassword: 'p' });
  assert.equal((await store.listActive()).length, 1);
  await store.setActive(id, false);
  assert.equal((await store.listActive()).length, 0);
  await store.remove(id);
  assert.equal((await store.list()).length, 0);
});

test('activatedAt is stamped once on first activation and never overwritten', async () => {
  const store = newStore();
  const before = Date.now();
  const id = await store.upsert({ label: 'a', portalBaseUrl: 'x', portalUsername: 'u', portalPassword: 'p' });
  const acct = await store.get(id);
  assert.ok(acct.activatedAt >= before, 'new active-by-default account is stamped immediately');

  const firstStamp = acct.activatedAt;
  await store.setActive(id, false);
  await store.setActive(id, true); // reactivating must NOT move the cutover forward
  const after = await store.get(id);
  assert.equal(after.activatedAt, firstStamp);
});

test('activatedAt is only set once the account actually goes active', async () => {
  const store = newStore();
  const id = await store.upsert({
    label: 'a',
    portalBaseUrl: 'x',
    portalUsername: 'u',
    portalPassword: 'p',
    active: false,
  });
  assert.equal((await store.get(id)).activatedAt, undefined);
  await store.setActive(id, true);
  assert.ok((await store.get(id)).activatedAt);
});

test('findByForwardingEmail returns only the ACTIVE matching account (case-insensitive)', async () => {
  const store = newStore();
  const id = await store.upsert({
    label: 'a',
    portalBaseUrl: 'x',
    portalUsername: 'u',
    portalPassword: 'p',
    forwardingEmail: 'Vendor@Gmail.com',
  });
  // Stored lowercased; matched case-insensitively.
  assert.equal((await store.findByForwardingEmail('vendor@gmail.com'))?.id, id);
  assert.equal((await store.findByForwardingEmail('VENDOR@GMAIL.COM'))?.id, id);

  // Deactivated → no longer attributable.
  await store.setActive(id, false);
  assert.equal(await store.findByForwardingEmail('vendor@gmail.com'), null);
});

test('upsert allows multiple accounts to share a forwardingEmail (one operator, several vendor logins)', async () => {
  const store = newStore();
  const idA = await store.upsert({
    label: 'a',
    portalBaseUrl: 'x',
    portalUsername: 'u1',
    portalPassword: 'p',
    forwardingEmail: 'shared@gmail.com',
  });
  const idB = await store.upsert({
    label: 'b',
    portalBaseUrl: 'x',
    portalUsername: 'u2',
    portalPassword: 'p',
    forwardingEmail: 'SHARED@gmail.com', // same key, different case
  });
  assert.notEqual(idA, idB);
  // Both accounts persist; Gmail-push attribution resolves to whichever comes
  // first — the other still races via its own portalPoller.
  assert.equal((await store.findByForwardingEmail('shared@gmail.com')).id, idA);
  // Updating the SAME account keeps its own forwardingEmail (no false clash).
  await store.upsert({ id: idA, label: 'a2', portalBaseUrl: 'x', portalUsername: 'u1', portalPassword: 'p', forwardingEmail: 'shared@gmail.com' });
  assert.equal((await store.findByForwardingEmail('shared@gmail.com')).label, 'a2');
});

test('upsert rejects registering the same real login (portalUsername+portalBaseUrl) twice', async () => {
  const store = newStore();
  const id = await store.upsert({
    label: 'a',
    portalBaseUrl: 'https://portal.example.com',
    portalUsername: 'vendor@gmail.com',
    portalPassword: 'p',
  });
  await assert.rejects(
    () =>
      store.upsert({
        label: 'b',
        portalBaseUrl: 'https://portal.example.com',
        portalUsername: 'VENDOR@gmail.com', // same login, different case
        portalPassword: 'p',
      }),
    /already registered/i
  );
  // Updating the SAME account keeps its own login (no false clash).
  await store.upsert({ id, label: 'a2', portalBaseUrl: 'https://portal.example.com', portalUsername: 'vendor@gmail.com', portalPassword: 'p' });
  assert.equal((await store.get(id)).label, 'a2');
});

// ── orchestrator: "more creds = more bots" ──────────────────────────────────--
function fakeFactory(record) {
  return (account) => ({
    account,
    stats: {},
    poller: null,
    async start() {
      record.started.push(account.id);
    },
    async stop() {
      record.stopped.push(account.id);
    },
    async handleOrder() {
      return {};
    },
  });
}

test('orchestrator spawns one worker per active account and tears down on deactivate', async () => {
  const store = newStore();
  const lock = new MemoryLock();
  const record = { started: [], stopped: [] };
  const orch = new Orchestrator({ store, lock, workerFactory: fakeFactory(record) });

  const id1 = await store.upsert({ label: 'a1', portalBaseUrl: 'x', portalUsername: 'u1', portalPassword: 'p' });
  await orch.sync();
  assert.equal(orch.status().length, 1);

  const id2 = await store.upsert({ label: 'a2', portalBaseUrl: 'x', portalUsername: 'u2', portalPassword: 'p' });
  await orch.sync();
  assert.equal(orch.status().length, 2, 'adding creds added a bot');

  await store.setActive(id1, false);
  await orch.sync();
  assert.equal(orch.status().length, 1, 'deactivating removed its bot');
  assert.ok(record.stopped.includes(id1));

  await orch.shutdown();
  assert.equal(orch.status().length, 0);
});

test('orchestrator.sync is idempotent (no double-spawn)', async () => {
  const store = newStore();
  const record = { started: [], stopped: [] };
  const orch = new Orchestrator({ store, lock: new MemoryLock(), workerFactory: fakeFactory(record) });
  await store.upsert({ label: 'a', portalBaseUrl: 'x', portalUsername: 'u', portalPassword: 'p' });
  await orch.sync();
  await orch.sync();
  await orch.sync();
  assert.equal(record.started.length, 1, 'started exactly once across repeated syncs');
  await orch.shutdown();
});

test('a failed start() is not retried on every sync — only after the cooldown elapses', async () => {
  const store = newStore();
  let attempts = 0;
  const flakyFactory = (account) => ({
    account,
    stats: {},
    poller: null,
    async start() {
      attempts++;
      if (attempts === 1) throw new Error('otp fetch failed: no code arrived in time');
    },
    async stop() {},
    async handleOrder() {
      return {};
    },
  });
  const orch = new Orchestrator({
    store,
    lock: new MemoryLock(),
    workerFactory: flakyFactory,
    startRetryCooldownMs: 20,
  });
  await store.upsert({ label: 'a', portalBaseUrl: 'x', portalUsername: 'u', portalPassword: 'p' });

  await orch.sync(); // fails once, enters cooldown
  assert.equal(attempts, 1);
  assert.equal(orch.status().length, 0);

  // Simulates the real trigger: an unrelated account mutation calls sync()
  // again immediately. Within the cooldown this must NOT re-attempt login
  // (and therefore must not re-trigger an OTP dispatch).
  await orch.sync();
  await orch.sync();
  assert.equal(attempts, 1, 'still on cooldown — no retry, no fresh OTP');

  await new Promise((r) => setTimeout(r, 25));
  await orch.sync(); // cooldown elapsed — retries and succeeds
  assert.equal(attempts, 2);
  assert.equal(orch.status().length, 1);

  await orch.shutdown();
});

// ── control plane HTTP API ──────────────────────────────────────────────────--
test('control plane: add account -> bot count increases (auth enforced)', async () => {
  const store = newStore();
  const record = { started: [], stopped: [] };
  const orch = new Orchestrator({ store, lock: new MemoryLock(), workerFactory: fakeFactory(record) });
  const server = createControlPlane({ store, orchestrator: orch, config: { adminToken: 'admintok' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Unauthorized without token.
  let res = await fetch(`${base}/api/accounts`);
  assert.equal(res.status, 401);

  // Health is open.
  res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);

  // Add an account. The response returns as soon as the record is saved —
  // orchestrator.sync() (which does the real, potentially slow, login) runs
  // in the background so the request never blocks on it (see syncInBackground
  // in server.js). So the bot count is awaited separately, not read off the
  // create response.
  res = await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { authorization: 'Bearer admintok', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'a', portalBaseUrl: 'http://x', portalUsername: 'u', portalPassword: 'p' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  await waitFor(() => orch.status().length === 1, 'bot spawned on account add');

  // List shows it, password redacted.
  res = await fetch(`${base}/api/accounts`, { headers: { authorization: 'Bearer admintok' } });
  const listed = await res.json();
  assert.equal(listed.accounts.length, 1);
  assert.equal(listed.accounts[0].portalPassword, '***');

  // Deactivate -> bot torn down (again, reconciled in the background).
  res = await fetch(`${base}/api/accounts/${created.id}/activate`, {
    method: 'POST',
    headers: { authorization: 'Bearer admintok', 'content-type': 'application/json' },
    body: JSON.stringify({ active: false }),
  });
  assert.equal(res.status, 200);
  await waitFor(() => orch.status().length === 0, 'bot torn down on deactivate');

  await new Promise((r) => server.close(r));
  await orch.shutdown();
});
