# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-account auto-accept bot for **E-Street / ValueLink AMS** appraisal orders.
Orders broadcast first-come-first-served to many vendors, so **speed is the whole
product**: two independent detectors feed a fleet of per-account workers that race
two accept strategies and confirm with a third read. See [README.md](README.md) for
the operational/ToS context and [ARCHITECTURE.md](ARCHITECTURE.md) for the full diagram.

## Commands

```bash
npm start                       # boot orchestrator + control plane on :8787 (src/index.js)
npm run control-plane           # control-plane HTTP server only
npm test                        # node:test runner over test/*.test.js
npm run test:watch              # same, in watch mode
node --test test/portal.test.js                       # run a single test file
node --test --test-name-pattern="re-login" test/*.test.js   # run tests matching a name

# one-time setup
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # CREDS_ENCRYPTION_KEY

# admin dashboard (separate package)
cd admin-dashboard && npm install && npm run dev   # Vite on :5173, proxies /api + /health to :8787
cd admin-dashboard && npm run build                # production build
cd admin-dashboard && npm run lint                 # eslint
```

There is **no lint/format step for the backend** — `src/` and `test/` are plain Node
with no build. Only `admin-dashboard/` has a toolchain (Vite/React/ESLint).

## Hard constraints

- **Core has zero runtime dependencies** — `src/` uses Node ≥ 20 built-ins only.
  `redis` is an `optionalDependency`, lazy-imported only when `LOCK_BACKEND=redis`.
  Do not add npm packages to the backend without a strong reason; reach for a
  `node:` built-in first.
- **ESM everywhere** (`"type": "module"`). Use `import`, include `.js` extensions in
  relative imports, no `require`.
- **No browser automation.** Playwright/headless Chrome are deliberately avoided —
  a browser per order would cost the seconds the bot exists to save. Everything is
  raw HTTP via the custom `HttpClient`.

## Architecture (the data flow)

```
accounts store ──► orchestrator ──► AccountWorker (1 per active account)
                                         │  detect: portalPoller + gmailWatcher
                                         ▼  lock (exactly-once across fleet)
                                    executeAccept: race Path A vs Path B ──► verify ──► onResult
```

- **Accounts store** ([src/store/accountsStore.js](src/store/accountsStore.js)) is the
  single source of truth for "how many bots are live". Encrypted JSON on disk; secret
  fields (`portalPassword`, `gmailRefreshToken`) are AES-256-GCM-encrypted via
  [src/util/crypto.js](src/util/crypto.js).
- **Orchestrator** ([src/orchestrator/orchestrator.js](src/orchestrator/orchestrator.js))
  reconciles the running worker set against active accounts. `sync()` is idempotent and
  is called after **every** store mutation by the control plane — this is the
  "more creds = more bots" engine. Workers run **in-process** today; to get hard fault
  isolation, swap `_startWorker`/`_stopWorker` to fork a child process per account — the
  reconcile logic is unchanged.
- **AccountWorker** ([src/worker/worker.js](src/worker/worker.js)) owns one account's
  session (cookie jar), poller, and Gmail cursor. `handleOrder()` is the single entry
  point for **both** detectors and is where region filtering, lock acquisition, accept,
  and result reporting happen.
- **Control plane** ([src/controlPlane/server.js](src/controlPlane/server.js)) is a
  zero-dependency `node:http` server. Admin endpoints require
  `Authorization: Bearer <CONTROL_PLANE_TOKEN>`; Gmail webhook and OAuth callback are
  unauthenticated (gated by a Pub/Sub token / OAuth state instead).

## Subtle invariants — get these right

- **Lock = exactly-once, retained on success.** N webhooks + M pollers can spot the
  same order. The first to `acquire(order:<id>)` proceeds; the rest no-op. On a
  *successful* accept the worker **does not release** the key — it's held for its TTL so
  a late duplicate detection can't re-fire. Only release on failure. See
  [worker.js](src/worker/worker.js) (`if (!result.accepted) await this.lock.release(key)`).
