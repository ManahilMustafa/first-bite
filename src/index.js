// Entrypoint — wires the whole system together and starts it.
//
//   accounts store ──► orchestrator ──► one AccountWorker per active account
//                          ▲                     │
//   control plane ─────────┘            (poller + gmail) ──► lock ──► accept
//
// Run:  node src/index.js          (loads ./ .env if present)
import dns from 'node:dns';
import { AccountsStore } from './store/accountsStore.js';
import { GmailConnectionStore } from './store/gmailConnection.js';
import { OrderEventsStore } from './store/orderEventsStore.js';
import { SessionCookieStore } from './store/sessionCookieStore.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { AccountWorker } from './worker/worker.js';
import { createLock } from './lock/lock.js';
import { GmailWatcher } from './detect/gmailWatcher.js';
import { createGmailOtpFetcher } from './portal/emailOtp.js';
import { createControlPlane } from './controlPlane/server.js';
import { logger } from './util/logger.js';

const log = logger('main');

// If /etc/resolv.conf is broken (missing systemd stub), pin known hosts so the
// bot can still reach the portal. Overridable via PORTAL_HOST_IP.
const PORTAL_HOST = 'estreetamc.spurams.com';
const PORTAL_IP = process.env.PORTAL_HOST_IP || '172.172.189.178';
const _lookup = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (hostname === PORTAL_HOST) {
    if (options?.all) return callback(null, [{ address: PORTAL_IP, family: 4 }]);
    return callback(null, PORTAL_IP, 4);
  }
  return _lookup(hostname, options, callback);
};
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '9.9.9.9']);
} catch {
  /* ignore */
}

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
  const cookieStore = new SessionCookieStore();
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
      // Per-strategy detail (what each of Path A/B actually returned) — kept so a
      // masked failure (e.g. one path errors, the other bounces) is diagnosable
      // from the feed alone instead of requiring live log access.
      paths: event.paths || null,
      // Full stage-by-stage latency breakdown (see src/util/latencyReport.js) —
      // real production evidence for where time is actually going, not a guess.
      detectedAt: event.detectedAt || null,
      detectionLatencyMs: event.detectionLatencyMs ?? null,
      lockWaitMs: event.lockWaitMs ?? null,
      verifyDurationMs: event.verifyDurationMs != null ? Math.round(event.verifyDurationMs) : null,
      totalMs: event.totalMs ?? null,
      // Real live activity, never a preview — always shown in the live dashboard.
      dryRun: false,
    });
    // Hook point: send a push/Slack/email notification here.
  };

  // Some portal deployments require a 6-digit email code on every login (no
  // "remember this device"). Rick's forward rule relays that code into the same
  // central inbox the order detector watches, so we read it from there too.
  const fetchOtpCode = createGmailOtpFetcher({
    oauth: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    },
    getRefreshToken: async () => (await connectionStore.get())?.refreshToken || null,
  });

  const orchestrator = new Orchestrator({
    store,
    lock,
    onResult,
    startRetryCooldownMs: Number(process.env.WORKER_START_RETRY_COOLDOWN_MS) || undefined,
    workerFactory: (account) => new AccountWorker({ account, lock, onResult, fetchOtpCode, cookieStore }),
  });

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
        // A real live email that arrived and couldn't be matched — not a preview.
        dryRun: false,
      });
    },
  });

  await orchestrator.sync();

  // Discover whether SignalR can replace/augment portal polling (unknown #2).
  // Non-blocking for boot: failures only log; poller stays primary until wired.
  try {
    const { probeSignalR } = await import('./detect/signalrProbe.js');
    const anyWorker = [...orchestrator.workers.values()][0];
    if (anyWorker?.session) {
      probeSignalR(anyWorker.session, log.child('signalr-probe')).catch((e) =>
        log.warn('signalr probe failed', { err: String(e) })
      );
    } else {
      log.info('signalr probe skipped — no live worker session yet');
    }
  } catch (e) {
    log.warn('signalr probe import failed', { err: String(e) });
  }

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
  // Gmail API quota + email/forwarding latency: allow 500ms floor for FCFS
  // races; override with GMAIL_POLL_FLOOR_MS if needed.
  const GMAIL_POLL_FLOOR_MS = Number(process.env.GMAIL_POLL_FLOOR_MS) || 500;
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
