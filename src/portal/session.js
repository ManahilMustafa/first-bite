// Authenticated portal session for ONE E-Street/ValueLink account.
//
// Holds a warm keep-alive HttpClient + cookie jar, performs the WebForms login
// (scrape hidden fields -> POST credentials), and re-authenticates transparently
// when a request bounces to the login page. Kept warm so the accept postback
// never pays a login round-trip in the hot path.
import { HttpClient } from '../util/httpClient.js';
import { scrapeHiddenFields, looksLikeLogin, looksLikeOtpPage } from './aspnet.js';
import { logger } from '../util/logger.js';

/**
 * @typedef {object} PortalRoutes
 * @property {string} login      e.g. '/login.aspx'
 * @property {string} newOrders  e.g. '/AppraiserDashboard.aspx'
 * @property {(orderId:string)=>string} [status] order-status URL builder
 */

// Every vendor account is the same E-Street/ValueLink deployment (confirmed
// against the real portal) — only the credentials differ per account. These
// are overridable per-account (portalRoutes/portalFields) for the rare
// AMC that white-labels a differently-structured instance.
const DEFAULT_ROUTES = {
  login: '/login.aspx',
  newOrders: '/AppraiserDashboard.aspx',
  status: (orderId) => `/Orders/OrderStatus.aspx?order=${encodeURIComponent(orderId)}`,
};

const DEFAULT_FIELDS = {
  username: 'ctl00$cphBody$Login1$UserName',
  password: 'ctl00$cphBody$Login1$Password',
  submit: 'ctl00$cphBody$Login1$LoginButton',
  submitValue: 'Log In',
};

