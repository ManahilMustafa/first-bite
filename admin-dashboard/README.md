# E-Street Admin Dashboard

Minimal production-ready admin UI for the E-Street bot control plane. Consumes the existing backend APIs on port **8787** — no backend changes required.

## Stack

- React (Vite)
- Axios
- React Router

## Quick start

**1. Start the backend** (in the project root):

```bash
npm start
```

**2. Start the dashboard:**

```bash
cd admin-dashboard
cp .env.example .env
npm run dev
```

Open **http://localhost:5173** and sign in with your `CONTROL_PLANE_TOKEN`.

In development, Vite proxies `/api` and `/health` to `http://localhost:8787` — no CORS setup needed.

## Environment

| Variable | Description |
|---|---|
| `VITE_API_URL` | API base URL. Leave empty in dev (uses Vite proxy). In production, set to your backend URL. |
| `VITE_API_TOKEN` | Optional. Pre-fill the admin token; otherwise enter it on the login screen. |

## Pages

- **Dashboard** — account totals, live workers, backend health
- **Accounts** — list, activate/deactivate, delete (auto-refresh every 7s)
- **Add Account** — create account with optional region filters (`regionZipPrefixes`, `regionStates`)

## Production build

```bash
npm run build
npm run preview
```

Serve the `dist/` folder behind nginx (or similar) and proxy API requests to the control plane, **or** set `VITE_API_URL` to the backend origin and ensure CORS is handled at the reverse proxy.

## Region filters

ZIP prefixes and states are stored on the account record via `POST /api/accounts`. The dashboard displays them in the accounts table. Backend enforcement of region rules is a separate concern — this UI only captures and displays the configuration.
