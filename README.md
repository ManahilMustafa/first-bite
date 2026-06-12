# E-Street Bot

Multi-account auto-accept bot for **E-Street Appraisal Management** orders (the
platform is **ValueLink AMS**, sender `notifications@valuelinkams.com`).

It watches for new appraisal orders across many accounts and accepts them as fast
as possible. Orders are a **first-come-first-served broadcast** to multiple
vendors — the order email itself says *"accept as soon as possible; if already
assigned, the link will advise you the order is no longer available."* Speed is
the whole game, so the bot runs **two detectors** and **races two accept paths**.

> ⚠️ **Operational risk.** Rapid automated order-accept against a vendor portal
> can violate the platform's Terms of Service and risk account suspension, and
> racing across multiple accounts amplifies that exposure. This is a business
> decision for the operator. Run only against accounts you own/are authorized to
> operate. Deploy as an **internal tool** (see ARCHITECTURE.md) to stay within
> Google's personal/internal-use exception and avoid the restricted-scope
> compliance wall.

---

## What's built (and tested)

| Layer | File | Tested |
|---|---|---|
| Email parser (ValueLink order emails) | [src/detect/emailParser.js](src/detect/emailParser.js) | ✅ |
| Portal poller (bounded detector) | [src/detect/portalPoller.js](src/detect/portalPoller.js) | ✅ (integration) |
| Gmail Pub/Sub watcher (redundancy) | [src/detect/gmailWatcher.js](src/detect/gmailWatcher.js) | ✅ (mocked fetch) |
| Authenticated portal session | [src/portal/session.js](src/portal/session.js) | ✅ |
| ASP.NET WebForms helpers (VIEWSTATE) | [src/portal/aspnet.js](src/portal/aspnet.js) | ✅ |
| Accept path A — email link GET | [src/accept/emailAccept.js](src/accept/emailAccept.js) | ✅ |
| Accept path B — portal postback replay | [src/accept/portalAccept.js](src/accept/portalAccept.js) | ✅ |
| Racing executor + verify | [src/accept/acceptExecutor.js](src/accept/acceptExecutor.js) | ✅ |
| Exactly-once lock (memory + Redis) | [src/lock/](src/lock/) | ✅ |
| Per-account worker | [src/worker/worker.js](src/worker/worker.js) | ✅ (integration) |
| Orchestrator ("more creds = more bots") | [src/orchestrator/orchestrator.js](src/orchestrator/orchestrator.js) | ✅ |
| Encrypted accounts store | [src/store/accountsStore.js](src/store/accountsStore.js) | ✅ |
| Control-plane HTTP API | [src/controlPlane/server.js](src/controlPlane/server.js) | ✅ |

**43 tests, all passing**, including a faithful mock E-Street portal that
simulates login, VIEWSTATE/EVENTVALIDATION issuance + validation, the
`__doPostBack` accept, atomic first-come-first-served acceptance, the email-link
path, and the per-vendor status page.

```bash
npm test
```

The core has **zero runtime dependencies** (Node ≥ 20 built-ins only). Redis is
an optional dependency, used only when `LOCK_BACKEND=redis`.

---

## Quick start

```bash
cp .env.example .env
# generate an encryption key:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# paste it into CREDS_ENCRYPTION_KEY in .env, set CONTROL_PLANE_TOKEN

npm start            # boots orchestrator + control plane on :8787
```

Add an account (a bot spawns immediately):

```bash
curl -X POST http://localhost:8787/api/accounts \
  -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "label": "vendor-1",
        "portalBaseUrl": "https://<the-estreet-portal-host>",
        "portalUsername": "you@example.com",
        "portalPassword": "•••",
        "pollIntervalMs": 2000
      }'
```

List / deactivate:

```bash
curl -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" http://localhost:8787/api/accounts
curl -X POST http://localhost:8787/api/accounts/<id>/activate \
  -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" -d '{"active":false}'
```

---

## ⚠️ Two unknowns you MUST verify before production

The engine is complete, but two facts about the **real** portal decide which
path is your fast path. Both are 30-second checks in your browser's Network tab:

1. **Is the email `ACCEPT ORDER` link a self-contained authenticated GET?**
   Open a real order email, copy the `ACCEPT ORDER` link, paste it into a
   logged-out browser. If it accepts → Path A is your ~100–300 ms fast path. If
   it bounces to login → the code automatically falls back to Path B (the bot
   already handles both; see the `needs_login` test).

2. **What does the portal's Accept button actually send, and is there a live
   push channel?** On the New Orders page, open DevTools → Network. Click Accept
   on a (test) order and inspect the request: confirm the field names
   (`__VIEWSTATE`, `__EVENTVALIDATION`, `__EVENTTARGET`, `__EVENTARGUMENT`) and
   the route. Filter by **WS** — if the dashboard holds a WebSocket/SignalR
   connection, that's a true-millisecond detector to add (see ARCHITECTURE.md).

Once you have these, set the real values in the account config:
`portalRoutes` (login / newOrders / status paths) and `portalFields` (login form
field names) on the account record. The defaults match a typical ValueLink
layout but **must be confirmed against your portal**.

---

## Configuration

Per-account record (POST `/api/accounts`):

```jsonc
{
  "label": "vendor-1",
  "active": true,
  "portalBaseUrl": "https://portal.example.com",
  "portalUsername": "you@example.com",
  "portalPassword": "•••",              // encrypted at rest
  "pollIntervalMs": 2000,                // detection floor; tighter = faster + riskier
  "portalRoutes": {                      // CONFIRM against the real portal
    "login": "/Account/Login.aspx",
    "newOrders": "/Orders/NewOrders.aspx"
  },
  "portalFields": {                      // CONFIRM the real login field names
    "username": "ctl00$MainContent$txtUsername",
    "password": "ctl00$MainContent$txtPassword",
    "submit": "ctl00$MainContent$btnLogin",
    "submitValue": "Log In"
  },
  "gmailAddress": "you@gmail.com",       // optional, enables Gmail redundancy
  "gmailRefreshToken": "•••"             // encrypted; obtained via OAuth
}
```

See [.env.example](.env.example) for global settings (encryption key, lock
backend, poll interval, Gmail OAuth/Pub/Sub).

### Region filtering

Per-account `regionZipPrefixes` (e.g. `["34","32"]`) and `regionStates`
(e.g. `["FL"]`) are enforced in the worker before accept. Orders outside the
configured region are skipped (logged as `region_skipped`).

### Gmail OAuth (dashboard)

1. Configure `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REDIRECT_URI`, and `GMAIL_PUBSUB_TOPIC` in `.env`.
2. Add an account in the admin dashboard.
3. Click **Connect Gmail** on the Accounts page — completes OAuth, stores the
   refresh token, and registers the Pub/Sub `users.watch()` subscription.

### Admin dashboard

```bash
cd admin-dashboard && npm install && npm run dev
```

Opens on **http://localhost:5173** (proxies API calls to the control plane).
