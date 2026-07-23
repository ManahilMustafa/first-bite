import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SessionCookieStore } from '../src/store/sessionCookieStore.js';

const KEY = Buffer.alloc(32, 5).toString('base64');

let storePath;
beforeEach(() => {
  storePath = join(tmpdir(), `sessions-${randomUUID()}.json`);
});
afterEach(async () => {
  await rm(storePath, { force: true });
});

function newStore() {
  return new SessionCookieStore({ path: storePath, key: Buffer.from(KEY, 'base64') });
}

test('save/get round-trips a cookie snapshot', async () => {
  const store = newStore();
  const snapshot = { 'portal.example.com': { 'ASP.NET_SessionId': 'abc123' } };
  await store.save('acct-1', snapshot);
  assert.deepEqual(await store.get('acct-1'), snapshot);
});

test('get returns null when nothing is saved for that account', async () => {
  const store = newStore();
  assert.equal(await store.get('never-saved'), null);
});

test('cookies are encrypted at rest, not stored as plaintext', async () => {
  const store = newStore();
  await store.save('acct-1', { 'portal.example.com': { 'ASP.NET_SessionId': 'super-secret-sid' } });
  const onDisk = await readFile(storePath, 'utf8');
  assert.doesNotMatch(onDisk, /super-secret-sid/);
});

test('save overwrites a prior snapshot for the same account without disturbing others', async () => {
  const store = newStore();
  await store.save('acct-1', { h: { a: '1' } });
  await store.save('acct-2', { h: { a: '2' } });
  await store.save('acct-1', { h: { a: '1-updated' } });
  assert.deepEqual(await store.get('acct-1'), { h: { a: '1-updated' } });
  assert.deepEqual(await store.get('acct-2'), { h: { a: '2' } });
});

test('clear removes the saved snapshot', async () => {
  const store = newStore();
  await store.save('acct-1', { h: { a: '1' } });
  await store.clear('acct-1');
  assert.equal(await store.get('acct-1'), null);
});
