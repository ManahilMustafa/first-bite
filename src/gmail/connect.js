// Wire a Gmail refresh token: profile lookup + Pub/Sub watch registration.

import { logger } from '../util/logger.js';

const log = logger('gmail-connect');

/**
 * Connect the ONE central inbox that all users forward into. Persists the
 * refresh token + central email + historyId to the GmailConnectionStore and
 * registers the users.watch() push subscription.
 */
export async function connectCentralGmail({ connectionStore, gmailWatcher, refreshToken, topicName }) {
  if (!gmailWatcher?.oauth?.clientId) throw new Error('Gmail OAuth not configured');

  const accessToken = await gmailWatcher.accessTokenFor(refreshToken);
  const profile = await gmailWatcher.getProfile(accessToken);

  // Register the Pub/Sub watch if a topic is configured, but DON'T fail the whole
  // connection if it can't (topic missing/misconfigured). Without a watch there
  // are no push notifications — detection then relies on the per-user portal
  // pollers and the manual dry-run — but the token is stored so attribution /
  // region / decline can be exercised immediately.
  let watch = null;
  const pushConfigured = !!topicName && !/your-project/i.test(topicName);
  if (pushConfigured) {
    try {
      watch = await gmailWatcher.registerWatch(accessToken, topicName);
    } catch (e) {
      log.warn('gmail watch registration failed — connected WITHOUT push', { err: String(e) });
    }
  } else {
    log.info('GMAIL_PUBSUB_TOPIC not configured — connected; detection via poll loop only');
  }

  // Seed the cursor from the watch if we got one, else from the mailbox profile.
  const historyId = String(watch?.historyId || profile.historyId);
  await connectionStore.save({
    emailAddress: profile.emailAddress,
    refreshToken,
    historyId,
    watchExpiration: watch?.expiration ? Number(watch.expiration) : undefined,
    updatedAt: new Date().toISOString(),
  });

  log.info('central gmail connected', { email: profile.emailAddress, historyId, push: !!watch });

  return {
    emailAddress: profile.emailAddress,
    historyId,
    watchExpiration: watch?.expiration,
    push: !!watch,
  };
}

export default connectCentralGmail;
