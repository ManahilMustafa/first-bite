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

test('store advances Gmail historyId by address', async () => {
  const store = newStore();
  await store.upsert({ label: 'a', portalBaseUrl: 'x', portalUsername: 'u', portalPassword: 'p', gmailAddress: 'g@x.com' });
  assert.equal(await store.saveHistoryId('g@x.com', '777'), true);
  const acct = (await store.list()).find((a) => a.gmailAddress === 'g@x.com');
  assert.equal(acct.historyId, '777');
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

  // Add an account.
  res = await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { authorization: 'Bearer admintok', 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'a', portalBaseUrl: 'http://x', portalUsername: 'u', portalPassword: 'p' }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.live, 1, 'bot spawned on account add');

  // List shows it, password redacted.
  res = await fetch(`${base}/api/accounts`, { headers: { authorization: 'Bearer admintok' } });
  const listed = await res.json();
  assert.equal(listed.accounts.length, 1);
  assert.equal(listed.accounts[0].portalPassword, '***');

  // Deactivate -> bot torn down.
  res = await fetch(`${base}/api/accounts/${created.id}/activate`, {
    method: 'POST',
    headers: { authorization: 'Bearer admintok', 'content-type': 'application/json' },
    body: JSON.stringify({ active: false }),
  });
  assert.equal((await res.json()).live, 0);

  await new Promise((r) => server.close(r));
  await orch.shutdown();
});
