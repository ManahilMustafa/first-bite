// Authenticated portal session for ONE E-Street/ValueLink account.
//
// Holds a warm keep-alive HttpClient + cookie jar, performs the WebForms login
// (scrape hidden fields -> POST credentials), and re-authenticates transparently
// when a request bounces to the login page. Kept warm so the accept postback
// never pays a login round-trip in the hot path.
import { HttpClient } from '../util/httpClient.js';
import { scrapeHiddenFields, looksLikeLogin } from './aspnet.js';
import { logger } from '../util/logger.js';

/**
 * @typedef {object} PortalRoutes
 * @property {string} login      e.g. '/Account/Login.aspx'
 * @property {string} newOrders  e.g. '/Orders/NewOrders.aspx'
 * @property {(orderId:string)=>string} [status] order-status URL builder
 */

const DEFAULT_ROUTES = {
  login: '/Account/Login.aspx',
  newOrders: '/Orders/NewOrders.aspx',
  status: (orderId) => `/Orders/OrderStatus.aspx?order=${encodeURIComponent(orderId)}`,
};

// Login form field names differ per deployment; override via account.portalFields.
const DEFAULT_FIELDS = {
  username: 'ctl00$MainContent$txtUsername',
  password: 'ctl00$MainContent$txtPassword',
  submit: 'ctl00$MainContent$btnLogin',
  submitValue: 'Log In',
};

export class PortalSession {
  /**
   * @param {object} cfg
   * @param {string} cfg.baseUrl
   * @param {string} cfg.username
   * @param {string} cfg.password
   * @param {Partial<PortalRoutes>} [cfg.routes]
   * @param {object} [cfg.fields]
   * @param {string} [cfg.label]
   */
  constructor(cfg) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.username = cfg.username;
    this.password = cfg.password;
    this.routes = { ...DEFAULT_ROUTES, ...(cfg.routes || {}) };
    this.fields = { ...DEFAULT_FIELDS, ...(cfg.fields || {}) };
    this.http = new HttpClient({ timeoutMs: cfg.timeoutMs ?? 10000 });
    this.log = (cfg.logger || logger)(`session:${cfg.label || this.username}`);
    this.authenticated = false;
    this._loginInFlight = null;
  }

  url(path) {
    return path.startsWith('http') ? path : this.baseUrl + path;
  }

  /** Warm the TLS connection ahead of time. */
  async warmup() {
    await this.http.warmup(this.url('/'));
  }

  /** Log in (idempotent / de-duplicated if called concurrently). */
  async login() {
    if (this._loginInFlight) return this._loginInFlight;
    this._loginInFlight = this._doLogin().finally(() => {
      this._loginInFlight = null;
    });
    return this._loginInFlight;
  }

  async _doLogin() {
    const loginUrl = this.url(this.routes.login);
    const page = await this.http.get(loginUrl, { followRedirects: true });
    const hidden = scrapeHiddenFields(page.body);
    const body = {
      ...hidden,
      [this.fields.username]: this.username,
      [this.fields.password]: this.password,
    };
    if (this.fields.submit) body[this.fields.submit] = this.fields.submitValue;

    const res = await this.http.post(loginUrl, formEncodeObj(body), {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      followRedirects: true,
    });

    // Success = we landed somewhere that is NOT the login page.
    const ok = !looksLikeLogin(res.body) && res.status < 400;
    this.authenticated = ok;
    if (!ok) {
      this.log.error('login failed', { status: res.status });
      throw new Error(`Portal login failed for ${this.username} (status ${res.status})`);
    }
    this.log.info('login ok', { ms: Math.round(res.durationMs) });
    return res;
  }

  /**
   * GET a page, auto-re-login once if we got bounced to the login screen.
   * Returns the raw HttpClient response.
   */
  async authedGet(path, { retried = false } = {}) {
    if (!this.authenticated) await this.login();
    const res = await this.http.get(this.url(path), { followRedirects: true });
    if (this._isBounced(res) && !retried) {
      this.log.warn('session expired, re-authenticating');
      this.authenticated = false;
      await this.login();
      return this.authedGet(path, { retried: true });
    }
    return res;
  }

  /** POST a form to an authed page, re-login once on bounce. */
  async authedPost(path, body, { retried = false, headers } = {}) {
    if (!this.authenticated) await this.login();
    const res = await this.http.post(this.url(path), formEncodeObj(body), {
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      followRedirects: true,
    });
    if (this._isBounced(res) && !retried) {
      this.authenticated = false;
      await this.login();
      return this.authedPost(path, body, { retried: true, headers });
    }
    return res;
  }

  _isBounced(res) {
    return looksLikeLogin(res.body) || /login/i.test(res.headers?.location || '');
  }

  close() {
    this.http.destroy();
  }
}

function formEncodeObj(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
    .join('&');
}

export default PortalSession;
