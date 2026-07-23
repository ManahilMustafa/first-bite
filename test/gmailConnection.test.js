import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { GmailConnectionStore } from '../src/store/gmailConnection.js';

const KEY = Buffer.alloc(32, 7);

function newStore() {
  return new GmailConnectionStore({ path: join(tmpdir(), `gmail-${randomUUID()}.json`), key: KEY });
}

afterEach(() => {
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.GMAIL_ADDRESS;
});

test('get() returns null when neither a file nor env creds exist', async () => {
  assert.equal(await newStore().get(), null);
});

test('save() then get() round-trips, refreshToken encrypted at rest', async () => {
  const store = newStore();
  await store.save({ emailAddress: 'central@x.com', refreshToken: 'PLAINTEXT-RT', historyId: '5' });
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(store.path, 'utf8');
  assert.ok(!raw.includes('PLAINTEXT-RT'), 'refresh token not stored in plaintext');
  const conn = await store.get();
  assert.equal(conn.emailAddress, 'central@x.com');
  assert.equal(conn.refreshToken, 'PLAINTEXT-RT');
  await rm(store.path, { force: true });
});

test('get() bootstraps from env when no token is stored on disk', async () => {
  process.env.GMAIL_REFRESH_TOKEN = 'ENV-RT';
  process.env.GMAIL_ADDRESS = 'env-central@x.com';
  const conn = await newStore().get();
  assert.equal(conn.refreshToken, 'ENV-RT');
  assert.equal(conn.emailAddress, 'env-central@x.com');
});

test('a stored file token takes precedence over env', async () => {
  process.env.GMAIL_REFRESH_TOKEN = 'ENV-RT';
  const store = newStore();
  await store.save({ emailAddress: 'file@x.com', refreshToken: 'FILE-RT' });
  const conn = await store.get();
  assert.equal(conn.refreshToken, 'FILE-RT');
  await rm(store.path, { force: true });
});
