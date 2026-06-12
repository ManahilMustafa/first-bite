// Wire a Gmail refresh token to an account: profile lookup + Pub/Sub watch registration.

import { logger } from '../util/logger.js';

const log = logger('gmail-connect');

/**
 * After OAuth (or manual token paste), persist gmailAddress + historyId and
 * register the users.watch() push subscription.
 */
export async function connectGmailAccount({ store, gmailWatcher, accountId, refreshToken, topicName }) {
  if (!gmailWatcher?.oauth?.clientId) throw new Error('Gmail OAuth not configured');
  if (!topicName) throw new Error('GMAIL_PUBSUB_TOPIC not configured');

  const account = await store.get(accountId);
  if (!account) throw new Error(`account not found: ${accountId}`);

  const accessToken = await gmailWatcher.accessTokenFor(refreshToken);
  const profile = await gmailWatcher.getProfile(accessToken);
  const watch = await gmailWatcher.registerWatch(accessToken, topicName);

  await store.upsert({
    ...account,
    gmailRefreshToken: refreshToken,
    gmailAddress: profile.emailAddress,
    historyId: String(watch.historyId),
  });

  log.info('gmail connected', {
    accountId,
    email: profile.emailAddress,
    historyId: watch.historyId,
    watchExpires: watch.expiration,
  });

  return {
    emailAddress: profile.emailAddress,
    historyId: String(watch.historyId),
    watchExpiration: watch.expiration,
  };
}

export default connectGmailAccount;
