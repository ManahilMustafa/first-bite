// Session cookie store — persists each account's authenticated portal cookies
// to disk so a process restart can resume the session instead of logging in
// fresh. Mirrors what a browser does: close it, reopen it days later, and the
// site still recognizes you because the cookie survived — it's our in-memory
// CookieJar that doesn't, forcing a brand-new login (and OTP, for accounts
// that require it) on every restart. Encrypted at rest like any other
// credential-equivalent (see src/util/crypto.js).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encryptFields, decryptFields } from '../util/crypto.js';

const SECRET_FIELDS = ['cookiesJson'];

export class SessionCookieStore {
  constructor({ path = process.env.SESSION_COOKIE_STORE || './data/sessions.enc.json', key } = {}) {
    this.path = path;
    this.key = key; // resolved from env when undefined
  }

  async _readRaw() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw e;
    }
  }

  async _writeRaw(obj) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(obj, null, 2), 'utf8');
  }

  /** The saved CookieJar.export() snapshot for this account, or null. */
  async get(accountId) {
    const raw = await this._readRaw();
    const entry = raw[accountId];
    if (!entry) return null;
    const { cookiesJson } = decryptFields(entry, SECRET_FIELDS, this.key);
    return JSON.parse(cookiesJson);
  }

  /** Save/replace the cookie snapshot for this account. */
  async save(accountId, cookies) {
    const raw = await this._readRaw();
    raw[accountId] = encryptFields({ cookiesJson: JSON.stringify(cookies), savedAt: Date.now() }, SECRET_FIELDS, this.key);
    await this._writeRaw(raw);
  }

  async clear(accountId) {
    const raw = await this._readRaw();
    delete raw[accountId];
    await this._writeRaw(raw);
  }
}

export default SessionCookieStore;
