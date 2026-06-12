// Accounts store — the source of truth for "how many bots are live".
//
// One record per connected account. Secret fields (portalPassword,
// gmailRefreshToken) are encrypted at rest with AES-256-GCM. The orchestrator
// watches this store and brings workers up/down to match `active` records:
// add a row -> a bot appears; deactivate -> its bot is torn down.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptFields, decryptFields } from '../util/crypto.js';

const SECRET_FIELDS = ['portalPassword', 'gmailRefreshToken'];

/**
 * @typedef {object} Account
 * @property {string} id
 * @property {string} label
 * @property {boolean} active
 * @property {string} portalBaseUrl
 * @property {string} portalUsername
 * @property {string} portalPassword          (encrypted on disk)
 * @property {string} [gmailAddress]
 * @property {string} [gmailRefreshToken]     (encrypted on disk)
 * @property {string} [historyId]
 * @property {number} [pollIntervalMs]
 * @property {object} [portalRoutes]
 * @property {object} [portalFields]
 */

export class AccountsStore {
  constructor({ path = process.env.ACCOUNTS_STORE || './data/accounts.enc.json', key } = {}) {
    this.path = path;
    this.key = key; // crypto.resolveKey() resolves from env if undefined
  }

  async _readRaw() {
    try {
      const buf = await readFile(this.path, 'utf8');
      return JSON.parse(buf);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async _writeRaw(list) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(list, null, 2), 'utf8');
  }

  /** Return all accounts with secrets DECRYPTED (for in-memory worker use). */
  async list() {
    const raw = await this._readRaw();
    return raw.map((a) => decryptFields(a, SECRET_FIELDS, this.key));
  }

  async listActive() {
    return (await this.list()).filter((a) => a.active);
  }

  async get(id) {
    return (await this.list()).find((a) => a.id === id) || null;
  }

  /** Add or replace an account (secrets encrypted before write). */
  async upsert(account) {
    const raw = await this._readRaw();
    const id = account.id || randomUUID();
    const record = encryptFields(
      { active: true, pollIntervalMs: undefined, ...account, id },
      SECRET_FIELDS,
      this.key
    );
    const idx = raw.findIndex((a) => a.id === id);
    if (idx === -1) raw.push(record);
    else raw[idx] = { ...raw[idx], ...record };
    await this._writeRaw(raw);
    return id;
  }

  async setActive(id, active) {
    const raw = await this._readRaw();
    const idx = raw.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    raw[idx].active = active;
    await this._writeRaw(raw);
    return true;
  }

  /** Persist an advanced Gmail historyId cursor for an account (by gmail address). */
  async saveHistoryId(gmailAddress, historyId) {
    const raw = await this._readRaw();
    const idx = raw.findIndex((a) => a.gmailAddress === gmailAddress);
    if (idx === -1) return false;
    raw[idx].historyId = historyId;
    await this._writeRaw(raw);
    return true;
  }

  async remove(id) {
    const raw = await this._readRaw();
    const next = raw.filter((a) => a.id !== id);
    await this._writeRaw(next);
    return next.length !== raw.length;
  }
}

export default AccountsStore;
