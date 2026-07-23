#!/usr/bin/env node
// One-shot portal login probe using the stored Manara account.
import dns from 'node:dns';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { AccountsStore } from '../src/store/accountsStore.js';
import { GmailConnectionStore } from '../src/store/gmailConnection.js';
import { PortalSession } from '../src/portal/session.js';
import { looksLikeLogin, looksLikeOtpPage, scrapeHiddenFields } from '../src/portal/aspnet.js';
import { createGmailOtpFetcher } from '../src/portal/emailOtp.js';

// Host /etc/resolv.conf is a broken symlink (systemd stub missing). Pin the
// portal A-record we resolved via DNS-over-HTTPS so login still works.
const HOST_IPS = {
  'estreetamc.spurams.com': '172.172.189.178',
};
const origLookup = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const ip = HOST_IPS[hostname];
  if (ip) {
    if (options && options.all) return callback(null, [{ address: ip, family: 4 }]);
    return callback(null, ip, 4);
  }
  return origLookup(hostname, options, callback);
};
dns.setServers(['8.8.8.8', '1.1.1.1']);

async function loadDotEnv() {
  try {
    const txt = await readFile(new URL('../.env', import.meta.url), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* ignore */
  }
}

function formEncodeObj(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
    .join('&');
}

await loadDotEnv();

const a = (await new AccountsStore().listActive())[0];
if (!a) {
  console.error('No active account');
  process.exit(1);
}
console.log(JSON.stringify({ user: a.portalUsername, base: a.portalBaseUrl, passLen: a.portalPassword?.length }, null, 2));

const connectionStore = new GmailConnectionStore();
const fetchOtpCode = createGmailOtpFetcher({
  oauth: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  },
  getRefreshToken: async () => (await connectionStore.get())?.refreshToken || null,
});

const s = new PortalSession({
  baseUrl: a.portalBaseUrl,
  username: a.portalUsername,
  password: a.portalPassword,
  routes: a.portalRoutes,
  fields: a.portalFields,
  otpFields: a.otpFields,
  fetchOtpCode,
  label: a.label,
});

try {
  const loginUrl = s.url(s.routes.login);
  console.log('GET', loginUrl);
  const page = await s.http.get(loginUrl, { followRedirects: true });
  writeFileSync(new URL('../data/login-page.html', import.meta.url), page.body);
  console.log('page', {
    status: page.status,
    looksLogin: looksLikeLogin(page.body),
    title: (page.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim(),
  });

  const hidden = scrapeHiddenFields(page.body);
  const body = {
    ...hidden,
    [s.fields.username]: a.portalUsername,
    [s.fields.password]: a.portalPassword,
  };
  if (s.fields.submit) body[s.fields.submit] = s.fields.submitValue;

  const attemptedAt = Date.now();
  let res = await s.http.post(loginUrl, formEncodeObj(body), {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: loginUrl,
      origin: s.baseUrl,
    },
    followRedirects: true,
  });
  writeFileSync(new URL('../data/login-result.html', import.meta.url), res.body);
  console.log('afterPassword', {
    status: res.status,
    looksLogin: looksLikeLogin(res.body),
    looksOtp: looksLikeOtpPage(res.body),
    title: (res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim(),
    portalMsg: (res.body.match(/Your login attempt was not successful[^.<]*/i) || [])[0] || null,
  });

  if (looksLikeOtpPage(res.body)) {
    console.log('OTP page — waiting for Gmail code…');
    const code = await fetchOtpCode({ sentAfter: attemptedAt });
    console.log('otp', code ? `len=${String(code).length}` : null);
    if (!code) process.exit(2);
    const hidden2 = scrapeHiddenFields(res.body);
    const body2 = { ...hidden2, [s.otpFields.code]: code };
    if (s.otpFields.submit) body2[s.otpFields.submit] = s.otpFields.submitValue;
    res = await s.http.post(loginUrl, formEncodeObj(body2), {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: loginUrl,
        origin: s.baseUrl,
      },
      followRedirects: true,
    });
    writeFileSync(new URL('../data/login-after-otp.html', import.meta.url), res.body);
    console.log('afterOtp', {
      status: res.status,
      looksLogin: looksLikeLogin(res.body),
      title: (res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim(),
    });
  }

  if (!looksLikeLogin(res.body) && res.status < 400) {
    console.log('RESULT=SUCCESS');
    // Persist cookies so the main bot can resume without a fresh OTP.
    const { SessionCookieStore } = await import('../src/store/sessionCookieStore.js');
    const cookieStore = new SessionCookieStore();
    await cookieStore.save(a.id, s.http.jar.export());
    console.log('saved session cookies for', a.id);
    process.exit(0);
  }
  console.log('RESULT=FAIL');
  process.exit(1);
} catch (e) {
  console.error('RESULT=ERROR', String(e?.message || e));
  process.exit(1);
} finally {
  s.close();
}
