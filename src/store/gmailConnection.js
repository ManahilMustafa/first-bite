// Gmail connection store — the ONE central inbox all users forward into.
//
// In the old design every account carried its own Gmail OAuth token. Now there
// is a single operator-owned inbox: one refresh token, one users.watch(), one
// historyId cursor. This is a tiny encrypted singleton (separate from the
// per-user accounts store) holding that connection.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { encryptFields, decryptFields } from '../util/crypto.js';

const SECRET_FIELDS = ['refreshToken'];

/**
 * @typedef {object} GmailConnection
 * @property {string} emailAddress       the central inbox address (from users/me/profile)
 * @property {string} refreshToken       encrypted at rest
 * @property {string} [historyId]        cursor for history.list
 * @property {number} [watchExpiration]  ms epoch; renew the watch before this
 * @property {string} [updatedAt]
 */

export class GmailConnectionStore {
  constructor({ path = process.env.GMAIL_CONNECTION_STORE || './data/gmail.enc.json', key } = {}) {
    this.path = path;
    this.key = key; // resolved from env when undefined
  }

  /**
   * Read the connection with refreshToken DECRYPTED, or null if not connected.
   * Falls back to env (`GMAIL_REFRESH_TOKEN` / `GMAIL_ADDRESS`) when there's no
   * stored token — this lets a deployment connect WITHOUT the browser OAuth flow.
   * The history cursor still persists to the file.
   */
  async get() {
    let raw = {};
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8')) || {};
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (raw.refreshToken) {
      return decryptFields(raw, SECRET_FIELDS, this.key);
    }
    const envToken = process.env.GMAIL_REFRESH_TOKEN;
    if (envToken) {
      return {
        emailAddress: raw.emailAddress || process.env.GMAIL_ADDRESS,
        refreshToken: envToken,
        historyId: raw.historyId,
        watchExpiration: raw.watchExpiration,
      };
    }
    return null;
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

  /** Save/replace the connection (refreshToken encrypted before write). */
  async save(conn) {
    const merged = { ...(await this._readRaw()), ...conn };
    await this._writeRaw(encryptFields(merged, SECRET_FIELDS, this.key));
    return merged.emailAddress;
  }

  /** Advance the history cursor without touching the rest of the record. */
  async saveHistoryId(historyId) {
    const raw = await this._readRaw();
    raw.historyId = String(historyId);
    await this._writeRaw(raw);
  }

  async getHistoryId() {
    const raw = await this._readRaw();
    return raw.historyId ? String(raw.historyId) : null;
  }

  async saveWatch({ historyId, expiration } = {}) {
    const raw = await this._readRaw();
    if (historyId != null) raw.historyId = String(historyId);
    if (expiration != null) raw.watchExpiration = Number(expiration);
    await this._writeRaw(raw);
  }
}

export default GmailConnectionStore;
