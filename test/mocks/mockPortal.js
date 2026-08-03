// Faithful-enough mock of the E-Street / ValueLink ASP.NET WebForms portal.
//
// Models the behaviours the bot actually depends on:
//   - Login page issues __VIEWSTATE + __EVENTVALIDATION; POST /login validates
//     credentials and sets an ASP.NET_SessionId cookie.
//   - New Orders page (auth-gated; 302 -> login otherwise) lists available
//     orders, each row carrying its id and an Accept __doPostBack link, plus
//     fresh state tokens that the server validates on postback.
//   - Accept (postback OR email link) is ATOMIC and first-come-first-served:
//     the first acceptor wins; everyone else gets "no longer available".
//   - Email accept link mode is toggleable: 'standalone' (self-contained GET
//     that accepts) or 'needs_login' (bounces to login) — this models the key
//     unverified unknown about the real portal.
//   - Status page for the verifier.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

export class MockPortal {
  constructor({ username = 'vendor1', password = 'pass1', emailLinkMode = 'standalone' } = {}) {
    this.users = new Map([[username, password]]); // username -> password
    this.emailLinkMode = emailLinkMode; // 'standalone' | 'needs_login' | 'needs_login_once' | 'two_step'
    // Portal list Accept/Decline: 'standalone' = one click settles; 'two_step' =
    // list click opens the confirmation page (same as the email link), and only
    // the second Accept/Decline on that page assigns/removes the order.
    this.portalAcceptMode = 'standalone';
    this.portalDeclineMode = 'standalone';
    this.orders = new Map(); // id -> { id, status, acceptedBy, address }
    this.sessions = new Map(); // sessionId -> username
    this.issuedViewstate = new Set();
    this.issuedEventval = new Set();
    this.orderTokens = new Map(); // id -> email-link token
    this.requests = []; // {method, path, ts} for assertions
    this.acceptAttempts = []; // {via, orderId, won}
    this.emailOtpRequired = false; // simulate the real deployment's mandatory email-OTP step
    this.otpCode = '123456';
    this.pendingAuth = new Map(); // pending-auth cookie -> username (post-password, pre-OTP)
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('mock error: ' + String(e));
      });
    });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address();
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve(this.baseUrl);
      });
    });
  }
  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  // ── test helpers ──────────────────────────────────────────────────────────--
  addUser(username, password) {
    this.users.set(username, password);
  }
  addOrder(id, { address = '8140 NIGHTINGALE RD WEEKI WACHEE FL 34613', emailOwner } = {}) {
    this.orders.set(id, { id, status: 'available', acceptedBy: null, address });
    if (!this.orderTokens.has(id)) {
      // The email accept link is tokenized to a specific vendor (the recipient).
      const owner = emailOwner || [...this.users.keys()][0];
      this.orderTokens.set(id, { token: randomUUID(), user: owner });
    }
    return id;
  }
  emailAcceptUrl(id) {
    return `${this.baseUrl}/accept.aspx?order=${encodeURIComponent(id)}&token=${this.orderTokens.get(id).token}`;
  }
  emailDeclineUrl(id) {
    return `${this.baseUrl}/decline.aspx?order=${encodeURIComponent(id)}&token=${this.orderTokens.get(id).token}`;
  }
  orderStatus(id) {
    return this.orders.get(id)?.status;
  }
  reset() {
    this.orders.clear();
    this.sessions.clear();
    this.pendingAuth.clear();
    this.requests.length = 0;
    this.acceptAttempts.length = 0;
    this.emailOtpRequired = false;
    this.portalAcceptMode = 'standalone';
    this.portalDeclineMode = 'standalone';
  }

  // ── core: atomic accept ───────────────────────────────────────────────────--
  _tryAccept(id, who, via) {
    const order = this.orders.get(id);
    if (!order) {
      this.acceptAttempts.push({ via, orderId: id, won: false, reason: 'not_found' });
      return { ok: false, reason: 'not_found' };
    }
    if (order.status === 'accepted') {
      this.acceptAttempts.push({ via, orderId: id, won: false, reason: 'taken' });
      return { ok: false, reason: 'taken' };
    }
    order.status = 'accepted'; // single-threaded => atomic critical section
    order.acceptedBy = who;
    order.acceptedVia = via;
    this.acceptAttempts.push({ via, orderId: id, won: true });
    return { ok: true };
  }

  // ── core: decline ───────────────────────────────────────────────────────────
  _tryDecline(id, who, via) {
    const order = this.orders.get(id);
    if (!order) {
      this.acceptAttempts.push({ via, orderId: id, won: false, reason: 'not_found', action: 'decline' });
      return { ok: false, reason: 'not_found' };
    }
    if (order.status === 'accepted') {
      // Already taken by someone — nothing to decline.
      this.acceptAttempts.push({ via, orderId: id, won: false, reason: 'taken', action: 'decline' });
      return { ok: false, reason: 'taken' };
    }
    order.status = 'declined';
    order.declinedBy = who;
    order.declinedVia = via;
    this.acceptAttempts.push({ via, orderId: id, won: true, action: 'decline' });
    return { ok: true };
  }

  // ── request router ────────────────────────────────────────────────────────--
  async _handle(req, res) {
    const u = new URL(req.url, this.baseUrl);
    const path = u.pathname;
    this.requests.push({ method: req.method, path, ts: Date.now() });
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies['ASP.NET_SessionId'];
    const sessionUser = sid ? this.sessions.get(sid) : undefined;
    const authed = !!sessionUser;

    // Login page
    if (path === '/login.aspx' && req.method === 'GET') {
      return html(res, 200, this._loginPage());
    }
    if (path === '/login.aspx' && req.method === 'POST') {
      const body = await readForm(req);
      // Step 2 of 2 (same URL as the real portal): the OTP code, not credentials.
      if (body['ctl00$cphBody$txtUserCode'] !== undefined) {
        const pendingId = cookies['PendingAuth'];
        const pendingUser = pendingId ? this.pendingAuth.get(pendingId) : null;
        if (!pendingUser || body['ctl00$cphBody$txtUserCode'] !== this.otpCode) {
          return html(res, 200, this._loginPage('Invalid credentials.'));
        }
        this.pendingAuth.delete(pendingId);
        const newSid = randomUUID();
        this.sessions.set(newSid, pendingUser);
        res.writeHead(302, {
          'set-cookie': [
            `ASP.NET_SessionId=${newSid}; path=/; HttpOnly`,
            'PendingAuth=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/',
          ],
          location: '/AppraiserDashboard.aspx',
        });
        return res.end();
      }
      const user = body['ctl00$cphBody$Login1$UserName'];
      const pass = body['ctl00$cphBody$Login1$Password'];
      if (this.users.has(user) && this.users.get(user) === pass) {
        if (this.emailOtpRequired) {
          const pendingId = randomUUID();
          this.pendingAuth.set(pendingId, user);
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `PendingAuth=${pendingId}; path=/; HttpOnly`,
          });
          return res.end(this._otpPage());
        }
        const newSid = randomUUID();
        this.sessions.set(newSid, user);
        res.writeHead(302, {
          'set-cookie': `ASP.NET_SessionId=${newSid}; path=/; HttpOnly`,
          location: '/AppraiserDashboard.aspx',
        });
        return res.end();
      }
      return html(res, 200, this._loginPage('Invalid credentials.'));
    }

    // New Orders page (auth-gated)
    if (path === '/AppraiserDashboard.aspx' && req.method === 'GET') {
      if (!authed) return redirectToLogin(res);
      return html(res, 200, this._newOrdersPage());
    }
    if (path === '/AppraiserDashboard.aspx' && req.method === 'POST') {
      if (!authed) return redirectToLogin(res);
      const body = await readForm(req);
      // Validate WebForms state tokens (faithful: reject forged/stale tokens).
      if (!this.issuedViewstate.has(body.__VIEWSTATE) || !this.issuedEventval.has(body.__EVENTVALIDATION)) {
        return html(res, 200, this._messagePage('Your session has expired. Please refresh.'));
      }
      // type=image clicks post name.x / name.y instead of __EVENTTARGET.
      const imageTarget = Object.keys(body).find((k) => k.endsWith('.x'))?.slice(0, -2) || '';
      const target = body.__EVENTTARGET || imageTarget;
      const orderId = body.__EVENTARGUMENT || extractOrderFromTarget(target);
      if (/ShowInProgress|lnkShowInProgress/i.test(target || '')) {
        return html(res, 200, this._inProgressPage(sessionUser));
      }
      // Test hook: simulate a rival accepting between this client's GET and POST.
      if (this._onBeforeAccept) {
        const hook = this._onBeforeAccept;
        this._onBeforeAccept = null;
        hook(orderId);
      }
      if (/decline|reject/i.test(target)) {
        if (this.portalDeclineMode === 'two_step') {
          const order = this.orders.get(orderId);
          if (!order) return html(res, 200, this._messagePage(`Order ${orderId} not found.`));
          if (order.status === 'accepted')
            return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
          return html(res, 200, this._orderDetailsPage(orderId, order.address, { acceptLabel: 'Accept Order' }));
        }
        const d = this._tryDecline(orderId, sessionUser, 'portal');
        if (d.ok) return html(res, 200, this._messagePage(`Order ${orderId} declined.`));
        if (d.reason === 'taken')
          return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
        return html(res, 200, this._messagePage(`Order ${orderId} not found.`));
      }
      if (this.portalAcceptMode === 'two_step') {
        const order = this.orders.get(orderId);
        if (!order) return html(res, 200, this._messagePage(`Order ${orderId} not found.`));
        if (order.status === 'accepted')
          return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
        return html(res, 200, this._orderDetailsPage(orderId, order.address, { acceptLabel: 'Accept Appraisal' }));
      }
      const r = this._tryAccept(orderId, sessionUser, 'portal');
      if (r.ok) return html(res, 200, this._acceptSuccessPage(orderId));
      if (r.reason === 'taken')
        return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
      return html(res, 200, this._messagePage(`Order ${orderId} not found.`));
    }

    // Email accept link
    if (path === '/accept.aspx' && req.method === 'GET') {
      const id = u.searchParams.get('order');
      const token = u.searchParams.get('token');
      if (this.emailLinkMode === 'needs_login') return redirectToLogin(res);
      // Models a transient session expiry: bounces exactly once, then behaves
      // like 'standalone' (i.e. the retry-after-re-login should succeed).
      if (this.emailLinkMode === 'needs_login_once') {
        this.emailLinkMode = 'standalone';
        return redirectToLogin(res);
      }
      const rec = this.orderTokens.get(id);
      if (!rec || token !== rec.token) return html(res, 403, this._messagePage('Invalid token.'));
      if (this.emailLinkMode === 'two_step') {
        const order = this.orders.get(id);
        if (!order) return html(res, 404, this._messagePage(`Order ${id} not found.`));
        if (order.status === 'accepted') {
          return html(res, 200, this._messagePage(`Order ${id} is no longer available.`));
        }
        return html(res, 200, this._orderDetailsPage(id, order.address, { acceptLabel: 'Accept Order' }));
      }
      const r = this._tryAccept(id, rec.user, 'email');
      if (r.ok) return html(res, 200, this._acceptSuccessPage(id));
      if (r.reason === 'taken') return html(res, 200, this._messagePage(`Order ${id} is no longer available.`));
      return html(res, 404, this._messagePage(`Order ${id} not found.`));
    }
    if (path === '/accept.aspx' && req.method === 'POST') {
      const body = await readForm(req);
      if (!this.issuedViewstate.has(body.__VIEWSTATE) || !this.issuedEventval.has(body.__EVENTVALIDATION)) {
        return html(res, 200, this._messagePage('Your session has expired. Please refresh.'));
      }
      const imageTarget = Object.keys(body).find((k) => k.endsWith('.x'))?.slice(0, -2) || '';
      const target = body.__EVENTTARGET || imageTarget || Object.keys(body).find((k) => /accept/i.test(k)) || '';
      const orderId =
        body.__EVENTARGUMENT || extractOrderFromTarget(target) || extractOrderFromTarget(JSON.stringify(body));
      // Prefer email-token vendor, then the logged-in session (portal two-step confirm).
      const rec = this.orderTokens.get(orderId);
      const who = rec?.user || sessionUser || 'email';
      const via = sessionUser && !rec ? 'portal_two_step' : 'email_two_step';
      const r = this._tryAccept(orderId, who, via);
      if (r.ok) return html(res, 200, this._acceptSuccessPage(orderId));
      if (r.reason === 'taken') return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
      return html(res, 404, this._messagePage(`Order ${orderId} not found.`));
    }

    // Email decline link
    if (path === '/decline.aspx' && req.method === 'GET') {
      const id = u.searchParams.get('order');
      const token = u.searchParams.get('token');
      if (this.emailLinkMode === 'needs_login') return redirectToLogin(res);
      if (this.emailLinkMode === 'needs_login_once') {
        this.emailLinkMode = 'standalone';
        return redirectToLogin(res);
      }
      const rec = this.orderTokens.get(id);
      if (!rec || token !== rec.token) return html(res, 403, this._messagePage('Invalid token.'));
      const r = this._tryDecline(id, rec.user, 'email');
      if (r.ok) return html(res, 200, this._messagePage(`Order ${id} declined. Thank you.`));
      if (r.reason === 'taken') return html(res, 200, this._messagePage(`Order ${id} is no longer available.`));
      return html(res, 404, this._messagePage(`Order ${id} not found.`));
    }
    // Confirmation-page Decline POST (email two-step or portal list → details).
    if (path === '/decline.aspx' && req.method === 'POST') {
      if (!authed) return redirectToLogin(res);
      const body = await readForm(req);
      if (!this.issuedViewstate.has(body.__VIEWSTATE) || !this.issuedEventval.has(body.__EVENTVALIDATION)) {
        return html(res, 200, this._messagePage('Your session has expired. Please refresh.'));
      }
      const target = body.__EVENTTARGET || Object.keys(body).find((k) => /decline|reject/i.test(k)) || '';
      const orderId =
        body.__EVENTARGUMENT || extractOrderFromTarget(target) || extractOrderFromTarget(JSON.stringify(body));
      const r = this._tryDecline(orderId, sessionUser || 'email', sessionUser ? 'portal_two_step' : 'email_two_step');
      if (r.ok) return html(res, 200, this._messagePage(`Order ${orderId} declined.`));
      if (r.reason === 'taken')
        return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
      return html(res, 404, this._messagePage(`Order ${orderId} not found.`));
    }

    // Status page (verifier)
    if (path === '/Orders/OrderStatus.aspx' && req.method === 'GET') {
      if (!authed) return redirectToLogin(res);
      const id = u.searchParams.get('order');
      const order = this.orders.get(id);
      if (!order) return html(res, 200, this._messagePage(`Order ${id} not found.`));
      if (order.status === 'accepted') {
        // Per-vendor view: the winner sees "in progress"; everyone else sees taken.
        const msg =
          order.acceptedBy === sessionUser
            ? `Order ${id} accepted by vendor. In progress.`
            : `Order ${id} assigned to another vendor.`;
        return html(res, 200, this._messagePage(msg));
      }
      return html(res, 200, this._messagePage(`Order ${id} available, pending acceptance.`));
    }

    if (path === '/') return html(res, 200, '<html><body>E-Street Portal</body></html>');
    return html(res, 404, this._messagePage('Not found'));
  }

  // ── page renderers ────────────────────────────────────────────────────────--
  _stateFields() {
    const vs = 'VS_' + randomUUID();
    const ev = 'EV_' + randomUUID();
    this.issuedViewstate.add(vs);
    this.issuedEventval.add(ev);
    return `
      <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${vs}" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="ABC123" />
      <input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="${ev}" />
      <input type="hidden" name="__EVENTTARGET" id="__EVENTTARGET" value="" />
      <input type="hidden" name="__EVENTARGUMENT" id="__EVENTARGUMENT" value="" />`;
  }

  _loginPage(error = '') {
    return `<!DOCTYPE html><html><head><title>Log In - E-Street</title></head><body>
      <form method="post" action="/login.aspx">
        ${this._stateFields()}
        ${error ? `<div class="error">${error}</div>` : ''}
        <label>User Name</label>
        <input type="text" name="ctl00$cphBody$Login1$UserName" />
        <label>Password</label>
        <input type="password" name="ctl00$cphBody$Login1$Password" />
        <a href="/Account/Forgot.aspx">Forgot your password?</a>
        <input type="submit" name="ctl00$cphBody$Login1$LoginButton" value="Log In" />
      </form></body></html>`;
  }

  _otpPage() {
    return `<!DOCTYPE html><html><head><title>Log In - E-Street</title></head><body>
      <form method="post" action="/login.aspx">
        ${this._stateFields()}
        <p>We have sent a 6 digit verification code to your registered email address.</p>
        <input type="text" name="ctl00$cphBody$txtUserCode" maxlength="6" placeholder="Enter 6 digit code" />
        <input type="submit" name="ctl00$cphBody$btnVerifyLogin" value="Verify" />
      </form></body></html>`;
  }

  _newOrdersPage() {
    const available = [...this.orders.values()].filter((o) => o.status === 'available');
    const rows = available
      .map(
        (o, i) => {
          // Mirror the real E-Street dashboard: Accept/Decline are type=image
          // ticks (imgBtnBroadcastAccept / imgBtnDecline), not text links.
          // Order id is embedded in the control name so the POST (.x/.y) can
          // resolve which row was clicked without a separate EVENTARGUMENT.
          const ctl = String(i + 2).padStart(2, '0');
          const acceptName = `ctl00$cphBody$grdNewOrders$ctl${ctl}$imgBtnBroadcastAccept$${o.id}`;
          const declineName = `ctl00$cphBody$grdNewOrders$ctl${ctl}$imgBtnDecline$${o.id}`;
          return `
      <tr class="order-row">
        <td class="order-no">Order no. ${o.id}</td>
        <td class="address">${o.address}</td>
        <td>
          <input type="image" name="${acceptName}" id="${acceptName.replace(/\$/g, '_')}"
                 title="Click here to accept this order" src="../images/appraiser-tick.png" />
          <input type="image" name="${declineName}" id="${declineName.replace(/\$/g, '_')}"
                 title="Click here to decline this order" src="../images/appraiser-block.png" />
        </td>
      </tr>`;
        }
      )
      .join('\n');
    return `<!DOCTYPE html><html><head><title>New Orders - E-Street</title></head><body>
      <h1>New Orders</h1>
      <!-- Nav chrome deliberately contains "Accepted"/"In Progress" substrings
           (like the real portal) so a naive verifier regex would false-positive. -->
      <a id="ctl00_cphBody_lnkCondAcceptedOrders" href="javascript:__doPostBack('ctl00$cphBody$lnkCondAcceptedOrders','')">Conditionally Accepted Orders</a>
      <a id="ctl00_cphBody_lnkShowInProgressOrders" href="javascript:__doPostBack('ctl00$cphBody$lnkShowInProgressOrders','')">In Progress Orders</a>
      <form method="post" action="/AppraiserDashboard.aspx">
        ${this._stateFields()}
        <table id="gvOrders"><tbody>
          ${rows || '<tr><td>No new orders.</td></tr>'}
        </tbody></table>
      </form></body></html>`;
  }

  _messagePage(msg) {
    return `<!DOCTYPE html><html><head><title>E-Street</title></head><body>
      <div id="message">${msg}</div></body></html>`;
  }

  _inProgressPage(sessionUser) {
    const mine = [...this.orders.values()].filter((o) => o.status === 'accepted' && o.acceptedBy === sessionUser);
    const rows = mine
      .map(
        (o) => `<tr><td>Order no. ${o.id}</td><td>${o.address}</td><td>Accepted by Vendor</td><td>In Progress</td></tr>`
      )
      .join('\n');
    return `<!DOCTYPE html><html><head><title>In Progress Orders - E-Street</title></head><body>
      <h1>In Progress Orders</h1>
      <form method="post" action="/AppraiserDashboard.aspx">${this._stateFields()}
      <table>${rows || '<tr><td>No orders in progress.</td></tr>'}</table>
      </form></body></html>`;
  }

  /** Post-accept success — models the green badge the Gmail path shows. */
  _acceptSuccessPage(orderId) {
    return `<!DOCTYPE html><html><head><title>E-Street</title></head><body>
      <div class="alert alert-success badge-success">You have successfully accepted this order.</div>
      <div id="message">Order ${orderId} accepted. Assigned to you.</div>
    </body></html>`;
  }

  /**
   * Confirmation / order-details page — same UI whether the vendor arrived via
   * the email Accept/Decline link or via a New Orders list tick (step 1 of 2).
   * Gmail path uses "Accept Order"; portal path uses "Accept Appraisal".
   */
  _orderDetailsPage(orderId, address = '123 Test St', { acceptLabel = 'Accept Order' } = {}) {
    return `<!DOCTYPE html><html><head><title>ACCEPT ORDER</title></head><body>
      <h1>ACCEPT ORDER</h1>
      <p>Order no. ${orderId}</p>
      <p>Property Address: ${address}</p>
      <form method="post" action="/accept.aspx">
        ${this._stateFields()}
        <input type="hidden" name="__EVENTARGUMENT" value="${orderId}" />
        <input type="submit" name="ctl00$MainContent$btnAccept" value="${acceptLabel}" style="color:green" />
        <a href="javascript:__doPostBack('ctl00$MainContent$btnAccept','${orderId}')">${acceptLabel}</a>
        <input type="submit" name="ctl00$MainContent$btnDecline" value="Decline" formaction="/decline.aspx" />
        <a href="javascript:__doPostBack('ctl00$MainContent$btnDecline','${orderId}')">Decline</a>
      </form></body></html>`;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────--
function redirectToLogin(res) {
  res.writeHead(302, { location: '/login.aspx' });
  res.end();
}
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function extractOrderFromTarget(target = '') {
  const m = target.match(/(\d{2,4}-\d{4,6})/);
  return m ? m[1] : null;
}
function readForm(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const out = {};
      for (const pair of raw.split('&')) {
        if (!pair) continue;
        const i = pair.indexOf('=');
        const k = decodeURIComponent(pair.slice(0, i).replace(/\+/g, ' '));
        const v = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        out[k] = v;
      }
      resolve(out);
    });
    req.on('error', reject);
  });
}

export default MockPortal;
