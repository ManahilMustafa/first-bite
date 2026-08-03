// Keep-alive HTTP client with a cookie jar, built on node:http/node:https.
//
// Why not fetch(): we need (1) persistent keep-alive agents so the accept call
// reuses a warm TLS connection (no handshake in the hot path), (2) explicit
// control over redirect-following so we can DETECT a 302 -> /login bounce
// (the central "is the email link a standalone GET?" question), and
// (3) a cookie jar to hold the authenticated ASP.NET session per account.
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/** Minimal cookie jar: stores name=value per host, serializes on each request. */
export class CookieJar {
  constructor() {
    this.byHost = new Map(); // host -> Map(name -> value)
  }
  setFromHeaders(host, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const jar = this.byHost.get(host) ?? new Map();
    for (const raw of arr) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || /max-age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
    this.byHost.set(host, jar);
  }
  header(host) {
    const jar = this.byHost.get(host);
    if (!jar || jar.size === 0) return undefined;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear(host) {
    if (host) this.byHost.delete(host);
    else this.byHost.clear();
  }
  /** Plain-object snapshot of every cookie, for persisting across restarts. */
  export() {
    const out = {};
    for (const [host, jar] of this.byHost) out[host] = Object.fromEntries(jar);
    return out;
  }
  /** Restore cookies from a snapshot produced by export(). */
  import(snapshot) {
    for (const [host, cookies] of Object.entries(snapshot || {})) {
      this.byHost.set(host, new Map(Object.entries(cookies)));
    }
  }
}

export class HttpClient {
  /**
   * @param {object} opts
   * @param {CookieJar} [opts.jar]
   * @param {object}   [opts.defaultHeaders]
   * @param {number}   [opts.timeoutMs]
   */
  constructor({ jar = new CookieJar(), defaultHeaders = {}, timeoutMs = 10000 } = {}) {
    this.jar = jar;
    this.timeoutMs = timeoutMs;
    this.defaultHeaders = {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...defaultHeaders,
    };
    // Warm, reused connection pools — the key latency optimization.
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  }

  /**
   * Perform a single request WITHOUT following redirects.
   * Returns { status, headers, body, location, redirected:false, durationMs }.
   */
  request(urlStr, { method = 'GET', headers = {}, body, followRedirects = false, timeoutMs } = {}) {
    const startedAt = process.hrtime.bigint();
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = isHttps ? this.httpsAgent : this.httpAgent;
    const reqTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.timeoutMs;

    const cookieHeader = this.jar.header(u.host);
    const reqHeaders = { ...this.defaultHeaders, ...headers };
    if (cookieHeader) reqHeaders['cookie'] = cookieHeader;

    let payload;
    if (body != null) {
      payload = typeof body === 'string' ? body : Buffer.from(body);
      if (!reqHeaders['content-type']) {
        reqHeaders['content-type'] = 'application/x-www-form-urlencoded';
      }
      reqHeaders['content-length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: reqHeaders,
          agent,
        },
        (res) => {
          this.jar.setFromHeaders(u.host, res.headers['set-cookie']);
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', async () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const result = {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
              location: res.headers['location'],
              redirected: false,
              url: urlStr,
              durationMs,
            };
            // Optionally chase one redirect chain (kept explicit & shallow).
            // Browsers treat 301/302/303 after POST as GET to the Location
            // (ASP.NET Error.aspx / login redirects rely on this). Re-POSTing
            // the body to Error.aspx is wrong and masks the real outcome.
            if (
              followRedirects &&
              [301, 302, 303, 307, 308].includes(res.statusCode) &&
              result.location
            ) {
              try {
                const next = new URL(result.location, urlStr).toString();
                const forceGet =
                  method !== 'GET' &&
                  method !== 'HEAD' &&
                  (res.statusCode === 303 || res.statusCode === 302 || res.statusCode === 301);
                const nextMethod = forceGet ? 'GET' : method;
                const r2 = await this.request(next, {
                  method: nextMethod,
                  headers,
                  body: nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : body,
                  followRedirects,
                  timeoutMs: reqTimeoutMs,
                });
                return resolve({
                  ...r2,
                  redirected: true,
                  redirectedFrom: urlStr,
                  // Prefer total time across the hop when available.
                  durationMs: (result.durationMs || 0) + (r2.durationMs || 0),
                });
              } catch (e) {
                return reject(e);
              }
            }
            resolve(result);
          });
        }
      );
      req.setTimeout(reqTimeoutMs, () => req.destroy(new Error(`Request timeout: ${urlStr}`)));
      req.on('error', reject);
      if (payload != null) req.write(payload);
      req.end();
    });
  }

  get(url, opts) {
    return this.request(url, { ...opts, method: 'GET' });
  }
  post(url, body, opts) {
    return this.request(url, { ...opts, method: 'POST', body });
  }

  /** Pre-open a connection to a host so the first real request skips the handshake. */
  async warmup(urlStr) {
    try {
      await this.get(urlStr);
    } catch {
      /* warmup is best-effort */
    }
  }

  destroy() {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

export function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
    .join('&');
}

export default HttpClient;