// Every account requires a 6-digit email-OTP step on login (no "remember this
// device"). Reactive: PortalSession only submits this if the post-login page
// actually looks like an OTP challenge, so it's harmless for any account that
// doesn't hit one. Override/disable via account.otpFields (pass null to skip
// entirely).
const DEFAULT_OTP_FIELDS = {
  code: 'ctl00$cphBody$txtUserCode',
  submit: 'ctl00$cphBody$btnVerifyLogin',
  submitValue: 'Verify',
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
   * @param {object|null} [cfg.otpFields]  { code, submit, submitValue } — override the
   *        default email-OTP fields, or pass null to disable the OTP step entirely.
   * @param {(args:{sentAfter:number})=>Promise<string|null>} [cfg.fetchOtpCode]
   *        resolves the emailed code; only invoked if an OTP page is actually hit.
   * @param {object} [cfg.cookieStore]  a SessionCookieStore — if given (with
   *        cfg.accountId), a saved session cookie is tried once before falling
   *        back to a fresh username/password (+OTP) login. See resumeSession().
   * @param {string} [cfg.accountId]
   */
  constructor(cfg) {
    // Accept either origin (`https://host`) or a pasted dashboard URL
    // (`https://host/AppraiserDashboard.aspx`). Routes are absolute-from-origin
    // (`/login.aspx`, `/AppraiserDashboard.aspx`), so a base that already
    // includes a page path produces broken URLs like
    // `…/AppraiserDashboard.aspx/login.aspx` and login silently fails.
    this.baseUrl = normalizePortalOrigin(cfg.baseUrl);
    this.username = cfg.username;
    this.password = cfg.password;
    this.routes = { ...DEFAULT_ROUTES, ...(cfg.routes || {}) };
    this.fields = { ...DEFAULT_FIELDS, ...(cfg.fields || {}) };
    this.otpFields = cfg.otpFields === null ? null : { ...DEFAULT_OTP_FIELDS, ...(cfg.otpFields || {}) };
    this.fetchOtpCode = cfg.fetchOtpCode || null;
    this.http = new HttpClient({ timeoutMs: cfg.timeoutMs ?? 10000 });
    this.log = (cfg.logger || logger)(`session:${cfg.label || this.username}`);
    this.authenticated = false;
    this._loginInFlight = null;
    this.cookieStore = cfg.cookieStore || null;
    this.accountId = cfg.accountId || null;
    this._resumeAttempted = false;
    // Last successful (non-bounced) response per path — lets a caller that
    // opts in (see acceptViaPortal/declineViaPortal's `reuseCachedPage`) skip a
    // fresh GET and replay a *very* recently seen page's VIEWSTATE directly.
    // Never used unless a caller explicitly asks for it and checks freshness.
    this._pageCache = new Map(); // path -> { body, status, ts }
  }

  /** A recent successful GET response for `path`, if not older than `maxAgeMs`. */
  getCachedPage(path, maxAgeMs) {
    const c = this._pageCache.get(path);
    if (!c || Date.now() - c.ts > maxAgeMs) return null;
    return c;
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
    this._loginInFlight = this._login().finally(() => {
      this._loginInFlight = null;
    });
    return this._loginInFlight;
  }

  async _login() {
    // Try a saved cookie exactly once per process lifetime — same as a browser
    // that was closed and reopened, not something worth re-checking on every
    // re-auth-after-bounce (that cookie just proved itself invalid).
    if (!this._resumeAttempted && this.cookieStore && this.accountId) {
      this._resumeAttempted = true;
      if (await this._resumeSession()) return;
    }
    return this._doLogin();
  }

  /**
   * Try reusing a previously-saved session cookie instead of a fresh
   * username/password (+OTP) login — the reason a closed-and-reopened browser
   * doesn't get asked for credentials again is that the cookie the portal
   * already trusts is still sitting in its cookie storage; our in-memory
   * CookieJar just doesn't survive a process restart on its own. Falls back to
   * a normal login if there's no saved cookie or the portal no longer honors it.
   * @returns {Promise<boolean>} true if the saved cookie was still valid
   */
  async _resumeSession() {
    const saved = await this.cookieStore.get(this.accountId);
    if (!saved) return false;
    this.http.jar.import(saved);
    const res = await this.http.get(this.url(this.routes.newOrders), { followRedirects: true });
    if (looksLikeLogin(res.body) || res.status >= 400) {
      this.http.jar.clear();
      this.log.info('saved session cookie is no longer valid, logging in fresh');
      return false;
    }
    this.authenticated = true;
    this.log.info('resumed session from a saved cookie — no login/OTP needed');
    return true;
  }

  async _doLogin() {
    this._lastLoginUsedOtp = false; // reset per attempt; set by _submitOtp below
    // Fresh login must not carry cookies from a failed resume — a half-dead
    // ASP.NET_SessionId can make a correct password look like a failed attempt.
    this.http.jar.clear();
    const loginUrl = this.url(this.routes.login);
    const page = await this.http.get(loginUrl, { followRedirects: true });
    // Post back to the URL we actually landed on (after redirects), not the
    // pre-redirect loginUrl — ViewState is bound to that page.
    const postUrl = page.url || loginUrl;
    const hidden = scrapeHiddenFields(page.body);
    // Match the real Login button's DoPostBackWithOptions(clientSubmit=false):
    // a normal browser form submit with the submit control's name=value only.
    // Do NOT set __EVENTTARGET to the LoginButton — that path is for LinkButtons
    // / __doPostBack, and on this portal it makes a correct password look like
    // "Your login attempt was not successful" (no OTP page ever appears).
    const body = {
      ...hidden,
      [this.fields.username]: this.username,
      [this.fields.password]: this.password,
    };
    if (this.fields.submit) {
      body[this.fields.submit] = this.fields.submitValue;
    }

    const attemptedAt = Date.now();
    let res = await this.http.post(postUrl, formEncodeObj(body), {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: postUrl,
      },
      followRedirects: true,
    });

    if (looksLikeOtpPage(res.body)) {
      res = await this._submitOtp(postUrl, res.body, attemptedAt);
    }

    // Success = we landed somewhere that is NOT the login page.
    const ok = !looksLikeLogin(res.body) && res.status < 400;
    this.authenticated = ok;
    if (!ok) {
      const portalMsg = extractLoginError(res.body);
      this.log.error('login failed', {
        status: res.status,
        portalMsg: portalMsg || undefined,
        looksOtp: looksLikeOtpPage(res.body),
        bodySnippet: snippet(res.body),
      });
      // Persist the full response so a field-name / OTP / captcha miss is
      // diagnosable without re-running against a live account.
      try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile('/root/Estreet/data/login-fail.html', res.body || '', 'utf8');
      } catch {
        /* best-effort */
      }
      const detail = portalMsg || snippet(res.body);
      throw new Error(`Portal login failed for ${this.username} (status ${res.status}): ${detail}`);
    }
    this.log.info('login ok', { ms: Math.round(res.durationMs) });
    if (this.cookieStore && this.accountId) {
      try {
        await this.cookieStore.save(this.accountId, this.http.jar.export());
      } catch (e) {
        this.log.warn('failed to persist session cookie', { err: String(e) });
      }
    }
    return res;
  }

  /** Complete the email-OTP challenge that follows a correct username/password. */
  async _submitOtp(loginUrl, otpPageHtml, attemptedAt) {
    if (!this.otpFields || !this.fetchOtpCode) {
      throw new Error(
        `Portal login for ${this.username} hit a 2FA/verification-code page but no otpFields/fetchOtpCode is configured`
      );
    }
    this.log.info('otp challenge — waiting for emailed code');
    const code = await this.fetchOtpCode({ sentAfter: attemptedAt });
    if (!code) {
      this.log.error('otp fetch failed: no code arrived in time', { sentAfter: attemptedAt });
      throw new Error(`Portal login for ${this.username}: no OTP code arrived in time`);
    }
    this.log.info('otp fetched', { sentAfter: attemptedAt });
    this._lastLoginUsedOtp = true;

    const hidden = scrapeHiddenFields(otpPageHtml);
    const body = { ...hidden, [this.otpFields.code]: code };
    if (this.otpFields.submit) body[this.otpFields.submit] = this.otpFields.submitValue;

    return this.http.post(loginUrl, formEncodeObj(body), {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      followRedirects: true,
    });
  }

  /**
   * GET a page, auto-re-login once if we got bounced to the login screen, and
   * retry once on a bare request timeout (the portal is occasionally slow to
   * respond; a single retry is cheap relative to losing the order entirely).
   * Returns the raw HttpClient response.
   */
  async authedGet(path, { retried = false, retriedTimeout = false } = {}) {
    if (!this.authenticated) await this.login();
    let res;
    try {
      res = await this.http.get(this.url(path), { followRedirects: true });
    } catch (e) {
      if (!retriedTimeout && /timeout/i.test(String(e?.message))) {
        this.log.warn('request timed out, retrying once', { path });
        const r = await this.authedGet(path, { retried, retriedTimeout: true });
        return { ...r, _reauthed: true };
      }
      throw e;
    }
    if (this._isBounced(res) && !retried) {
      this.log.warn('login required', { path });
      this.log.info('re-authenticating');
      this.authenticated = false;
      await this.login();
      this.log.info('login successful — retrying request', { path });
      const r = await this.authedGet(path, { retried: true, retriedTimeout });
      return { ...r, _reauthed: true, _otpFetched: this._lastLoginUsedOtp };
    }
    this._pageCache.set(path, { body: res.body, status: res.status, ts: Date.now() });
    return res;
  }

  /** POST a form to an authed page, re-login once on bounce (retries the EXACT
   *  same body — the caller is responsible for scraping fresh VIEWSTATE via a
   *  prior authedGet, so a bounce here means the session died between that GET
   *  and this POST, not that the tokens are stale). */
  async authedPost(path, body, { retried = false, headers } = {}) {
    if (!this.authenticated) await this.login();
    const res = await this.http.post(this.url(path), formEncodeObj(body), {
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      followRedirects: true,
    });
    if (this._isBounced(res) && !retried) {
      this.log.warn('login required', { path });
      this.log.info('re-authenticating');
      this.authenticated = false;
      await this.login();
      this.log.info('login successful — retrying request', { path });
      const r = await this.authedPost(path, body, { retried: true, headers });
      return { ...r, _reauthed: true, _otpFetched: this._lastLoginUsedOtp };
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
  // URLSearchParams matches browser form encoding (space -> +, @ -> %40, etc.)
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) params.append(k, v ?? '');
  return params.toString();
}

/** First ~300 chars of a response body, for debug logs — never log the whole page. */
function snippet(body, max = 300) {
  if (!body) return '';
  const s = String(body).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Collapse a pasted portal URL down to its origin. Operators often paste the
 * dashboard address (`https://host/AppraiserDashboard.aspx`); routes already
 * include those paths, so keeping the page segment breaks login/newOrders.
 */
export function normalizePortalOrigin(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.origin;
  } catch {
    return raw.replace(/\/$/, '');
  }
}

/** Pull the visible ASP.NET Login failure text out of a login-page response. */
function extractLoginError(html) {
  if (!html) return null;
  const patterns = [
    /Your login attempt was not successful[^.<]*/i,
    /Invalid (?:credentials|user name or password)[^.<]*/i,
    /account (?:has been )?locked[^.<]*/i,
    /too many (?:failed )?login attempts[^.<]*/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  return null;
}

export default PortalSession;
export { snippet };
