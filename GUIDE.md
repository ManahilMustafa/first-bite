# Run Guide

Quick steps to run the E-Street bot locally. See [README.md](README.md) for the full
picture and [CLAUDE.md](CLAUDE.md) for architecture.

## 0. Prerequisites
- Node.js **≥ 20**
- A Google Cloud project with the **Gmail API enabled**, an **OAuth client (Web)**, and
  (for live push) a **Pub/Sub topic**.

## 1. One-time setup

```bash
cp .env.example .env          # if you don't have a .env yet
# generate the encryption key and paste it into CREDS_ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Fill in `.env`:
- `CREDS_ENCRYPTION_KEY` — the key you just generated (**required**)
- `CONTROL_PLANE_TOKEN` — any strong admin token (you send it as `Authorization: Bearer …`)
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — from your OAuth client
- `GOOGLE_OAUTH_REDIRECT_URI` — keep `http://localhost:8787/oauth/google/callback`

In the Google Cloud Console, on the OAuth client add that exact URL under
**Authorized redirect URIs**, and add your Gmail under **OAuth consent screen → Test users**.

## 2. Start it

```bash
npm start                                  # backend + control plane on :8787
cd admin-dashboard && npm install && npm run dev   # dashboard on :5173
```

Open the dashboard at **http://localhost:5173** (first load asks for the admin token).

## 3. Connect the central inbox (once)

All users forward their order emails into **one** Gmail. On the dashboard **Accounts**
page click **Connect central inbox** → consent → "Connected". (It connects even before
Pub/Sub is set up — detection then runs via portal polling + the dry-run below.)

Check it:
```bash
curl -s -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" http://localhost:8787/api/gmail/status
```

## 4. Add a person

Dashboard → **Add Account**: portal login + **Forwarding Email** (the mailbox their
orders arrive at — the attribution key) + a **region** (states like `FL`/`TX`, and/or ZIP
prefixes like `32,33,34`). Or via API:

```bash
curl -X POST http://localhost:8787/api/accounts \
  -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" -H "content-type: application/json" \
  -d '{"label":"vendor-fl","portalBaseUrl":"https://<portal>","portalUsername":"u",
       "portalPassword":"p","forwardingEmail":"vendor@gmail.com","regionStates":["FL"]}'
```

## 5. Test safely (no portal actions)

Forward a real order email into the central inbox, then dry-run — it reports what it
**would** do (attribution + accept/decline) without touching any portal:

```bash
curl -s -H "Authorization: Bearer $CONTROL_PLANE_TOKEN" \
  "http://localhost:8787/api/gmail/dry-run?max=10"
```

Each order shows `attributedTo`, `decision` (`WOULD_ACCEPT` / `WOULD_DECLINE` / `SKIP`),
and `via` (which header identified the user). If a manual forward isn't matched, add
`&q=subject:"Accept or decline order"`.

## 6. Go live (push detection)

Create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` the
**Pub/Sub Publisher** role, set `GMAIL_PUBSUB_TOPIC` + `GMAIL_PUBSUB_VERIFICATION_TOKEN`
in `.env`, and add a **push subscription** to
`https://<public-host>/webhooks/gmail?token=<GMAIL_PUBSUB_VERIFICATION_TOKEN>`
(use a tunnel like ngrok for localhost). Restart — the watch registers and renews daily.

## Tests

```bash
npm test                      # full suite
node --test test/regionRouting.test.js   # one file
```
