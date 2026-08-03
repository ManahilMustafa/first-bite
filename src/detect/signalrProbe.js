// One-shot discovery: does this portal actually expose usable SignalR hubs
// for new-order push? Writes JSON + raw responses under data/signalr-probe/.
// Gated by production unknown #2 — libraries on the page ≠ a live order feed.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = process.env.SIGNALR_PROBE_DIR || './data/signalr-probe';

/**
 * @param {import('../portal/session.js').PortalSession} session
 * @param {object} [log]
 */
export async function probeSignalR(session, log) {
  await mkdir(OUT_DIR, { recursive: true });
  const base = session.baseUrl;
  const summary = {
    t: new Date().toISOString(),
    baseUrl: base,
    fetches: {},
    hubsFromGeneratedProxy: [],
    clientMethods: [],
    verdict: 'unknown',
  };

  const paths = [
    '/signalr/hubs',
    '/signalr/negotiate?clientProtocol=2.1',
    '/signalr/negotiate?negotiateVersion=1',
  ];

  for (const p of paths) {
    try {
      const r = await session.http.get(base + p, { followRedirects: true });
      const body = r.body || '';
      const safe = p.replace(/[^\w.-]+/g, '_');
      await writeFile(join(OUT_DIR, `${safe}.txt`), body.slice(0, 500_000));
      summary.fetches[p] = {
        status: r.status,
        len: body.length,
        url: r.url,
        redirected: !!r.redirected,
        head: body.slice(0, 400),
      };
      if (p.includes('/hubs') && r.status < 400) {
        const hubs = [...body.matchAll(/hubName:\s*["']([^"']+)["']/g)].map((m) => m[1]);
        const hubs2 = [...body.matchAll(/\.hubs\.(\w+)\s*=/g)].map((m) => m[1]);
        summary.hubsFromGeneratedProxy = [...new Set([...hubs, ...hubs2])];
        const clients = [...body.matchAll(/client:\s*\{([^}]{0,2000})\}/g)].map((m) => m[1]);
        summary.clientMethods = clients.slice(0, 5);
      }
    } catch (e) {
      summary.fetches[p] = { error: String(e) };
    }
  }

  // Page-level: scripts present vs actual /signalr/hubs <script> include.
  try {
    const dash = await session.authedGet(session.routes.newOrders);
    const html = dash.body || '';
    await writeFile(join(OUT_DIR, 'dashboard.html'), html.slice(0, 500_000));
    summary.page = {
      status: dash.status,
      hasJquerySignalR: /jquery\.signalR/i.test(html),
      hasModernSignalR: /signalr\/dist\/browser\/signalr/i.test(html),
      includesGeneratedHubsScript: /signalr\/hubs/i.test(html),
      hasHubConnectionBuilder: /HubConnectionBuilder/i.test(html),
      hasConnectionStart: /\$\.connection\.hub\.start|connection\.start\(/i.test(html),
    };
  } catch (e) {
    summary.page = { error: String(e) };
  }

  const hubsOk = summary.hubsFromGeneratedProxy.length > 0;
  const pageWires =
    summary.page &&
    (summary.page.includesGeneratedHubsScript ||
      summary.page.hasHubConnectionBuilder ||
      summary.page.hasConnectionStart);
  if (hubsOk && pageWires) summary.verdict = 'signalr_likely_usable';
  else if (hubsOk && !pageWires)
    summary.verdict = 'hubs_exist_but_dashboard_may_not_subscribe';
  else if (summary.page?.hasJquerySignalR || summary.page?.hasModernSignalR)
    summary.verdict = 'scripts_present_no_hub_proxy';
  else summary.verdict = 'no_signalr';

  await writeFile(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  log?.info?.('signalr probe complete', {
    verdict: summary.verdict,
    hubs: summary.hubsFromGeneratedProxy,
    page: summary.page,
  });
  return summary;
}

export default probeSignalR;
