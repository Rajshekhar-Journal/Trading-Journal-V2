/**
 * og/server.js — Order Gateway.
 *
 * Runs on the always-on home machine. Holds the Kite API details, does the daily Kite login,
 * reads orders / holdings / positions / funds / GTTs, writes a heartbeat, a reconcile report and a
 * protection report to the journal database.
 * Phase 3: when "stop-GTT placement" is switched on here AND the static IP matches, it also places
 * or modifies a stop-loss GTT for intents you approved in the journal. It cannot place, modify or
 * cancel any regular order.
 *
 *   node og/server.js            (data folder: og/data, or set OG_DATA_DIR)
 */
'use strict';
const http = require('http');
const path = require('path');
const { createConfig, isIPv4 } = require('./lib/config.js');
const { createSecretStore, mask } = require('./lib/secret-store.js');
const { createKiteAdapter, tokenValidUntil } = require('./lib/kite-adapter.js');
const { createSupabase } = require('./lib/supabase-rest.js');
const { checkPublicIp } = require('./lib/ip-check.js');
const { createSync, VERSION } = require('./lib/sync.js');
const { createExecutor } = require('./lib/executor.js');
const { createExitExecutor } = require('./lib/exit-executor.js');
const { createEmergencyExit } = require('./lib/emergency-exit.js');
const { createBooking } = require('./lib/booking.js');
const { recordGttFills } = require('./lib/gtt-fills.js');
const { hashPassword, verifyPassword, createSessions } = require('./lib/admin-auth.js');
const pages = require('./lib/pages.js');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

