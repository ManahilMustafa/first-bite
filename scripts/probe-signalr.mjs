#!/usr/bin/env node
// One-shot: login + dump SignalR hub metadata from the live portal.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { AccountsStore } from '../src/store/accountsStore.js';
import { SessionCookieStore } from '../src/store/sessionCookieStore.js';
import { PortalSession } from '../src/portal/session.js';
import { resolveKey } from '../src/util/crypto.js';

async function loadEnv() {
  const txt = await readFile(new URL('../.env', import.meta.url), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  await loadEnv();
  const key = resolveKey(process.env.CREDS_ENCRYPTION_KEY);
  const store = new AccountsStore({ path: process.env.ACCOUNTS_STORE, key });
  const accounts = await store.list();
  const acc = accounts.find((a) => a.active !== false) || accounts[0];
  if (!acc) throw new Error('no account');

  const cookieStore = new SessionCookieStore({
    path: process.env.SESSION_COOKIE_STORE || './data/sessions.enc.json',
    key,
  });
  const session = new PortalSession({
    baseUrl: acc.portalBaseUrl,
    username: acc.portalUsername,
    password: acc.portalPassword,
    routes: acc.portalRoutes,
    fields: acc.portalFields,
    otpFields: acc.otpFields,
    cookieStore,
    accountId: acc.id,
    label: acc.label,
  });

  await session.login();
  const dash = await session.authedGet(session.routes.newOrders);
  await mkdir('./data/signalr-probe', { recursive: true });
  await writeFile('./data/signalr-probe/dashboard.html', dash.body || '');

  const base = session.baseUrl;
  const out = { dashStatus: dash.status, dashLen: (dash.body || '').length, fetches: {} };

  for (const p of [
    '/signalr/hubs',
    '/signalr/negotiate?clientProtocol=2.1',
    '/signalr/negotiate?negotiateVersion=1',
    '/NavResources/Scripts/main.js',
    '/NavResources/Scripts/plugins.js',
    '/Scripts/ResponsiveHeader.js?version=19.7.0.1',
  ]) {
    try {
      const r = await session.http.get(base + p, { followRedirects: true });
      const body = r.body || '';
      const safe = p.replace(/[^\w.-]+/g, '_');
      await writeFile(`./data/signalr-probe/${safe}.txt`, body.slice(0, 500_000));
      out.fetches[p] = { status: r.status, len: body.length, url: r.url, head: body.slice(0, 500) };
    } catch (e) {
      out.fetches[p] = { error: String(e) };
    }
  }

  // Pull ScriptResource.axd URLs from dashboard that might contain hub wiring.
  const srcs = [...(dash.body || '').matchAll(/src=["']([^"']*ScriptResource\.axd[^"']*)["']/gi)].map((m) => m[1]);
  out.scriptResourceCount = srcs.length;
  let found = [];
  for (const src of srcs.slice(0, 12)) {
    const url = src.startsWith('http') ? src : new URL(src.replace(/&amp;/g, '&'), base + '/').toString();
    try {
      const r = await session.http.get(url, { followRedirects: true });
      const body = r.body || '';
      if (/signalr|createHubProxy|HubConnection|\$\.connection\./i.test(body)) {
        const name = `script_${found.length}.js`;
        await writeFile(`./data/signalr-probe/${name}`, body.slice(0, 500_000));
        found.push({ url: url.slice(0, 120), len: body.length, file: name });
      }
    } catch {
      /* ignore */
    }
  }
  out.signalrScriptResources = found;

  await writeFile('./data/signalr-probe/summary.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  session.close();
}

main().catch((e) => {
  console.error('PROBE_FAIL', e);
  process.exit(1);
});
