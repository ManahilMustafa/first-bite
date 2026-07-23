# Architecture

```
                          ┌──────────────────────────────────────┐
                          │            CONTROL PLANE              │
                          │  internal portal (HTTP API, :8787)    │
                          │  add / activate / remove accounts     │
                          └───────────────┬──────────────────────┘
                                          │ upsert + sync()
                          ┌───────────────▼──────────────────────┐
                          │          ACCOUNTS STORE               │
                          │  one row/account, secrets encrypted   │
                          │  (AES-256-GCM) — source of truth for  │
                          │  "how many bots are live"             │
                          └───────────────┬──────────────────────┘
                                          │ listActive()
                          ┌───────────────▼──────────────────────┐
                          │           ORCHESTRATOR                │
                          │  reconciles workers ⇄ active accounts │
                          │  add row → bot up; deactivate → down  │
                          └──────┬─────────────────┬──────────────┘
                                 │                 │
                  ┌──────────────▼───┐   ┌─────────▼────────────┐   (N workers,
                  │  AccountWorker 1 │   │   AccountWorker N    │    one per account,
                  │  own session,    │   │   own session,       │    fully isolated)
                  │  own poller,     │   │   own poller,        │
                  │  own cursor      │   │   own cursor         │
                  └──────┬───────────┘   └──────────────────────┘
                         │
        DETECT ──────────┼─────────────────────────────────────────
                         │
        ┌────────────────▼─────────┐     ┌──────────────────────────┐
        │  Portal poller (primary  │     │  Gmail Pub/Sub watcher    │
        │  reliable detector)      │     │  (redundancy; seconds)    │
        │  bounded: ≤ pollInterval │     │  push → history → parse   │
        └────────────────┬─────────┘     └──────────┬───────────────┘
                         │  orderDetected            │ orderDetected
                         └─────────────┬─────────────┘
                                       ▼
        LOCK ───────────────  Redis SET order NX  (exactly-once across fleet)
                                       │ won?
                                       ▼
        ACCEPT ──────  raced in the hot path, warm keep-alive conn  ───────
                       ┌───────────────┴───────────────┐
                       │                               │
            Path A: email-link GET          Path B: portal __doPostBack
            (~100–300ms if self-            (scrape VIEWSTATE/EVENTVALIDATION,
             contained; else falls           replay as raw POST)
             back to Path B)
                       └───────────────┬───────────────┘
                                       ▼
                          VERIFY  re-read order status
                          (source of truth; off the
                           latency-critical path)
                                       ▼
                          NOTIFY / metrics (onResult)
```

## Why each piece

### Deployment: internal tool, not public SaaS
Staying inside Google's personal/internal-use exception avoids the CASA annual
security assessment ($500–$4,500/yr), the weeks of verification, and the 7-day
refresh-token expiry that an app stuck in "Testing" publishing status suffers.
The control plane is the same UX — it's just access-gated to the operator.

### Detection: two independent detectors, ranked by speed
- **Portal poller** is the *reliable* detector. It's bounded: poll every N ms and
  any new order is detected within ≤ N ms regardless of email behaviour. Tighter
  interval = lower latency but higher ban risk — that's the tuning dial.
- **Gmail Pub/Sub** is *redundancy only*. Email delivery + Pub/Sub tail latency
  are inherently seconds, so it can never be the millisecond path — but it
  catches orders even if portal polling is throttled, and it carries the email's
  self-contained ACCEPT/DECLINE links (Path A). It is now a **single central
  inbox**: every user forwards their order emails into one operator-owned mailbox
  (one OAuth token, one `users.watch`). Each forwarded email is **attributed** to
  the user it came from by matching a recipient address in its forwarding headers
  (`src/detect/attribution.js`) against that account's `forwardingEmail`; an order
  that can't be attributed is quarantined, never acted on.
- **WebSocket/SignalR** (not yet wired — gated by unknown #2): if the ASP.NET
  dashboard pushes new-order events over a live socket, subscribing to it gives
  true ~tens-of-ms detection with no polling. Add it as the primary detector if
  the Network tab shows a WS connection.

### Lock: exactly-once
N Gmail webhooks + M portal pollers can all spot the same order. `SET order NX`
guarantees the first to acquire proceeds; everyone else no-ops. After a
*successful* accept the key is retained for its TTL so a late duplicate detection
can't re-fire. The in-memory lock matches Redis semantics for single-process /
test use; switch to Redis (`LOCK_BACKEND=redis`) for a multi-process fleet.

### Region gate: accept in-region, decline out-of-region
Before any action, the worker applies *that user's* region rule
(`regionZipPrefixes` / `regionStates`). In-region orders are accepted; out-of-region
orders with a concrete ZIP/state are **actively declined** (the same race shape,
over the DECLINE link / portal Decline postback — `declineExecutor.js`); orders
with no parseable ZIP/state are skipped rather than declined on a guess. Accept and
decline share the exactly-once lock key, so two detectors never both act on the
same `(account, order)`.

### Accept: race A and B, verify with a third read
The executor fires both paths concurrently and takes whichever confirms first,
then re-reads order status (source of truth) to report a truthful outcome. The
verify is awaited but is *outcome reporting*, not part of winning the race.
Decline works identically, and the race primitive is shared (`accept/race.js`).

Hot-path latency optimizations (in `HttpClient` + `PortalSession`):
- **Warm keep-alive connections** — the accept reuses an open TLS socket, no
  handshake in the hot path.
- **Raw HTTP, no browser** — Playwright is explicitly avoided; a browser per
  order would cost the seconds we're trying to save.
- **Transparent re-login** — a session that bounces to login re-authenticates
  once and retries, so an expired cookie doesn't lose an order.

### Scaling: control plane + one isolated worker per account
The accounts store is the source of truth; the orchestrator brings the worker set
in line with active rows on every change. Each worker owns its own session
(cookie jar), poller, and Gmail history cursor — they share only the lock and the
Pub/Sub topic, so one revoked token or hung session crashes only its own worker.

**Production isolation:** workers here run in-process (one object each), which is
ideal for testing and small fleets. For hard fault isolation, swap
`Orchestrator._startWorker/_stopWorker` to fork a child process (or launch a
container) per account — the reconcile logic is identical.

## Latency budget (realistic)

| Stage | Fast path | Notes |
|---|---|---|
| Detection | ~tens of ms (WS) · ≤ pollInterval (poll) · seconds (email) | the dominant cost |
| Lock | ~5–20 ms | negligible |
| Accept A (email GET, warm) | ~100–300 ms | only if link is self-contained |
| Accept B (postback replay) | ~300 ms–1 s | robust fallback |
| Verify | off critical path | not counted toward the win |

End-to-end floor with a push channel + co-located server: **~100–200 ms**. On
tight polling: **~150–400 ms**. Physical floor (RTT × round-trips from a
co-located VPS): **~50–100 ms** — unbeatable regardless of code.

## Test strategy

`test/mocks/mockPortal.js` is a faithful ASP.NET WebForms simulator:
issues + validates VIEWSTATE/EVENTVALIDATION, gates pages behind an
`ASP.NET_SessionId` cookie, makes acceptance **atomic and first-come-first-served**,
toggles the email-link between standalone-GET and login-bounce (modelling unknown
#1), and renders a **per-vendor** status page (winner sees "in progress", losers
see "assigned to another"). The integration tests prove: end-to-end
detect→accept, dedup of concurrent detections, a two-account race resolving to
exactly one winner, and retained-lock suppression of late duplicates.
