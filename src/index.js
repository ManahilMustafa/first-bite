// Entrypoint — wires the whole system together and starts it.
//
//   accounts store ──► orchestrator ──► one AccountWorker per active account
//                          ▲                     │
//   control plane ─────────┘            (poller + gmail) ──► lock ──► accept
//
// Run:  node src/index.js          (loads ./ .env if present)
import { AccountsStore } from './store/accountsStore.js';
import { GmailConnectionStore } from './store/gmailConnection.js';
import { OrderEventsStore } from './store/orderEventsStore.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { createLock } from './lock/lock.js';
import { GmailWatcher } from './detect/gmailWatcher.js';
import { createControlPlane } from './controlPlane/server.js';
import { logger } from './util/logger.js';

const log = logger('main');

async function loadDotEnv() {
  // Minimal .env loader (no dependency). Ignores if file absent.
  try {
    const { readFile } = await import('node:fs/promises');
    const txt = await readFile(new URL('../.env', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env, rely on real env */
  }
}

export async function main() {
  await loadDotEnv();

  const store = new AccountsStore();
  const connectionStore = new GmailConnectionStore();
  const eventsStore = new OrderEventsStore();
  const lock = await createLock();

  const onResult = (event) => {
    log.info('ORDER EVENT', {
      orderId: event.orderId,
      action: event.action,
      accepted: event.accepted,
      declined: event.declined,
      via: event.via,
      outcome: event.outcome,
      account: event.account,
      ms: event.durationMs ? Math.round(event.durationMs) : undefined,
    });
    // Persist for the dashboard orders feed + per-user statistics.
    eventsStore.record({
      accountId: event.accountId || null,
      account: event.account || null,
      orderId: event.orderId,
      source: event.source || null,
      action: event.action,
      accepted: !!event.accepted,
      declined: !!event.declined,
      outcome: event.outcome || null,
      via: event.via || null,
      forwardingEmail: event.forwardingEmail || null,
      address: event.address || null,
      state: event.state || null,
      zip: event.zip || null,
      reason: event.reason || null,
      durationMs: event.durationMs ? Math.round(event.durationMs) : null,
    });
    // Hook point: send a push/Slack/email notification here.
  };

  const orchestrator = new Orchestrator({ store, lock, onResult });

  // ONE central inbox: all users forward here. Each order is attributed to the
  // user it was forwarded from (by `forwardingEmail`) and routed to their worker,
  // which applies THAT user's region rule (accept in-region, decline otherwise).
  const gmailWatcher = new GmailWatcher({
    oauth: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    },
    getRefreshToken: async () => (await connectionStore.get())?.refreshToken || null,
    resolveUser: (address) => store.findByForwardingEmail(address),
    getHistoryId: () => connectionStore.getHistoryId(),
    saveHistoryId: (hid) => connectionStore.saveHistoryId(hid),
    onOrder: (order) => {
      // routeOrderToAccount is async (always a Promise); wrap defensively anyway.
      Promise.resolve(orchestrator.routeOrderToAccount(order.accountId, order)).catch((e) =>
        log.warn('route order failed', { err: String(e) })
      );
    },
    onUnattributed: (info) => {
      eventsStore.record({
        accountId: null,
        account: '(unattributed)',
        orderId: info.orderId,
        source: info.source || 'gmail',
        action: 'unattributed',
        accepted: false,
        declined: false,
        outcome: 'unattributed',
        via: info.via || null,
        forwardingEmail: info.forwardingEmail || null,
        address: info.address || null,
        state: info.state || null,
        zip: info.zip || null,
        reason: 'no matching forwardingEmail',
        candidates: info.candidates || [],
      });
    },
  });

  await orchestrator.sync();

  const server = createControlPlane({ store, orchestrator, gmailWatcher, connectionStore, eventsStore });
  const port = Number(process.env.CONTROL_PLANE_PORT) || 8787;
  server.listen(port, () => log.info('control plane listening', { port }));

  // The Gmail users.watch() expires after 7 days — renew it on boot and daily so
  // email detection doesn't silently die. Only extends the watch; it does NOT
  // touch the historyId cursor (that would skip messages).
  const pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC;
  // "Configured" = a real topic, not empty and not the .env placeholder.
  const pushConfigured = !!pubsubTopic && !/your-project/i.test(pubsubTopic);
  const renewWatch = async () => {
    try {
      const conn = await connectionStore.get();
      if (!conn?.refreshToken) return;
      const accessToken = await gmailWatcher.accessTokenFor(conn.refreshToken);
      const watch = await gmailWatcher.registerWatch(accessToken, pubsubTopic);
      await connectionStore.saveWatch({ expiration: watch.expiration });
      log.info('gmail watch renewed', { expiration: watch.expiration });
    } catch (e) {
      log.warn('gmail watch renewal failed', { err: String(e) });
    }
  };
  let watchTimer = null;
  if (pushConfigured) {
    renewWatch();
    watchTimer = setInterval(renewWatch, 24 * 60 * 60 * 1000);
    watchTimer.unref?.();
  } else {
    log.info('gmail push (Pub/Sub) not configured — detection via poll loop only');
  }

  // Gmail poll loop — fetches new forwarded orders from the central inbox on a
  // timer. This is the detection path when there's no Pub/Sub push (no public
  // webhook). No-ops until the inbox is connected; overlap-guarded.
  // Gmail API quota + the inherent seconds-latency of email/forwarding make
  // sub-second polling pointless and rate-limit-prone — floor it.
  const GMAIL_POLL_FLOOR_MS = 1000;
  let gmailPollMs = Number(process.env.GMAIL_POLL_INTERVAL_MS) || 15000;
  if (gmailPollMs < GMAIL_POLL_FLOOR_MS) {
    log.warn('GMAIL_POLL_INTERVAL_MS below safe floor — clamping', {
      requested: gmailPollMs,
      floor: GMAIL_POLL_FLOOR_MS,
    });
    gmailPollMs = GMAIL_POLL_FLOOR_MS;
  }
  let gmailPolling = false;
  const gmailPollTimer = setInterval(async () => {
    if (gmailPolling) return;
    gmailPolling = true;
    try {
      const r = await gmailWatcher.poll();
      if (r.handled || r.unattributed) log.info('gmail poll', r);
    } catch (e) {
      log.warn('gmail poll failed', { err: String(e) });
    } finally {
      gmailPolling = false;
    }
  }, gmailPollMs);
  gmailPollTimer.unref?.();
  log.info('gmail poll loop started', { intervalMs: gmailPollMs });

  const shutdown = async () => {
    log.info('shutting down');
    if (watchTimer) clearInterval(watchTimer);
    clearInterval(gmailPollTimer);
    server.close();
    await orchestrator.shutdown();
    await lock.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { store, lock, orchestrator, gmailWatcher, server };
}

// Run only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.js')) {
  main().catch((e) => {
    log.error('fatal', { err: String(e) });
    process.exit(1);
  });
}

export default main;
