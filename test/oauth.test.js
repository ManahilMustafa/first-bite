import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoogleAuthUrl,
  encodeOAuthState,
  decodeOAuthState,
} from '../src/gmail/oauth.js';

test('buildGoogleAuthUrl includes offline access and state', () => {
  const url = buildGoogleAuthUrl({
    clientId: 'cid',
    redirectUri: 'http://localhost:8787/oauth/google/callback',
    state: 'abc',
  });
  assert.match(url, /accounts\.google\.com/);
  assert.match(url, /access_type=offline/);
  assert.match(url, /state=abc/);
});

test('encode/decode OAuth state round-trips account id', () => {
  const state = encodeOAuthState('account-123');
  const decoded = decodeOAuthState(state);
  assert.equal(decoded.accountId, 'account-123');
});
