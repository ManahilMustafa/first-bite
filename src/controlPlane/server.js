// Control plane — the internal portal. Zero-dependency node:http server.
//
// Endpoints (all admin endpoints require Authorization: Bearer <CONTROL_PLANE_TOKEN>):
//   GET  /health                      -> liveness
//   GET  /api/accounts                -> list (secrets redacted) + live status
//   POST /api/accounts                -> add/update an account, then orchestrator.sync()
//   POST /api/accounts/:id/activate   -> { active:boolean }, then sync()
//   POST /api/accounts/:id/resume-poller -> clear portal circuit breaker, resume polls
//   DELETE /api/accounts/:id          -> remove, then sync()
//   POST /webhooks/gmail              -> Pub/Sub push (verification token in query)
//   GET  /api/accounts/:id/gmail/auth-url -> OAuth consent URL for this account
//   GET  /oauth/google/callback           -> exchange code -> store refresh token + watch
//
// "More creds = more bots": every account mutation triggers orchestrator.sync()
// in the background (not awaited — see syncInBackground) to bring the worker
// fleet in line with the active accounts, without blocking the HTTP response
// on a real portal login.
import http from 'node:http';
import { URL } from 'node:url';
import { logger } from '../util/logger.js';
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
  encodeOAuthState,
} from '../gmail/oauth.js';
import { connectCentralGmail } from '../gmail/connect.js';
import { buildLatencyReport } from '../util/latencyReport.js';

const log = logger('control-plane');

