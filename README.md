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
| Portal poller (bounded detector) | [src/detect/portalPoller.js](src/detect/portalPoller.js) | ✅ (integration + safety) |
| Central Gmail watcher (single inbox) | [src/detect/gmailWatcher.js](src/detect/gmailWatcher.js) | ✅ (mocked fetch) |
| Forwarded-email attribution (header → user) | [src/detect/attribution.js](src/detect/attribution.js) | ✅ |
| Authenticated portal session | [src/portal/session.js](src/portal/session.js) | ✅ |
| ASP.NET WebForms helpers (VIEWSTATE) | [src/portal/aspnet.js](src/portal/aspnet.js) | ✅ |
| Accept path A — email link GET | [src/accept/emailAccept.js](src/accept/emailAccept.js) | ✅ |
| Accept path B — portal postback replay | [src/accept/portalAccept.js](src/accept/portalAccept.js) | ✅ |
| Decline paths A/B (out-of-region) | [src/accept/emailDecline.js](src/accept/emailDecline.js) · [portalDecline.js](src/accept/portalDecline.js) | ✅ |
| Racing accept/decline executors + verify | [acceptExecutor.js](src/accept/acceptExecutor.js) · [declineExecutor.js](src/accept/declineExecutor.js) | ✅ |
| Exactly-once lock (memory + Redis) | [src/lock/](src/lock/) | ✅ |
| Per-account worker (region accept/decline) | [src/worker/worker.js](src/worker/worker.js) | ✅ (integration) |
| Orchestrator ("more creds = more bots") | [src/orchestrator/orchestrator.js](src/orchestrator/orchestrator.js) | ✅ |
| Encrypted accounts store | [src/store/accountsStore.js](src/store/accountsStore.js) | ✅ |
| Central Gmail connection store | [src/store/gmailConnection.js](src/store/gmailConnection.js) | ✅ |
| Control-plane HTTP API | [src/controlPlane/server.js](src/controlPlane/server.js) | ✅ |

**78 tests, all passing**, including a faithful mock E-Street portal that
simulates login, VIEWSTATE/EVENTVALIDATION issuance + validation, the
`__doPostBack` accept **and decline**, atomic first-come-first-served acceptance,
the email-link path, and the per-vendor status page — plus header attribution and
per-user region accept/decline routing.

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
  "forwardingEmail": "you@gmail.com",    // attribution key: mailbox orders forward FROM
  "regionStates": ["FL"],                // per-user region rule (accept these)
  "regionZipPrefixes": ["32","33","34"], // …or by ZIP prefix; out-of-region = decline
  "portalRoutes": {                      // CONFIRM against the real portal
    "login": "/Account/Login.aspx",
    "newOrders": "/Orders/NewOrders.aspx"
  },
  "portalFields": {                      // CONFIRM the real login field names
    "username": "ctl00$MainContent$txtUsername",
    "password": "ctl00$MainContent$txtPassword",
    "submit": "ctl00$MainContent$btnLogin",
    "submitValue": "Log In"
  }
}
```

The central Gmail token is **not** on the account record anymore — it's a single
system-wide connection (see "Central inbox" below).

See [.env.example](.env.example) for global settings (encryption key, lock
backend, poll interval, Gmail OAuth/Pub/Sub).

**Portal safety:** default poll is **10s** (floored at 5s). Repeated 403/429/timeouts
open a per-account **circuit breaker** that pauses portal polling while Gmail
detection continues. Resume via dashboard **Resume poll** or
`POST /api/accounts/:id/resume-poller`. Hostinger IP-change runbook:
[HOSTINGER.md](HOSTINGER.md).

### Per-user region filtering (accept vs decline)

Each account carries its own `regionZipPrefixes` (e.g. `["34","32"]`) and/or
`regionStates` (e.g. `["FL"]` or `["TX"]`). If both are set they're **OR**'d — an
order matching *either* the ZIP or the state is in-region. After an order is
attributed to the right user, the worker applies **that user's** rule:

- **In-region** → accept (race email link vs portal postback, then verify).
- **Out-of-region** with a concrete ZIP/state → **actively decline** (click the
  DECLINE link, or the portal Decline postback for poller-detected orders).
- **Region undetermined** (no ZIP/state could be parsed) → skip — never decline
  on a guess.

So one user set to `["FL"]` accepts a Florida order while another set to `["TX"]`
declines the same one — purely from their own rule. ZIP prefixes match against the
full ZIP, so `"34"`, `"346"`, and `"34613"` all work.

### Central inbox: one Gmail for everyone (forward + attribution)

Instead of one Gmail per account, **all users forward their order emails into one
central inbox** that you connect once. Because the order email is BCC'd to the
vendor, the user's identity lives in the *forwarding headers* — the bot extracts
every candidate recipient address and matches it to the account whose
`forwardingEmail` it is. An order it can't attribute is **quarantined** (logged,
never acted on).

1. Configure `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REDIRECT_URI`, and `GMAIL_PUBSUB_TOPIC` in `.env`.
2. On the dashboard Accounts page, click **Connect central inbox** **once** —
   completes OAuth, stores the single refresh token, and registers the Pub/Sub
   `users.watch()` on that one inbox.
3. Set each user's **Forwarding Email** on their account so forwarded mail routes
   to them. Have each user auto-forward their E-Street order emails to the inbox.

> The attribution header varies by forwarding setup (Workspace vs personal Gmail,
> auto vs manual forward). Confirm against one real forwarded sample — open it in
> the central inbox → **Show original** → check which header (`X-Gm-Original-To`,
> `X-Forwarded-For`, `Delivered-To`, …) carries the user's address. The extractor
> already tries them in priority order; no code change is needed unless your
> header isn't in that list.

### Admin dashboard

```bash
cd admin-dashboard && npm install && npm run dev
```

Opens on **http://localhost:5173** (proxies API calls to the control plane).