- **Accept races two paths and verifies with a third read.** `executeAccept`
  ([src/accept/acceptExecutor.js](src/accept/acceptExecutor.js)) fires Path A
  (email-link GET, [emailAccept.js](src/accept/emailAccept.js)) and Path B (portal
  `__doPostBack` replay, [portalAccept.js](src/accept/portalAccept.js)) concurrently,
  takes the first confirmed `ok:true`, then re-reads order status as the source of
  truth. The verify is awaited but is *outcome reporting*, not part of winning the race.
- **ASP.NET WebForms state is per-page and must be scraped fresh.** Any portal action
  requires posting back the current `__VIEWSTATE` / `__VIEWSTATEGENERATOR` /
  `__EVENTVALIDATION` plus `__EVENTTARGET`/`__EVENTARGUMENT`. Helpers live in
  [src/portal/aspnet.js](src/portal/aspnet.js) — reuse `scrapeHiddenFields`,
  `buildPostback`, `findPostbackTarget`, `looksLikeLogin`; never hardcode VIEWSTATE.
- **The HttpClient is custom on purpose.** [src/util/httpClient.js](src/util/httpClient.js)
  exists instead of `fetch()` for three reasons: keep-alive agents (warm TLS in the hot
  path), explicit redirect control (so a 302→/login bounce is *detectable*, not
  silently followed), and a per-account cookie jar. `PortalSession` re-authenticates
  transparently once on a login bounce; preserve that retry-once behavior.
- **Region filter runs before accept**, inside `handleOrder`. Orders outside an
  account's `regionZipPrefixes` / `regionStates` are skipped (`region_skipped`).

## Two production unknowns

The engine is complete but two facts about the **real** portal decide the fast path and
**must be confirmed in the browser Network tab** before production (details in
[README.md](README.md)): (1) is the email `ACCEPT ORDER` link a self-contained
authenticated GET (→ Path A) or does it bounce to login (→ Path B fallback)? (2) what
fields does the Accept button actually POST, and is there a WebSocket/SignalR push
channel to add as a true-millisecond detector? The defaults in
`DEFAULT_ROUTES`/`DEFAULT_FIELDS` ([session.js](src/portal/session.js)) match a typical
ValueLink layout but are overridable per-account via `portalRoutes` / `portalFields`.

## Configuration

Global settings in `.env` (see [.env.example](.env.example)): `CREDS_ENCRYPTION_KEY`
(required), `ACCOUNTS_STORE` path, `LOCK_BACKEND` (`memory` | `redis`) + `REDIS_URL`,
`CONTROL_PLANE_PORT`/`CONTROL_PLANE_TOKEN`, `PORTAL_POLL_INTERVAL_MS`,
`ORDER_LOCK_TTL_MS`, and the Gmail OAuth/Pub/Sub vars. `.env` is loaded by a tiny
hand-rolled loader in [src/index.js](src/index.js) (no `dotenv` dependency).

Per-account records are created via `POST /api/accounts` and carry the portal
credentials, optional Gmail OAuth fields, `pollIntervalMs` (the latency/ban-risk dial),
and the `portalRoutes`/`portalFields` overrides.

## Testing

Built-in `node:test` + `node:assert/strict` — no Jest/Mocha. The centerpiece is
[test/mocks/mockPortal.js](test/mocks/mockPortal.js), a faithful ASP.NET WebForms
simulator: it issues and validates VIEWSTATE/EVENTVALIDATION, gates pages behind an
`ASP.NET_SessionId` cookie, makes acceptance **atomic and first-come-first-served**,
toggles the email link between standalone-GET and login-bounce (`emailLinkMode`), and
renders per-vendor status (winner vs. "assigned to another"). When adding portal
behavior, extend the mock to match the real WebForms contract rather than loosening the
assertions.