function createGateway({ dataDir = process.env.OG_DATA_DIR || path.join(__dirname, 'data'), fetchImpl, log = console.log } = {}) {
  const config = createConfig(dataDir);
  const secrets = createSecretStore(dataDir);
  const sessions = createSessions({ minutes: config.load().sessionMinutes });
  const state = { brokerConnected: false, tokenValidUntil: null, ip: null, lastSync: null, lastSyncError: null, drift: [] };
  const timers = [];
  const servers = [];

  // ── Collaborators (rebuilt from saved settings each time, so nothing is hardcoded) ──
  function kite({ allowGttWrites = false, allowSellOrders = false } = {}) {
    const cfg = config.load();
    return createKiteAdapter({ baseUrl: cfg.kiteBaseUrl, loginUrl: cfg.kiteLoginUrl, fetchImpl, allowGttWrites, allowSellOrders,
      apiKey: secrets.get('kiteApiKey') || '', apiSecret: secrets.get('kiteApiSecret') || '', accessToken: _liveToken() });
  }
  /** Stop-GTT placement is possible only when all three hold: switched on, static IP matches, logged in today. */
  function orderSending() {
    const ok = !!(state.ip && state.ip.ok && _liveToken());
    state.sellSending = ok && !!config.load().sellOrdersEnabled;
    state.orderSending = (ok && !!config.load().gttWritesEnabled) || state.sellSending;
    return state.orderSending;
  }
  const gttSending = () => orderSending() && !!config.load().gttWritesEnabled;
  const sellSending = () => { orderSending(); return state.sellSending; };
  function store() {
    const cfg = config.load();
    return createSupabase({ url: cfg.supabaseUrl, anonKey: secrets.get('supabaseAnonKey') || '', fetchImpl,
      getRefreshToken: () => secrets.get('journalRefreshToken'), setRefreshToken: t => secrets.set('journalRefreshToken', t) });
  }
  const kiteConfigured = () => secrets.has('kiteApiKey') && secrets.has('kiteApiSecret');
  const journalLinked = () => secrets.has('journalRefreshToken') && secrets.has('supabaseAnonKey') && !!config.load().supabaseUrl;

  function _liveToken() {
    const meta = secrets.get('kiteTokenMeta');
    if (!meta || !secrets.has('kiteAccessToken') || new Date(meta.validUntil) <= new Date()) {
      state.brokerConnected = false; state.tokenValidUntil = null; return '';
    }
    state.brokerConnected = true; state.tokenValidUntil = meta.validUntil;
    return secrets.get('kiteAccessToken');
  }
  function _dropToken() {
    secrets.remove('kiteAccessToken'); secrets.remove('kiteTokenMeta');
    state.brokerConnected = false; state.tokenValidUntil = null;
  }

  // ── Background work ──
  const sync = () => createSync({ broker: kite(), store: store(), getState: () => state, log: (k, v) => log(`[og] ${k}`, JSON.stringify(v)) });

  async function tickIp() {
    const cfg = config.load();
    state.ip = await checkPublicIp({ expected: cfg.expectedStaticIp, url: cfg.ipCheckUrl, fetchImpl });
    return state.ip;
  }
  const emergencySeen = new Map();          // condition → first time seen (grace periods)
  let executing = false;
  async function tickExecute() {
    if (executing || !journalLinked()) return null;
    executing = true;
    try {
      const out = { done: 0, failed: 0, unknown: 0, expired: 0, skipped: 0 };
      const add = r => { for (const k of Object.keys(out)) out[k] += r[k] || 0; };
      const logger = (k, v) => log(`[og] ${k}`, JSON.stringify(v));
      const cfg = config.load();
      const sellBroker = () => kite({ allowGttWrites: true, allowSellOrders: true });
      // Emergency Exit first: detect, propose, and carry out what is approved.
      if (sellSending() && cfg.emergencyExit !== 'off') {
        const em = createEmergencyExit({ broker: sellBroker(), store: store(), log: logger, exitWindow: cfg.exitWindow, fillWaitSec: cfg.fillWaitSec, cancelWaitSec: cfg.cancelWaitSec, pollMs: cfg.orderPollMs });
        const b = sellBroker(), st = store(), uid = await st.userId();
        const [orders, gtts, holdings, positions, trades] = await Promise.all([b.orders(), b.gtts(), b.holdings(), b.positions(),
          st.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,closed_at&user_id=eq.${uid}&closed_at=is.null`)]);
        await em.propose({ orders, gtts, holdings, positions, trades }, { mode: cfg.emergencyExit, seen: emergencySeen, gttFillGraceSec: cfg.gttFillGraceSec, notTriggeredGraceSec: cfg.notTriggeredGraceSec });
        add(await em.runOnce({ enabled: true }));
      }
      // Then ordinary exits (they remove risk), then stop GTTs.
      if (sellSending()) add(await createExitExecutor({ broker: kite({ allowGttWrites: true, allowSellOrders: true }), store: store(), log: logger,
        exitWindow: cfg.exitWindow, fillWaitSec: cfg.fillWaitSec, cancelWaitSec: cfg.cancelWaitSec, pollMs: cfg.orderPollMs }).runOnce({ enabled: true }));
      if (gttSending()) add(await createExecutor({ broker: kite({ allowGttWrites: true }), store: store(), log: logger }).runOnce({ enabled: true }));
      // Write completed sells into the journal (also retries any booking that could not be written earlier).
      if (cfg.bookFills) { try { out.booked = (await createBooking({ store: store(), log: logger }).bookPending()).booked; } catch (e) { log('[og] booking pass failed:', e.message); } }
      if (out.done || out.failed || out.unknown || out.booked) await tickSync();     // refresh the protection and reconcile reports straight away
      return out;
    } catch (e) {
      if (e.tokenInvalid) _dropToken();
      log('[og] execute failed:', e.message);
      return null;
    } finally { executing = false; }
  }
  async function tickHeartbeat() {
    orderSending();
    if (!journalLinked()) return null;
    try { return await sync().heartbeat(); } catch (e) { log('[og] heartbeat failed:', e.message); return null; }
  }
  async function tickSync() {
    if (!_liveToken() || !journalLinked()) return null;
    try {
      const out = await sync().syncOnce();
      state.lastSync = out.result; state.lastSyncError = null; state.drift = out.drift;
      // Stop-GTT fills → journal (optional; reads the broker, writes only the journal).
      if (config.load().bookGttFills) {
        try {
          const lg = (k, v) => log(`[og] ${k}`, JSON.stringify(v));
          const made = await recordGttFills({ store: store(), snapshot: out.raw, log: lg });
          if (made && (await createBooking({ store: store(), log: lg }).bookPending()).booked) setTimeout(() => tickSync(), 0);   // books agree again on the next read
        } catch (e) { log('[og] GTT fill booking failed:', e.message); }
      }
      return out;
    } catch (e) {
      state.lastSyncError = e.message;
      if (e.tokenInvalid) _dropToken();                 // Kite says the token is dead → ask for login again
      log('[og] sync failed:', e.message);
      return null;
    }
  }

  async function completeKiteLogin(requestToken) {
    const cfg = config.load();
    if (!kiteConfigured()) throw new Error('Enter the Kite API details first.');
    if (!cfg.zerodhaClientId) throw new Error('Enter your Zerodha client ID first.');
    const k = kite();
    const s = await k.createSession(requestToken);
    if (String(s.userId).toUpperCase() !== cfg.zerodhaClientId.toUpperCase()) throw new Error('That Kite login is for a different account. Refused.');
    const validUntil = tokenValidUntil(new Date()).toISOString();
    secrets.set('kiteAccessToken', s.accessToken);
    secrets.set('kiteTokenMeta', { validUntil, loginAt: new Date().toISOString() });
    _liveToken();
    await tickHeartbeat();
    tickSync();
  }

  // ── HTTP ──
  function view(req) {
    const cfg = config.load();
    _liveToken();
    return {
      version: VERSION, kiteConfigured: kiteConfigured(), kiteApiKeyMasked: mask(secrets.get('kiteApiKey')),
      brokerConnected: state.brokerConnected,
      tokenValidUntil: state.tokenValidUntil ? new Date(state.tokenValidUntil).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : null,
      ipStatus: state.ip ? state.ip.reason : (cfg.expectedStaticIp ? 'not_checked' : 'not_configured'),
      journalLinked: journalLinked(), anonKeySaved: secrets.has('supabaseAnonKey'),
      lastSync: state.lastSync ? new Date(state.lastSync.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : null,
      lastSyncError: state.lastSyncError, driftCount: state.lastSync ? state.lastSync.drift : 0, driftHigh: state.lastSync ? state.lastSync.driftHigh : 0,
      callbackUrl: `http://${req.headers.host}/kite/callback`,
      gttWritesEnabled: !!cfg.gttWritesEnabled, sellOrdersEnabled: !!cfg.sellOrdersEnabled, orderSending: gttSending(), sellSending: sellSending(), emergencyExit: cfg.emergencyExit, bookGttFills: !!cfg.bookGttFills,
    };
  }
  /** What /status.json may show. No secret, no token, no IP address. */
  function publicStatus(req) {
    const v = view(req);
    return { version: v.version, kiteConfigured: v.kiteConfigured, brokerConnected: v.brokerConnected, tokenValidUntil: state.tokenValidUntil,
      ipStatus: v.ipStatus, journalLinked: v.journalLinked, lastSync: state.lastSync, lastSyncError: state.lastSyncError, orderSendingEnabled: orderSending() };
  }

  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://kite.zerodha.com; base-uri 'none'; frame-ancestors 'none'", ...headers });
    res.end(body);
  };
  const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers }); res.end(); };
  const flash = (res, to, type, text) => redirect(res, `${to}?m=${encodeURIComponent(type + ':' + text)}`);
  const readFlash = url => { const m = url.searchParams.get('m'); if (!m) return null; const i = m.indexOf(':'); return { type: m.slice(0, i), text: m.slice(i + 1, i + 301) }; };
  const cookieOf = req => (/(?:^|;\s*)og_sid=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1];

  function readForm(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > 65536) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
      req.on('error', reject);
    });
  }

  function hostAllowed(req) {
    const cfg = config.load();
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return ['localhost', '127.0.0.1', '::1', ...cfg.bindHosts, ...cfg.allowedHosts].map(h => h.toLowerCase()).includes(host);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (!hostAllowed(req)) return send(res, 421, 'Host not allowed');
    if (p === '/healthz') return send(res, 200, '{"ok":true}', { 'Content-Type': 'application/json' });

    const hasPassword = secrets.has('adminPasswordHash');
    const isLocal = LOOPBACK.has(req.socket.remoteAddress);

    // First run: the password can be set only from this machine.
    if (!hasPassword) {
      if (!isLocal) return send(res, 403, 'First-time setup must be done on the gateway machine itself.');
      if (req.method === 'POST' && p === '/setup-password') {
        const f = await readForm(req);
        if ((f.password || '').length < 12) return send(res, 400, pages.setupPasswordPage({ type: 'bad', text: 'Use 12 characters or more.' }));
        if (f.password !== f.password2) return send(res, 400, pages.setupPasswordPage({ type: 'bad', text: 'The two passwords do not match.' }));
        secrets.set('adminPasswordHash', hashPassword(f.password));
        return redirect(res, '/');
      }
      return send(res, 200, pages.setupPasswordPage());
    }

    const sid = cookieOf(req);
    const session = sessions.get(sid);

    if (p === '/login' && req.method === 'POST') {
      if (sessions.locked()) return send(res, 429, pages.loginPage({ type: 'bad', text: `Too many wrong attempts. Try again in ${Math.ceil(sessions.lockedForSec() / 60)} min.` }));
      const f = await readForm(req);
      if (!verifyPassword(f.password || '', secrets.get('adminPasswordHash'))) {
        sessions.fail();
        return send(res, 401, pages.loginPage({ type: 'bad', text: 'Wrong password.' }));
      }
      const s = sessions.create();
      return redirect(res, '/', { 'Set-Cookie': `og_sid=${s.id}; HttpOnly; SameSite=Lax; Path=/` });
    }
    if (!session) {
      if (p === '/status.json') return send(res, 401, '{"error":"sign in"}', { 'Content-Type': 'application/json' });
      return send(res, p === '/' ? 200 : 401, pages.loginPage(p === '/' ? null : { type: 'warn', text: 'Please sign in first.' }));
    }

    // ── Signed in ──
    if (req.method === 'GET') {
      if (p === '/') return send(res, 200, pages.dashboardPage({ csrf: session.csrf, cfg: config.load(), view: view(req), m: readFlash(url) }));
      if (p === '/status.json') return send(res, 200, JSON.stringify(publicStatus(req)), { 'Content-Type': 'application/json' });
      if (p === '/kite/login') { if (!kiteConfigured()) return flash(res, '/', 'bad', 'Enter the Kite API details first.'); return redirect(res, kite().loginUrl()); }
      if (p === '/kite/callback') {
        const rt = url.searchParams.get('request_token');
        if (url.searchParams.get('status') !== 'success' || !rt) return flash(res, '/', 'bad', 'Kite login was not completed.');
        try { await completeKiteLogin(rt); return flash(res, '/', 'ok', 'Kite login complete.'); }
        catch (e) { return flash(res, '/', 'bad', e.message); }
      }
      return send(res, 404, 'Not found');
    }
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');

    const f = await readForm(req);
    if (f.csrf !== session.csrf) return send(res, 403, 'Form expired. Go back, reload the page and try again.');
    try {
      if (p === '/logout') { sessions.destroy(sid); return redirect(res, '/', { 'Set-Cookie': 'og_sid=; Max-Age=0; Path=/' }); }
      if (p === '/config') {
        const ip = (f.expectedStaticIp || '').trim();
        if (ip && !isIPv4(ip)) return flash(res, '/', 'bad', 'Static IP must look like 203.0.113.10 (or be left blank).');
        const port = Number(f.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) return flash(res, '/', 'bad', 'Port must be between 1024 and 65535.');
        const bind = list(f.bindHosts);
        if (!bind.length || !bind.every(isIPv4)) return flash(res, '/', 'bad', 'Listening addresses must be IPv4 addresses, e.g. 127.0.0.1.');
        if (bind.includes('0.0.0.0')) return flash(res, '/', 'bad', '0.0.0.0 would expose this page on every network. Enter the specific home-network or VPN address.');
        const hosts = list(f.allowedHosts);
        if (!hosts.every(h => /^[a-z0-9.-]{1,253}$/i.test(h))) return flash(res, '/', 'bad', 'Host names may contain only letters, digits, dots and hyphens.');
        config.save({ expectedStaticIp: ip, port, bindHosts: bind, allowedHosts: hosts });
        await tickIp();
        if (!state.ip.ok) config.save({ gttWritesEnabled: false, sellOrdersEnabled: false, emergencyExit: 'off' });   // a changed or blank IP switches all sending off
        await tickHeartbeat();
        return flash(res, '/', 'ok', 'Network settings saved.');
      }
      if (p === '/execution') {
        const gttOn = f.gttWritesEnabled === 'on', sellOn = f.sellOrdersEnabled === 'on';
        if ((gttOn || sellOn) && !(state.ip && state.ip.ok)) return flash(res, '/', 'bad', 'Sending can be switched on only after the static IP is entered and matches.');
        const em = ['confirm', 'auto'].includes(f.emergencyExit) ? f.emergencyExit : 'off';
        if (em !== 'off' && !sellOn) return flash(res, '/', 'bad', 'The Emergency Exit needs "Allow exits" switched on.');
        config.save({ gttWritesEnabled: gttOn, sellOrdersEnabled: sellOn, emergencyExit: em, bookGttFills: f.bookGttFills === 'on' });
        await tickHeartbeat();
        return flash(res, '/', 'ok', `Stop-GTT placement is ${gttOn ? 'ON' : 'off'}; exits (market sell) are ${sellOn ? 'ON' : 'off'}; Emergency Exit is ${em}.`);
      }
      if (p === '/secrets/kite') {
        const key = (f.apiKey || '').trim(), sec = (f.apiSecret || '').trim(), cid = (f.zerodhaClientId || '').trim().toUpperCase();
        if (cid && !/^[A-Z0-9]{4,12}$/.test(cid)) return flash(res, '/', 'bad', 'Client ID looks wrong (e.g. AB1234).');
        if (key) secrets.set('kiteApiKey', key);
        if (sec) secrets.set('kiteApiSecret', sec);
        if (key || sec) _dropToken();                    // new API details → yesterday's token no longer applies
        config.save({ zerodhaClientId: cid });
        return flash(res, '/', 'ok', 'Kite API details saved.');
      }
      if (p === '/secrets/journal') {
        const u = (f.supabaseUrl || '').trim().replace(/\/$/, '');
        if (!/^https:\/\/[a-z0-9.-]+$/i.test(u)) return flash(res, '/', 'bad', 'Supabase URL must start with https://');
        if ((f.supabaseAnonKey || '').trim()) secrets.set('supabaseAnonKey', f.supabaseAnonKey.trim());
        if (!secrets.has('supabaseAnonKey')) return flash(res, '/', 'bad', 'Enter the Supabase anon key.');
        config.save({ supabaseUrl: u, journalEmail: (f.journalEmail || '').trim() });
        if (!f.journalEmail || !f.journalPassword) return flash(res, '/', 'warn', 'Saved. Enter the journal email and password to link the account.');
        await store().signInWithPassword(f.journalEmail.trim(), f.journalPassword);
        await tickHeartbeat();
        return flash(res, '/', 'ok', 'Journal account linked.');
      }
      if (p === '/kite/token') {
        const m = /request_token=([A-Za-z0-9]+)/.exec(f.pasted || '') || /^([A-Za-z0-9]{16,64})$/.exec((f.pasted || '').trim());
        if (!m) return flash(res, '/', 'bad', 'Could not find a request_token in what you pasted.');
        await completeKiteLogin(m[1]);
        return flash(res, '/', 'ok', 'Kite login complete.');
      }
      if (p === '/sync-now') { const out = await tickSync(); return flash(res, '/', out ? 'ok' : 'bad', out ? 'Sync complete.' : 'Sync failed — see the status above.'); }
      if (p === '/change-password') {
        if (!verifyPassword(f.current || '', secrets.get('adminPasswordHash'))) return flash(res, '/', 'bad', 'Current password is wrong.');
        if ((f.password || '').length < 12) return flash(res, '/', 'bad', 'Use 12 characters or more.');
        secrets.set('adminPasswordHash', hashPassword(f.password));
        sessions.destroyAll();
        return redirect(res, '/', { 'Set-Cookie': 'og_sid=; Max-Age=0; Path=/' });
      }
      return send(res, 404, 'Not found');
    } catch (e) {
      return flash(res, '/', 'bad', e.message);
    }
  }

  const listener = (req, res) => handle(req, res).catch(e => { log('[og] request error:', e.message); if (!res.headersSent) send(res, 500, 'Gateway error'); else res.end(); });

  async function start({ port, hosts, background = true } = {}) {
    const cfg = config.load();
    for (const host of hosts || cfg.bindHosts) {
      const s = http.createServer(listener);
      await new Promise((ok, bad) => { s.once('error', bad); s.listen(port ?? cfg.port, host, ok); })
        .then(() => { servers.push(s); log(`[og] listening on http://${host}:${s.address().port}`); })
        .catch(e => log(`[og] could not listen on ${host}: ${e.message}`));
    }
    if (!servers.length) throw new Error('Gateway could not listen on any address');
    if (background) {
      tickIp().then(tickHeartbeat).then(tickSync);
      timers.push(setInterval(tickHeartbeat, cfg.heartbeatSec * 1000), setInterval(tickSync, cfg.brokerSyncSec * 1000), setInterval(tickIp, cfg.ipCheckSec * 1000),
        setInterval(tickExecute, cfg.executeSec * 1000));
      timers.forEach(t => t.unref && t.unref());
    }
    return servers[0].address().port;
  }
  async function stop() {
    timers.splice(0).forEach(clearInterval);
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))));
  }

  return { start, stop, state, config, secrets, tickIp, tickHeartbeat, tickSync, tickExecute, completeKiteLogin, publicStatus };
}

if (require.main === module) {
  const gw = createGateway();
  gw.start().then(port => console.log(`[og] Order Gateway ${VERSION} ready. Open http://127.0.0.1:${port} on this machine.`))
    .catch(e => { console.error('[og] failed to start:', e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gw.stop().then(() => process.exit(0)));
}

module.exports = { createGateway };