export function createControlPlane({ store, orchestrator, gmailWatcher, connectionStore, eventsStore, config = {} }) {
  const adminToken = config.adminToken || process.env.CONTROL_PLANE_TOKEN;
  const pubsubToken = config.pubsubToken || process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN;
  const oauthClientId = config.oauthClientId || process.env.GOOGLE_OAUTH_CLIENT_ID;
  const oauthClientSecret = config.oauthClientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const oauthRedirectUri =
    config.oauthRedirectUri ||
    process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    'http://localhost:8787/oauth/google/callback';
  const pubsubTopic = config.pubsubTopic || process.env.GMAIL_PUBSUB_TOPIC;

  // store.upsert/setActive/remove are fast local-disk writes; orchestrator.sync()
  // is not — starting a worker logs into the real portal and can block for tens
  // of seconds (longer for an OTP-gated account waiting on an emailed code). Await
  // it here and every account mutation from the dashboard hangs past its request
  // timeout even though the mutation itself already succeeded — which is exactly
  // what drove admins to "retry" a create that had, in fact, gone through, filing
  // the same account twice. Fire it in the background instead; `GET /api/accounts`
  // reports the live worker set whenever it actually changes.
  function syncInBackground() {
    orchestrator.sync().catch((e) => log.error('background sync failed', { err: String(e) }));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const path = u.pathname;
      const method = req.method;

      if (method === 'GET' && path === '/health') {
        return json(res, 200, { ok: true, live: orchestrator.status().length });
      }

      // ── Gmail Pub/Sub push (auth via verification token in the query) ────────
      if (method === 'POST' && path === '/webhooks/gmail') {
        if (pubsubToken && u.searchParams.get('token') !== pubsubToken) {
          return json(res, 401, { error: 'bad pubsub token' });
        }
        // ALWAYS ack 2xx — a non-2xx makes Pub/Sub retry forever, so a malformed
        // body must not bubble to the outer 4xx/5xx handler. Parse defensively.
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          log.warn('invalid gmail push body', { err: String(e) });
          return json(res, 204, null);
        }
        json(res, 204, null); // ack fast, process async
        if (gmailWatcher) {
          gmailWatcher.handlePush(body).catch((e) => log.warn('gmail push error', { err: String(e) }));
        }
        return;
      }

      // ── OAuth callback (Google redirects here after operator consent) ─────────
      // Connects the ONE central inbox all users forward into.
      if (method === 'GET' && path === '/oauth/google/callback') {
        const err = u.searchParams.get('error');
        if (err) return html(res, 400, oauthResultPage(false, `Google OAuth denied: ${err}`));
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        if (!code || !state) return html(res, 400, oauthResultPage(false, 'Missing code or state'));
        try {
          if (!oauthClientId || !oauthClientSecret) {
            throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured');
          }
          if (!connectionStore) throw new Error('Gmail connection store not configured');
          const tokens = await exchangeCodeForTokens({
            clientId: oauthClientId,
            clientSecret: oauthClientSecret,
            code,
            redirectUri: oauthRedirectUri,
          });
          if (!tokens.refresh_token) {
            throw new Error('No refresh_token returned — revoke app access in Google Account and retry');
          }
          const connected = await connectCentralGmail({
            connectionStore,
            gmailWatcher,
            refreshToken: tokens.refresh_token,
            topicName: pubsubTopic,
          });
          return html(
            res,
            200,
            oauthResultPage(true, `Central inbox connected: ${connected.emailAddress}. You can close this tab.`)
          );
        } catch (e) {
          log.error('oauth callback failed', { err: String(e) });
          return html(res, 500, oauthResultPage(false, String(e.message || e)));
        }
      }

      // ── Everything below requires the admin token ───────────────────────────
      if (!authorized(req, adminToken)) return json(res, 401, { error: 'unauthorized' });

      if (method === 'GET' && path === '/api/accounts') {
        const accounts = await store.list();
        const status = orchestrator.status();
        return json(res, 200, {
          accounts: accounts.map(redact),
          live: status,
        });
      }

      if (method === 'POST' && path === '/api/accounts') {
        const body = await readJson(req);
        let payload = { ...body };
        if (payload.id) {
          // Update existing account — password optional (omit / blank = keep current).
          const existing = await store.get(payload.id);
          if (!existing) return json(res, 404, { error: 'account not found' });
          if (!payload.portalPassword) {
            delete payload.portalPassword;
            payload = {
              ...existing,
              ...payload,
              portalPassword: existing.portalPassword,
            };
          } else {
            payload = { ...existing, ...payload };
          }
        } else if (!payload.portalBaseUrl || !payload.portalUsername || !payload.portalPassword) {
          return json(res, 400, { error: 'portalBaseUrl, portalUsername, portalPassword required' });
        }
        // Operators often paste the dashboard URL; routes already include the path.
        if (payload.portalBaseUrl) {
          try {
            payload.portalBaseUrl = new URL(payload.portalBaseUrl).origin;
          } catch {
            /* leave as-is; store will persist whatever they sent */
          }
        }
        let id;
        try {
          id = await store.upsert(payload);
        } catch (e) {
          // Duplicate portalUsername+portalBaseUrl (same real login registered
          // twice) — 409 Conflict.
          if (/already registered/i.test(String(e.message))) {
            return json(res, 409, { error: String(e.message) });
          }
          throw e;
        }
        syncInBackground();
        return json(res, payload.id ? 200 : 201, { id, live: orchestrator.status().length });
      }

      let m;
      if (method === 'POST' && (m = path.match(/^\/api\/accounts\/([^/]+)\/activate$/))) {
        const body = await readJson(req);
        const ok = await store.setActive(m[1], body.active !== false);
        syncInBackground();
        return json(res, ok ? 200 : 404, { ok, live: orchestrator.status().length });
      }

      if (method === 'POST' && (m = path.match(/^\/api\/accounts\/([^/]+)\/resume-poller$/))) {
        const ok = orchestrator.resumePoller(m[1]);
        return json(res, ok ? 200 : 404, {
          ok,
          live: orchestrator.status(),
        });
      }

      if (method === 'DELETE' && (m = path.match(/^\/api\/accounts\/([^/]+)$/))) {
        const ok = await store.remove(m[1]);
        syncInBackground();
        return json(res, ok ? 200 : 404, { ok, live: orchestrator.status().length });
      }

      // Orders feed — every detected order + its outcome (newest first).
      // dryRun=true/false filters to inbox-scan previews vs real live activity
      // (omit to get both); since=<epoch ms> hides anything older (e.g. an
      // account's activatedAt, to hide pre-go-live history by default).
      if (method === 'GET' && path === '/api/orders') {
        if (!eventsStore) return json(res, 200, { orders: [] });
        const limit = Math.min(Number(u.searchParams.get('limit')) || 100, 1000);
        const accountId = u.searchParams.get('accountId') || undefined;
        const action = u.searchParams.get('action') || undefined;
        const dryRunParam = u.searchParams.get('dryRun');
        const dryRun = dryRunParam === 'true' ? true : dryRunParam === 'false' ? false : undefined;
        const sinceParam = u.searchParams.get('since');
        const since = sinceParam ? Number(sinceParam) : undefined;
        const orders = await eventsStore.list({ limit, accountId, action, dryRun, since });
        return json(res, 200, { orders });
      }

      // Customer-facing live Orders view: one record per order (however many
      // times it was actually detected/retried), with a single final status +
      // an expandable technical timeline. Pure local-data aggregation — never
      // touches Gmail/the portal — so it always responds fast.
      // "since" defaults to the earliest account activatedAt (the bot's
      // go-live cutover) so pre-existing inbox history never leaks in here;
      // pass an explicit ?since= to override.
      if (method === 'GET' && path === '/api/orders/live') {
        if (!eventsStore) return json(res, 200, { orders: [] });
        const limit = Math.min(Number(u.searchParams.get('limit')) || 200, 1000);
        const accountId = u.searchParams.get('accountId') || undefined;
        const sinceParam = u.searchParams.get('since');
        let since = sinceParam ? Number(sinceParam) : undefined;
        if (since === undefined && typeof store?.list === 'function') {
          const stamps = (await store.list()).map((a) => a.activatedAt).filter(Boolean);
          if (stamps.length) since = Math.min(...stamps);
        }
        const orders = await eventsStore.liveOrders({ since, accountId, limit });
        return json(res, 200, { orders });
      }

      // Per-user statistics over rolling day / week / month windows.
      if (method === 'GET' && path === '/api/stats') {
        if (!eventsStore) return json(res, 200, { overall: {}, byAccount: [] });
        return json(res, 200, await eventsStore.stats());
      }

      // Production latency report — stage-by-stage breakdown (detection, lock,
      // race, verify, total) over real (non-preview) order events, so the next
      // optimization target is picked from evidence. See src/util/latencyReport.js.
      if (method === 'GET' && path === '/api/latency-report') {
        if (!eventsStore) return json(res, 200, { sampleSize: 0, stages: {}, bySource: {}, byResult: {}, bottleneck: null });
        const sinceParam = u.searchParams.get('since');
        const since = sinceParam ? Number(sinceParam) : undefined;
        const events = await eventsStore.list({ dryRun: false, since, limit: Number.MAX_SAFE_INTEGER });
        return json(res, 200, buildLatencyReport(events));
      }

      // Backfill: scan recent inbox order emails and record any not already in the
      // feed. Detection-only — it does NOT accept or decline anything.
      if (method === 'POST' && path === '/api/orders/scan') {
        if (!eventsStore || !gmailWatcher) return json(res, 400, { error: 'orders/gmail not configured' });
        const max = Math.min(Number(u.searchParams.get('max')) || 50, 200);
        const q = u.searchParams.get('q') || 'subject:"accept or decline order"';
        const report = await gmailWatcher.dryRunRecent({ max, query: q });
        const seen = await eventsStore.recordedKeys();
        let recorded = 0;
        for (const o of report.orders) {
          const key = `${o.accountId || ''}:${o.orderId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const unatt = o.decision === 'unattributed';
          const cand = (o.unmatchedCandidates && o.unmatchedCandidates[0]) || null;
          await eventsStore.record({
            accountId: o.accountId || null,
            account: unatt ? '(unattributed)' : o.attributedTo || null,
            orderId: o.orderId,
            source: 'gmail',
            action: unatt ? 'unattributed' : 'detected',
            accepted: false,
            declined: false,
            outcome: unatt
              ? 'unattributed'
              : o.decision === 'WOULD_ACCEPT'
                ? 'would_accept'
                : o.decision === 'WOULD_DECLINE'
                  ? 'would_decline'
                  : 'skip',
            via: unatt ? cand?.via || null : o.via || null,
            forwardingEmail: unatt ? cand?.address || null : o.forwardingEmail || null,
            address: o.address || null,
            state: o.state || null,
            zip: o.zip || null,
            // Preview only — no accept/decline was ever attempted. Never shown in
            // the live Orders dashboard, only in the History / Inbox Scan page.
            dryRun: true,
          });
          recorded++;
        }
        return json(res, 200, { scanned: report.scanned, recorded });
      }

      // Central-inbox Gmail connection (ONE for the whole system, not per-account).
      if (method === 'GET' && path === '/api/gmail/auth-url') {
        if (!oauthClientId) return json(res, 400, { error: 'GOOGLE_OAUTH_CLIENT_ID not configured' });
        const url = buildGoogleAuthUrl({
          clientId: oauthClientId,
          redirectUri: oauthRedirectUri,
          state: encodeOAuthState('central'),
        });
        return json(res, 200, { url });
      }

      if (method === 'GET' && path === '/api/gmail/status') {
        const conn = connectionStore ? await connectionStore.get() : null;
        return json(res, 200, {
          connected: !!conn,
          emailAddress: conn?.emailAddress,
          historyId: conn?.historyId,
          watchExpiration: conn?.watchExpiration,
        });
      }

      // SAFE TEST: report what the bot WOULD do for recent inbox orders — no
      // portal accept/decline is performed. Needs the inbox connected.
      if (method === 'GET' && path === '/api/gmail/dry-run') {
        if (!gmailWatcher) return json(res, 400, { error: 'gmail watcher not configured' });
        const max = Number(u.searchParams.get('max')) || 10;
        const q = u.searchParams.get('q');
        const report = await gmailWatcher.dryRunRecent({ max, ...(q ? { query: q } : {}) });
        return json(res, 200, report);
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      log.error('request error', { err: String(e) });
      const msg = e?.message || String(e);
      const status = /not set|not configured|required|invalid/i.test(msg) ? 400 : 500;
      return json(res, status, { error: msg });
    }
  });

  return server;
}

function authorized(req, token) {
  if (!token) return true; // no token configured = open (dev only)
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${token}`;
}

function redact(a) {
  const { portalPassword, gmailRefreshToken, ...rest } = a;
  return { ...rest, portalPassword: '***', gmailRefreshToken: gmailRefreshToken ? '***' : undefined };
}

function json(res, status, obj) {
  if (status === 204 || obj === null) {
    res.writeHead(status);
    return res.end();
  }
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function html(res, status, body) {
  const payload = typeof body === 'string' ? body : String(body);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function oauthResultPage(ok, message) {
  const color = ok ? '#059669' : '#dc2626';
  const title = ok ? 'Gmail Connected' : 'Gmail Connection Failed';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;background:#f1f5f9;margin:0}
    .card{background:#fff;padding:40px;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px;text-align:center}
    h1{color:${color};font-size:22px}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export default createControlPlane;
