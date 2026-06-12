import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLock } from '../src/lock/memoryLock.js';
import { encrypt, decrypt, encryptFields, decryptFields, resolveKey } from '../src/util/crypto.js';
import {
  scrapeHiddenFields,
  buildPostback,
  findPostbackTarget,
  looksLikeLogin,
} from '../src/portal/aspnet.js';

const KEY = resolveKey(Buffer.alloc(32, 7).toString('base64'));

// ── crypto ──────────────────────────────────────────────────────────────────
test('crypto round-trips and ciphertext is not plaintext', () => {
  const ct = encrypt('hunter2', KEY);
  assert.notEqual(ct, 'hunter2');
  assert.equal(decrypt(ct, KEY), 'hunter2');
});

test('crypto fails closed on tampering', () => {
  const ct = encrypt('secret', KEY);
  const parts = ct.split('.');
  const tampered = [parts[0], parts[1], Buffer.from('zzzz').toString('base64')].join('.');
  assert.throws(() => decrypt(tampered, KEY));
});

test('encryptFields/decryptFields handle selected fields', () => {
  const obj = { user: 'a', portalPassword: 'p', gmailRefreshToken: 't', keep: 1 };
  const enc = encryptFields(obj, ['portalPassword', 'gmailRefreshToken'], KEY);
  assert.notEqual(enc.portalPassword, 'p');
  assert.equal(enc.user, 'a');
  const dec = decryptFields(enc, ['portalPassword', 'gmailRefreshToken'], KEY);
  assert.equal(dec.portalPassword, 'p');
  assert.equal(dec.gmailRefreshToken, 't');
});

// ── lock ──────────────────────────────────────────────────────────────────────
test('memory lock grants exactly one winner concurrently', async () => {
  const lock = new MemoryLock();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => lock.acquire('order:X'))
  );
  assert.equal(results.filter(Boolean).length, 1);
});

test('memory lock releases and re-acquires', async () => {
  const lock = new MemoryLock();
  assert.equal(await lock.acquire('k'), true);
  assert.equal(await lock.acquire('k'), false);
  await lock.release('k');
  assert.equal(await lock.acquire('k'), true);
});

test('memory lock TTL expiry frees the key', async () => {
  const lock = new MemoryLock();
  assert.equal(await lock.acquire('k', 10), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await lock.acquire('k', 1000), true);
});

// ── aspnet helpers ────────────────────────────────────────────────────────────
const PAGE = `<form>
  <input type="hidden" name="__VIEWSTATE" value="VS&amp;1" />
  <input type="hidden" name="__EVENTVALIDATION" value="EV1" />
  <input type="hidden" name="__EVENTTARGET" value="" />
  <tr><td>Order no. 266-03335</td>
  <a href="javascript:__doPostBack('ctl00$gv$btnAccept','266-03335')">Accept</a></tr>
</form>`;

test('scrapes hidden fields and decodes entities', () => {
  const f = scrapeHiddenFields(PAGE);
  assert.equal(f.__VIEWSTATE, 'VS&1');
  assert.equal(f.__EVENTVALIDATION, 'EV1');
});

test('finds the accept __doPostBack target', () => {
  const pb = findPostbackTarget(PAGE, /accept/i);
  assert.equal(pb.target, 'ctl00$gv$btnAccept');
  assert.equal(pb.argument, '266-03335');
});

test('buildPostback assembles state + event fields', () => {
  const body = buildPostback(PAGE, 'ctl00$gv$btnAccept', '266-03335');
  assert.equal(body.__EVENTTARGET, 'ctl00$gv$btnAccept');
  assert.equal(body.__EVENTARGUMENT, '266-03335');
  assert.equal(body.__VIEWSTATE, 'VS&1');
});

test('looksLikeLogin detects a login page', () => {
  const login = `<form><input type="password" name="pw"/><span>Sign in</span></form>`;
  assert.equal(looksLikeLogin(login), true);
  assert.equal(looksLikeLogin('<div>New Orders</div>'), false);
});
