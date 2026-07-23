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
                                         │  detect: portalPoller + ONE central gmailWatcher
                                         ▼  lock (exactly-once across fleet)
              region match ─► executeAccept: race Path A vs Path B ─► verify ─┐
              region miss  ─► executeDecline: race link vs portal  ─► verify ─┴► onResult
```

**Single central inbox + attribution.** All users forward their order emails into
ONE Gmail ([gmailConnection.js](src/store/gmailConnection.js) holds the single OAuth
token + watch + cursor). Because originals are BCC'd, the user's identity lives only
in the forwarding headers. [attribution.js](src/detect/attribution.js) extracts *every*
candidate recipient address from the headers; the watcher keeps the first one that
matches a registered account's `forwardingEmail`. An order that can't be attributed is
**quarantined (logged, never acted on)** — acting on the wrong account is the failure
mode we design against. Routing is by `accountId`, not Gmail address.

**Per-user regions drive accept-vs-decline.** Region rules live on each account
(`regionZipPrefixes` / `regionStates`). After attribution, the worker applies *that
user's* rule: in-region → accept; out-of-region with a concrete ZIP/state → **actively
decline** (click DECLINE / portal postback); out-of-region but no parseable ZIP/state →
**skip** (never decline on a guess). Accept and decline share the lock key, so the two
detectors can never both act on the same `(account, order)`.

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
  **Decline mirrors this exactly** — `executeDecline`
  ([declineExecutor.js](src/accept/declineExecutor.js)) races
  [emailDecline.js](src/accept/emailDecline.js) and [portalDecline.js](src/accept/portalDecline.js);
  the race helper is shared in [race.js](src/accept/race.js). For decline, verify
  treats anything *other than* `accepted` (i.e. `available`/`taken`) as success.
- **ASP.NET WebForms state is per-page and must be scraped fresh.** Any portal action
  requires posting back the current `__VIEWSTATE` / `__VIEWSTATEGENERATOR` /
  `__EVENTVALIDATION` plus `__EVENTTARGET`/`__EVENTARGUMENT`. Helpers live in
  [src/portal/aspnet.js](src/portal/aspnet.js) — reuse `scrapeHiddenFields`,
  `buildPostback`, `findPostbackTarget`, `looksLikeLogin`; never hardcode VIEWSTATE.
- **The HttpClient is custom on purpose.** [src/util/httpClient.js](src/util/httpClient.js)
  exists instead of `fetch()` for three reasons: keep-alive agents (warm TLS in the hot
  path), explicit redirect control (so a 302→/login bounce is *detectable*, not
  silently followed), and a per-account cookie jar. `PortalSession` re-authenticates
  transparently once on a login bounce (`authedGet`/`authedPost` in
  [session.js](src/portal/session.js)); preserve that retry-once behavior.
- **A login bounce during accept/decline triggers ONE re-auth retry, never more.**
  Path B ([portalAccept.js](src/accept/portalAccept.js)/[portalDecline.js](src/accept/portalDecline.js))
  gets this for free from `session.authedGet`/`authedPost`. Path A
  ([emailAccept.js](src/accept/emailAccept.js)/[emailDecline.js](src/accept/emailDecline.js))
  implements the same bound itself: if the email link (or its second-step postback)
  redirects to login AND a `session` was passed in, it calls `session.login()`
  (which handles the OTP challenge if the portal presents one) and retries the
  *exact same* request once; a second bounce (or no session at all) is reported as
  `needs_login` rather than retried again. Without a `session`, Path A has no way to
  log in and reports `needs_login` immediately — callers that want the retry must
  pass `session` (as `acceptExecutor`/`declineExecutor` do).
- **Region filter decides accept vs decline**, inside `handleOrder`, using *that
  account's* `regionZipPrefixes` / `regionStates` (**OR**'d when both are set).
  `orderMatchesRegion` returns `{allowed, decided}`: in-region → accept; out-of-region
  **and `decided`** → decline; not `decided` (a configured rule had no signal to
  evaluate, e.g. a state rule but no parseable state) → skip — never decline on a guess.
  The skip path deliberately does **not** take the lock, so a no-signal detection can't
  block a better-informed one (that would miss the order). ZIP prefixes match against
  the full ZIP, so prefixes of any length work ([regionFilter.js](src/util/regionFilter.js)).

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
(required), `ACCOUNTS_STORE` + `GMAIL_CONNECTION_STORE` paths, `LOCK_BACKEND`
(`memory` | `redis`) + `REDIS_URL`, `CONTROL_PLANE_PORT`/`CONTROL_PLANE_TOKEN`,
`PORTAL_POLL_INTERVAL_MS`, `ORDER_LOCK_TTL_MS`, and the Gmail OAuth/Pub/Sub vars. `.env`
is loaded by a tiny hand-rolled loader in [src/index.js](src/index.js) (no `dotenv`).

Per-account records (`POST /api/accounts`) carry the portal credentials,
`forwardingEmail` (the attribution key — the mailbox the user's orders are forwarded
from), `regionZipPrefixes`/`regionStates`, `pollIntervalMs` (latency/ban-risk dial;
default/floor prefer ≥10s / 5s; 5× 403/429 → circuit pause portal polls, Gmail continues;
see HOSTINGER.md for VPS IP change),
and `portalRoutes`/`portalFields` overrides. The central Gmail is connected **once** via
`GET /api/gmail/auth-url` → OAuth callback (writes the single
[GmailConnectionStore](src/store/gmailConnection.js)); `GET /api/gmail/status` reports it.

## Testing

Built-in `node:test` + `node:assert/strict` — no Jest/Mocha. The centerpiece is
[test/mocks/mockPortal.js](test/mocks/mockPortal.js), a faithful ASP.NET WebForms
simulator: it issues and validates VIEWSTATE/EVENTVALIDATION, gates pages behind an
`ASP.NET_SessionId` cookie, makes acceptance **atomic and first-come-first-served**,
toggles the email link between standalone-GET and login-bounce (`emailLinkMode`), handles
both accept and **decline** postbacks/links (`emailDeclineUrl`), and renders per-vendor
status. When adding portal behavior, extend the mock to match the real WebForms contract
rather than loosening the assertions. Region/attribution/decline coverage lives in
[test/regionRouting.test.js](test/regionRouting.test.js),
[test/attribution.test.js](test/attribution.test.js), [test/decline.test.js](test/decline.test.js),
and [test/gmail.test.js](test/gmail.test.js) (78 tests total).
