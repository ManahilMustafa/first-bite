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
 * @property {string} [forwardingEmail]       the user's mailbox orders arrive at;
 *                                            the attribution key for forwarded email
 * @property {string} [gmailAddress]
 * @property {string} [gmailRefreshToken]     (encrypted on disk; legacy per-account)
 * @property {string} [historyId]
 * @property {number} [pollIntervalMs]
 * @property {string[]} [regionZipPrefixes]   e.g. ["32","33","34"]
 * @property {string[]} [regionStates]        e.g. ["FL"] or ["TX"]
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

  /** Find the active account registered for a forwarding address (case-insensitive). */
  async findByForwardingEmail(email) {
    if (!email) return null;
    const needle = String(email).trim().toLowerCase();
    return (await this.list()).find((a) => a.active && a.forwardingEmail === needle) || null;
  }

  /**
   * Add or replace an account (secrets encrypted before write).
   * @throws if `forwardingEmail` is already registered to a DIFFERENT account —
   * a shared key would silently misattribute forwarded orders to the wrong user.
   */
  async upsert(account) {
    const raw = await this._readRaw();
    const id = account.id || randomUUID();
    // Normalize the attribution key so header matching (which lowercases) lines up.
    const normalized = { ...account };
    if (normalized.forwardingEmail) {
      normalized.forwardingEmail = String(normalized.forwardingEmail).trim().toLowerCase();
      const clash = raw.find((a) => a.id !== id && a.forwardingEmail === normalized.forwardingEmail);
      if (clash) {
        throw new Error(
          `forwardingEmail ${normalized.forwardingEmail} is already registered to account ${clash.id}`
        );
      }
    }
    const record = encryptFields(
      { active: true, pollIntervalMs: undefined, ...normalized, id },
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

  async remove(id) {
    const raw = await this._readRaw();
    const next = raw.filter((a) => a.id !== id);
    await this._writeRaw(next);
    return next.length !== raw.length;
  }
}

export default AccountsStore;
