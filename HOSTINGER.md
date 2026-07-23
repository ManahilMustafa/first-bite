# Hostinger VPS — IP change + safe bot restart

This runbook is for operators running **first-bite / E-Street bot** on a Hostinger
VPS (e.g. previously `http://69.62.67.188:5173`).

**What an IP change does:** if the appraisal portal blocked your **server IP**, a
new IP can restore portal access from that machine.

**What it does not do:** it will not restore a **suspended vendor account**, and
it does not hide automation. After a new IP, keep poll intervals ≥ 10s and let
the circuit breaker pause portal polling on 403/429.

Hostinger does **not** offer a reliable one-click “change IP” on most VPS plans.
Use one of the paths below.

---

## Path A — New VPS or new data-center location (preferred)

1. In [hPanel](https://hpanel.hostinger.com/) → **VPS**, note your current IP and
   whether you use a domain.
2. Create a **new VPS** (or migrate / change location if your plan allows). The
   new instance gets a **new public IP**.
3. On the new server: install Node 20+, clone/copy the app (see [DEPLOY.md](DEPLOY.md)).
4. Copy secrets carefully:
   - Copy `.env` **and** `data/` **only if** `CREDS_ENCRYPTION_KEY` stays the same.
   - If the encryption key changes, do **not** copy `data/` — re-add accounts and
     reconnect the central Gmail inbox on the new host.
5. Point DNS: update the domain **A record** to the new IP
   ([DNS Zone Editor](https://www.hostinger.com/support/how-to-use-hostingers-dns-zone-editor/)).
   Wait for propagation (up to ~24h; often much faster).
6. Optional: set **PTR / reverse DNS** for the new IP
   ([Hostinger reverse DNS](https://www.hostinger.com/support/4805528-how-to-setup-reverse-dns-on-vps/)).
7. Update Google OAuth **Authorized redirect URI** if it referenced the old
   IP/host (`GOOGLE_OAUTH_REDIRECT_URI` in `.env` must match).
8. Firewall: allow **22 / 80 / 443**. Do **not** expose Vite `:5173` publicly —
   build the dashboard and serve it behind Caddy/nginx on 443 (see DEPLOY.md).

## Path B — Ask Hostinger support

1. Open a Hostinger chat/ticket: request an **IPv4 change / reassignment** for
   your VPS.
2. Availability is **plan-dependent**; they may refuse or require a rebuild.
3. After they assign a new IP, complete DNS + OAuth + firewall steps from Path A.

## Path C — OS reinstall / rebuild (last resort)

1. **Backup** `.env`, `data/`, and any systemd/Caddy config first.
2. Reinstall/rebuild from hPanel. IP may stay the same or change — check the
   VPS overview after rebuild.
3. If the IP changed, follow Path A steps 4–8. If it stayed the same, a rebuild
   alone will **not** clear a portal IP block.

---

## After you have a new IP — safe restart checklist

1. **Stop the bot** on the old server (so it stops hammering the portal).
2. From the **new** server, smoke-test the portal:
   ```bash
   curl -sI "https://<your-portal-host>/"
   ```
   Expect a normal HTTP response (not a sustained 403/429).
3. Deploy with safer defaults (already in `.env.example`):
   ```ini
   PORTAL_POLL_INTERVAL_MS=10000
   PORTAL_POLL_FLOOR_MS=5000
   PORTAL_CIRCUIT_THRESHOLD=5
   PORTAL_CIRCUIT_COOLDOWN_MS=1800000
   ```
4. Start backend (`npm start` / systemd). Prefer production dashboard build +
   reverse proxy — not `vite` on `:5173` public.
5. Connect central Gmail if needed; add **one** account with `pollIntervalMs`
   ≥ 10000.
6. Dry-run before live accepts:
   ```bash
   curl -s -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" \
     "http://127.0.0.1:8787/api/gmail/dry-run?max=10"
   ```
7. Watch the dashboard: if portal polling hits repeated 403/429, the worker shows
   **Paused** (Gmail detection still runs). Resume with:
   ```bash
   curl -X POST -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" \
     "http://127.0.0.1:8787/api/accounts/<id>/resume-poller"
   ```
   or use **Resume poll** on the Accounts page.

---

## Circuit breaker reminder

Repeated portal **403 / 429 / timeouts** open a per-account circuit: **portal
polling pauses**; email-based detection continues. This reduces ban pressure; it
is not stealth or anti-detect.
