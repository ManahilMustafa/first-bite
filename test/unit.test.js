import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLock } from '../src/lock/memoryLock.js';
import { encrypt, decrypt, encryptFields, decryptFields, resolveKey } from '../src/util/crypto.js';
import { CookieJar } from '../src/util/httpClient.js';
import {
  scrapeHiddenFields,
  buildPostback,
  buildControlClick,
  findPostbackTarget,
  looksLikeLogin,
  looksLikeStaleState,
  scrapeFormAction,
  scrapeFormActionForControl,
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

// ── cookie jar ──────────────────────────────────────────────────────────────--
test('CookieJar export/import round-trips cookies across a fresh jar', () => {
  const jar = new CookieJar();
  jar.setFromHeaders('portal.example.com', ['ASP.NET_SessionId=abc123; path=/; HttpOnly', 'lang=en; path=/']);
  const snapshot = jar.export();

  const restored = new CookieJar();
  restored.import(snapshot);
  assert.equal(restored.header('portal.example.com'), jar.header('portal.example.com'));
});

test('CookieJar import merges into (not replaces) an existing jar\'s other hosts', () => {
  const jar = new CookieJar();
  jar.setFromHeaders('other.example.com', ['x=1; path=/']);
  jar.import({ 'portal.example.com': { 'ASP.NET_SessionId': 'abc123' } });
  assert.equal(jar.header('other.example.com'), 'x=1');
  assert.equal(jar.header('portal.example.com'), 'ASP.NET_SessionId=abc123');
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

test('finds ASP.NET type=image Accept tick (real E-Street BroadcastAccept)', () => {
  const html = `<form>
    <td>267-25786</td>
    <input type="image" name="ctl00$cphBody$grdNewOrders$ctl02$imgBtnBroadcastAccept"
           title="Click here to accept this order" src="../images/appraiser-tick.png" />
    <input type="image" name="ctl00$cphBody$grdNewOrders$ctl02$imgBtnDecline"
           title="Click here to decline this order" src="../images/appraiser-block.png" />
  </form>`;
  const accept = findPostbackTarget(html, /accept/i);
  assert.equal(accept.isImage, true);
  assert.match(accept.target, /imgBtnBroadcastAccept/);
  const decline = findPostbackTarget(html, /decline/i);
  assert.equal(decline.isImage, true);
  assert.match(decline.target, /imgBtnDecline/);
});

test('buildControlClick posts name.x/name.y for image buttons', () => {
  const html = `<form>
    <input type="hidden" name="__VIEWSTATE" value="VS1" />
    <input type="hidden" name="__EVENTVALIDATION" value="EV1" />
    <input type="image" name="ctl00$cphBody$imgBtnBroadcastAccept" title="accept" />
  </form>`;
  const pb = findPostbackTarget(html, /accept/i);
  const body = buildControlClick(html, pb);
  assert.equal(body['ctl00$cphBody$imgBtnBroadcastAccept.x'], '1');
  assert.equal(body['ctl00$cphBody$imgBtnBroadcastAccept.y'], '1');
  assert.equal(body.__EVENTTARGET, '');
});

test('buildPostback assembles state + event fields', () => {
  const body = buildPostback(PAGE, 'ctl00$gv$btnAccept', '266-03335');
  assert.equal(body.__EVENTTARGET, 'ctl00$gv$btnAccept');
  assert.equal(body.__EVENTARGUMENT, '266-03335');
  assert.equal(body.__VIEWSTATE, 'VS&1');
});

test('scrapeFormAction decodes &amp; in action (real AcceptBroadcastAppraisal)', () => {
  const html = `<form method="post" action="./AcceptBroadcastAppraisal.aspx?ApprID=252821&amp;Accept=asis">
    <input type="submit" name="ctl00$cphBody$btnSubmit" value="Accept Appraisal" />
  </form>`;
  const base = 'https://estreetamc.spurams.com/AcceptBroadcastAppraisal.aspx?ApprID=252821&Accept=asis';
  const url = scrapeFormAction(html, base);
  assert.equal(
    url,
    'https://estreetamc.spurams.com/AcceptBroadcastAppraisal.aspx?ApprID=252821&Accept=asis'
  );
  assert.doesNotMatch(url, /&amp;/);
  const byControl = scrapeFormActionForControl(html, base, 'ctl00$cphBody$btnSubmit');
  assert.equal(byControl, url);
});

test('looksLikeLogin detects a login page', () => {
  const login = `<form><input type="password" name="pw"/><span>Sign in</span></form>`;
  assert.equal(looksLikeLogin(login), true);
  assert.equal(looksLikeLogin('<div>New Orders</div>'), false);
});

test('looksLikeStaleState detects a rejected/stale postback distinct from a login bounce', () => {
  assert.equal(looksLikeStaleState('<div>Your session has expired. Please refresh.</div>'), true);
  assert.equal(looksLikeStaleState('<div>The __VIEWSTATE is invalid.</div>'), true);
  assert.equal(looksLikeStaleState('<div>Order accepted. Thank you.</div>'), false);
  // A login bounce is a DIFFERENT signal — not a stale-state rejection.
  assert.equal(looksLikeStaleState('<form><input type="password"/>Sign in</form>'), false);
});
