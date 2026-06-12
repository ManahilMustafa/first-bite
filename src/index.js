// Entrypoint — wires the whole system together and starts it.
//
//   accounts store ──► orchestrator ──► one AccountWorker per active account
//                          ▲                     │
//   control plane ─────────┘            (poller + gmail) ──► lock ──► accept
//
// Run:  node src/index.js          (loads ./ .env if present)
import { AccountsStore } from './store/accountsStore.js';
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
  const lock = await createLock();

  const onResult = (event) => {
    log.info('ACCEPT EVENT', {
      orderId: event.orderId,
      accepted: event.accepted,
      via: event.via,
      outcome: event.outcome,
      account: event.account,
      ms: event.durationMs ? Math.round(event.durationMs) : undefined,
    });
    // Hook point: send a push/Slack/email notification here.
  };

  const orchestrator = new Orchestrator({ store, lock, onResult });

  // Gmail redundancy detector -> routes orders to the matching account's worker.
  const gmailWatcher = new GmailWatcher({
    oauth: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    },
    getAccount: async (emailAddress) => {
      const acct = (await store.list()).find((a) => a.gmailAddress === emailAddress && a.active);
      return acct ? { refreshToken: acct.gmailRefreshToken, historyId: acct.historyId } : null;
    },
    saveHistoryId: (email, hid) => store.saveHistoryId(email, hid),
    onOrder: (order) => {
      const worker = orchestrator.getWorkerByGmail(order.account);
      if (worker) worker.handleOrder(order);
      else log.warn('gmail order with no live worker', { account: order.account });
    },
  });

  await orchestrator.sync();

  const server = createControlPlane({ store, orchestrator, gmailWatcher });
  const port = Number(process.env.CONTROL_PLANE_PORT) || 8787;
  server.listen(port, () => log.info('control plane listening', { port }));

  const shutdown = async () => {
    log.info('shutting down');
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
