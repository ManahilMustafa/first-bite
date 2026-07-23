# Deploy Guide

Two paths:
- **A. Another computer (local/dev)** — quick, but OAuth + Pub/Sub still tied to that machine's `localhost`.
- **B. Public server (production)** — recommended. A public HTTPS URL fixes the `localhost`
  redirect problem and lets Google Pub/Sub reach the webhook.

> **Never copy these between machines:** `node_modules/`, `.env`, `data/`.
> Secrets in `data/` are encrypted with `CREDS_ENCRYPTION_KEY` — a different key can't
> decrypt them. On a new machine, use a fresh `.env` and **re-connect Gmail there**
> (re-run the consent) and re-add accounts. Don't carry the old `data/`.

---

## A. Run on another computer

### Windows (PowerShell)
```powershell
# 1. Install Node 20+  (https://nodejs.org)  then verify:
node --version

# 2. Get the code (git, or copy the folder WITHOUT node_modules/.env/data)
git clone <your-repo-url> estreet ; cd estreet

# 3. Configure
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # paste into CREDS_ENCRYPTION_KEY
notepad .env    # fill CREDS_ENCRYPTION_KEY, CONTROL_PLANE_TOKEN, GOOGLE_OAUTH_* 

# 4. Run backend
npm install
npm start                       # control plane on http://localhost:8787

# 5. (optional) dashboard, in a second terminal
cd admin-dashboard ; npm install ; npm run dev    # http://localhost:5173
```

### Linux / macOS (bash)
```bash
node --version                                  # need 20+
git clone <your-repo-url> estreet && cd estreet
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # -> CREDS_ENCRYPTION_KEY
nano .env
npm install
npm start
```

On any single machine, complete the Gmail consent **in a browser on that same machine**
(because the redirect goes to that machine's `localhost:8787`).

---

## B. Public production server (Ubuntu/Debian VPS) — recommended

Assumes a VPS with a domain pointing at it, e.g. `bot.example.com`.

### 1. Install Node 20 + git
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version
```

### 2. Get the code + configure
```bash
git clone <your-repo-url> /opt/estreet && cd /opt/estreet
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # -> CREDS_ENCRYPTION_KEY
nano .env
npm ci --omit=optional        # core has zero runtime deps; omit redis unless LOCK_BACKEND=redis
```

Set these in `.env` (note the **public** redirect URI):
```ini
CREDS_ENCRYPTION_KEY=<generated>
CONTROL_PLANE_TOKEN=<long-random-admin-token>
GOOGLE_OAUTH_CLIENT_ID=<your id>
GOOGLE_OAUTH_CLIENT_SECRET=<your secret>
GOOGLE_OAUTH_REDIRECT_URI=https://bot.example.com/oauth/google/callback
GMAIL_PUBSUB_TOPIC=projects/<project>/topics/<topic>
GMAIL_PUBSUB_VERIFICATION_TOKEN=<long-random-token>
```

### 3. Build the dashboard (static)
```bash
cd admin-dashboard && npm ci && npm run build      # outputs admin-dashboard/dist
cd ..
```

### 4. Keep the backend running (systemd)
```bash
sudo tee /etc/systemd/system/estreet.service >/dev/null <<'UNIT'
[Unit]
Description=E-Street bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/estreet
ExecStart=/usr/bin/node src/index.js
Restart=always
EnvironmentFile=/opt/estreet/.env

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now estreet
sudo systemctl status estreet --no-pager
journalctl -u estreet -f          # live logs
```

### 5. Public HTTPS via Caddy (auto-TLS, simplest)
```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
bot.example.com {
    # backend handles API, health, OAuth callback, and the Pub/Sub webhook
    @backend path /api/* /health /oauth/* /webhooks/*
    handle @backend {
        reverse_proxy localhost:8787
    }
    # everything else = the built dashboard
    handle {
        root * /opt/estreet/admin-dashboard/dist
        try_files {path} /index.html
        file_server
    }
}
CADDY

sudo systemctl reload caddy
```

### 6. Google Cloud Console
- **Authorized redirect URIs** → add `https://bot.example.com/oauth/google/callback`.
- **Gmail API** enabled; **OAuth consent screen** → add the central Gmail as a Test user
  (or publish the app).

### 7. Pub/Sub push (live email detection)
```bash
# in the SAME GCP project as the OAuth client
gcloud pubsub topics create estreet-orders
# let Gmail publish to it
gcloud pubsub topics add-iam-policy-binding estreet-orders \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher
# push subscription -> your webhook (token must match GMAIL_PUBSUB_VERIFICATION_TOKEN)
gcloud pubsub subscriptions create estreet-orders-push \
  --topic=estreet-orders \
  --push-endpoint="https://bot.example.com/webhooks/gmail?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>"
```
Set `GMAIL_PUBSUB_TOPIC=projects/<project>/topics/estreet-orders` in `.env`, then
`sudo systemctl restart estreet`. (Even without Pub/Sub, the built-in Gmail **poll loop**
fetches every `GMAIL_POLL_INTERVAL_MS`.)

### 8. Connect + verify (against the public URL)
```bash
TOKEN=<CONTROL_PLANE_TOKEN>
BASE=https://bot.example.com

# get the consent URL, open it IN A BROWSER, sign in as the central Gmail, Allow
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/gmail/auth-url

# confirm connected
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/gmail/status

# add a vendor (forwardingEmail = the mailbox their orders forward FROM)
curl -X POST $BASE/api/accounts -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"label":"vendor-fl","portalBaseUrl":"https://<portal>","portalUsername":"u",
       "portalPassword":"p","forwardingEmail":"vendor@gmail.com","regionStates":["FL"]}'

# safe preview — what it WOULD do for recent inbox orders (no portal action)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/gmail/dry-run?max=10"
```

---

## Updating a deployment
```bash
cd /opt/estreet && git pull
npm ci --omit=optional
( cd admin-dashboard && npm ci && npm run build )
sudo systemctl restart estreet
```

## Notes
- **Firewall:** open 80 + 443 (Caddy needs 80 for cert issuance).
- **Multi-process fleet:** set `LOCK_BACKEND=redis` + `REDIS_URL`, run `npm install` (pulls
  the optional `redis`), so the exactly-once lock is shared across processes.
- **Secrets:** keep `.env` out of git (already in `.gitignore`); rotate
  `GOOGLE_OAUTH_CLIENT_SECRET` if it leaks.
