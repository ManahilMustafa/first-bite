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
    this.emailLinkMode = emailLinkMode; // 'standalone' | 'needs_login' | 'two_step'
    this.orders = new Map(); // id -> { id, status, acceptedBy, address }
    this.sessions = new Map(); // sessionId -> username
    this.issuedViewstate = new Set();
    this.issuedEventval = new Set();
    this.orderTokens = new Map(); // id -> email-link token
    this.requests = []; // {method, path, ts} for assertions
    this.acceptAttempts = []; // {via, orderId, won}
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
  orderStatus(id) {
    return this.orders.get(id)?.status;
  }
  reset() {
    this.orders.clear();
    this.sessions.clear();
    this.requests.length = 0;
    this.acceptAttempts.length = 0;
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
    if (path === '/Account/Login.aspx' && req.method === 'GET') {
      return html(res, 200, this._loginPage());
    }
    if (path === '/Account/Login.aspx' && req.method === 'POST') {
      const body = await readForm(req);
      const user = body['ctl00$MainContent$txtUsername'];
      const pass = body['ctl00$MainContent$txtPassword'];
      if (this.users.has(user) && this.users.get(user) === pass) {
        const newSid = randomUUID();
        this.sessions.set(newSid, user);
        res.writeHead(302, {
          'set-cookie': `ASP.NET_SessionId=${newSid}; path=/; HttpOnly`,
          location: '/Orders/NewOrders.aspx',
        });
        return res.end();
      }
      return html(res, 200, this._loginPage('Invalid credentials.'));
    }

    // New Orders page (auth-gated)
    if (path === '/Orders/NewOrders.aspx' && req.method === 'GET') {
      if (!authed) return redirectToLogin(res);
      return html(res, 200, this._newOrdersPage());
    }
    if (path === '/Orders/NewOrders.aspx' && req.method === 'POST') {
      if (!authed) return redirectToLogin(res);
      const body = await readForm(req);
      // Validate WebForms state tokens (faithful: reject forged/stale tokens).
      if (!this.issuedViewstate.has(body.__VIEWSTATE) || !this.issuedEventval.has(body.__EVENTVALIDATION)) {
        return html(res, 200, this._messagePage('Your session has expired. Please refresh.'));
      }
      const orderId = body.__EVENTARGUMENT || extractOrderFromTarget(body.__EVENTTARGET);
      // Test hook: simulate a rival accepting between this client's GET and POST.
      if (this._onBeforeAccept) {
        const hook = this._onBeforeAccept;
        this._onBeforeAccept = null;
        hook(orderId);
      }
      const r = this._tryAccept(orderId, sessionUser, 'portal');
      if (r.ok) return html(res, 200, this._messagePage(`Order ${orderId} accepted. Assigned to you.`));
      if (r.reason === 'taken')
        return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
      return html(res, 200, this._messagePage(`Order ${orderId} not found.`));
    }

    // Email accept link
    if (path === '/accept.aspx' && req.method === 'GET') {
      const id = u.searchParams.get('order');
      const token = u.searchParams.get('token');
      if (this.emailLinkMode === 'needs_login') return redirectToLogin(res);
      const rec = this.orderTokens.get(id);
      if (!rec || token !== rec.token) return html(res, 403, this._messagePage('Invalid token.'));
      if (this.emailLinkMode === 'two_step') {
        const order = this.orders.get(id);
        if (!order) return html(res, 404, this._messagePage(`Order ${id} not found.`));
        if (order.status === 'accepted') {
          return html(res, 200, this._messagePage(`Order ${id} is no longer available.`));
        }
        return html(res, 200, this._orderDetailsPage(id, order.address));
      }
      const r = this._tryAccept(id, rec.user, 'email');
      if (r.ok) return html(res, 200, this._messagePage(`Order ${id} accepted. Thank you.`));
      if (r.reason === 'taken') return html(res, 200, this._messagePage(`Order ${id} is no longer available.`));
      return html(res, 404, this._messagePage(`Order ${id} not found.`));
    }
    if (path === '/accept.aspx' && req.method === 'POST') {
      const body = await readForm(req);
      if (!this.issuedViewstate.has(body.__VIEWSTATE) || !this.issuedEventval.has(body.__EVENTVALIDATION)) {
        return html(res, 200, this._messagePage('Your session has expired. Please refresh.'));
      }
      const orderId = body.__EVENTARGUMENT || extractOrderFromTarget(body.__EVENTTARGET);
      const rec = this.orderTokens.get(orderId);
      const who = rec?.user || 'email';
      const r = this._tryAccept(orderId, who, 'email_two_step');
      if (r.ok) return html(res, 200, this._messagePage(`Order ${orderId} accepted. Assigned to you.`));
      if (r.reason === 'taken') return html(res, 200, this._messagePage(`Order ${orderId} is no longer available.`));
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
      <form method="post" action="/Account/Login.aspx">
        ${this._stateFields()}
        ${error ? `<div class="error">${error}</div>` : ''}
        <label>User Name</label>
        <input type="text" name="ctl00$MainContent$txtUsername" />
        <label>Password</label>
        <input type="password" name="ctl00$MainContent$txtPassword" />
        <a href="/Account/Forgot.aspx">Forgot your password?</a>
        <input type="submit" name="ctl00$MainContent$btnLogin" value="Log In" />
      </form></body></html>`;
  }

  _newOrdersPage() {
    const available = [...this.orders.values()].filter((o) => o.status === 'available');
    const rows = available
      .map(
        (o) => `
      <tr class="order-row">
        <td class="order-no">Order no. ${o.id}</td>
        <td class="address">${o.address}</td>
        <td>
          <a href="javascript:__doPostBack('ctl00$MainContent$gvOrders$btnAccept','${o.id}')">Accept</a>
          <a href="javascript:__doPostBack('ctl00$MainContent$gvOrders$btnDecline','${o.id}')">Decline</a>
        </td>
      </tr>`
      )
      .join('\n');
    return `<!DOCTYPE html><html><head><title>New Orders - E-Street</title></head><body>
      <h1>New Orders</h1>
      <form method="post" action="/Orders/NewOrders.aspx">
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

  /** Order details page shown after clicking ACCEPT ORDER in email (step 1 of 2). */
  _orderDetailsPage(orderId, address = '123 Test St') {
    return `<!DOCTYPE html><html><head><title>Order ${orderId}</title></head><body>
      <h1>Order Details</h1>
      <p>Order no. ${orderId}</p>
      <p>Property Address: ${address}</p>
      <form method="post" action="/accept.aspx">
        ${this._stateFields()}
        <input type="submit" name="ctl00$MainContent$btnAccept" value="Accept" style="color:green" />
        <a href="javascript:__doPostBack('ctl00$MainContent$btnAccept','${orderId}')">Accept</a>
      </form></body></html>`;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────--
function redirectToLogin(res) {
  res.writeHead(302, { location: '/Account/Login.aspx' });
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
