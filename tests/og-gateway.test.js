/**
 * Order Gateway — Phase 1 (broker link, read only). Run with:  npm test
 * Uses an in-process fake of Kite, Supabase and the IP lookup; no network, no real account.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeWorld } = require('./helpers/fake-kite.js');
const { createSecretStore, mask } = require('../og/lib/secret-store.js');
const { createKiteAdapter, tokenValidUntil } = require('../og/lib/kite-adapter.js');
const { checkPublicIp } = require('../og/lib/ip-check.js');
const { reconcile, protection } = require('../og/lib/reconcile.js');
const { createGateway } = require('../og/server.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const trade = (symbol, qty, stop, extra = {}) => ({ id: 't_' + symbol, symbol, direction: 'Long', entries: [{ qty }], pyramids: [], partial_exits: [], final_exit: null, current_stop: stop, closed_at: null, ...extra });
const gtt = (id, symbol, qty, trigger, status = 'active') => ({ id, status, type: 'single', condition: { tradingsymbol: symbol, exchange: 'NSE', trigger_values: [trigger] }, orders: [{ transaction_type: 'SELL', quantity: qty, price: trigger - 1 }] });

// ── Secret store ──
test('secrets are encrypted on disk, round-trip, and tampering is detected', () => {
  const dir = tmp(); const s = createSecretStore(dir);
  s.set('kiteApiSecret', 'super-secret-value');
  assert.equal(s.get('kiteApiSecret'), 'super-secret-value');
  const raw = fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8');
  assert.ok(!raw.includes('super-secret-value'), 'plain secret must not be on disk');
  const box = JSON.parse(raw); box.data = Buffer.from('tampered').toString('base64');
  fs.writeFileSync(path.join(dir, 'secrets.enc'), JSON.stringify(box));
  assert.throws(() => s.get('kiteApiSecret'));
  assert.equal(mask('abcdefghij'), '••••••ghij');
});

// ── Kite adapter ──
test('adapter is read only: no order or GTT write methods, only GET after login', async () => {
  const w = createFakeWorld();
  const k = createKiteAdapter({ baseUrl: 'https://kite.test', loginUrl: 'https://kite.test/login', apiKey: w.apiKey, apiSecret: w.apiSecret, fetchImpl: w.fetch });
  assert.equal(k.readOnly, true);
  for (const name of Object.keys(k)) assert.ok(!/place|modify|cancel|delete|create(?!Session)/i.test(name), `unexpected write method ${name}`);
  await assert.rejects(k.holdings(), /Not logged in/);
  const s = await k.createSession('req1');
  assert.equal(s.userId, 'AB1234');
  await Promise.all([k.profile(), k.margins(), k.orders(), k.trades(), k.holdings(), k.positions(), k.gtts()]);
  assert.deepEqual([...new Set(w.kiteCalls.filter(c => c.path !== '/session/token').map(c => c.method))], ['GET']);
  assert.match(k.loginUrl(), /api_key=key123/);
});

test('adapter reports a dead token and a bad checksum as token errors', async () => {
  const w = createFakeWorld();
  const k = createKiteAdapter({ baseUrl: 'https://kite.test', loginUrl: 'x', apiKey: w.apiKey, apiSecret: 'wrong', fetchImpl: w.fetch });
  await assert.rejects(k.createSession('req1'), e => e.tokenInvalid === true);
  const k2 = createKiteAdapter({ baseUrl: 'https://kite.test', loginUrl: 'x', apiKey: w.apiKey, apiSecret: w.apiSecret, accessToken: 'stale', fetchImpl: w.fetch });
  await assert.rejects(k2.orders(), e => e.tokenInvalid === true && e.errorType === 'TokenException');
});

test('Kite token validity ends at 06:00 IST', () => {
  assert.equal(tokenValidUntil(new Date('2026-11-11T03:20:00Z')).toISOString(), '2026-11-12T00:30:00.000Z'); // 08:50 IST → next day 06:00 IST
  assert.equal(tokenValidUntil(new Date('2026-11-10T23:00:00Z')).toISOString(), '2026-11-11T00:30:00.000Z'); // 04:30 IST → same day 06:00 IST
});

// ── IP check ──
test('IP check: blank is not_configured, match and mismatch are told apart, lookup failure is not ok', async () => {
  const w = createFakeWorld();
  const run = expected => checkPublicIp({ expected, url: 'https://ip.test', fetchImpl: w.fetch });
  assert.equal((await run('')).reason, 'not_configured');
  assert.deepEqual([(await run('203.0.113.10')).ok, (await run('203.0.113.10')).reason], [true, 'match']);
  assert.deepEqual([(await run('198.51.100.7')).ok, (await run('198.51.100.7')).reason], [false, 'mismatch']);
  assert.equal((await run('999.1.1.1')).reason, 'expected_ip_invalid');
  assert.equal((await checkPublicIp({ expected: '203.0.113.10', url: 'x', fetchImpl: async () => { throw new Error('down'); } })).ok, false);
});

// ── Reconcile ──
test('reconcile: clean book produces no drift', () => {
  const d = reconcile({ trades: [trade('INFY', 100, 95)], holdings: [{ tradingsymbol: 'INFY', quantity: 100, t1_quantity: 0 }], positions: { net: [] }, gtts: [gtt(1, 'INFY', 100, 95)] });
  assert.deepEqual(d, []);
});

test('reconcile: every drift kind is reported with the right quantities', () => {
  const d = reconcile({
    trades: [trade('AAA', 100, 95), trade('BBB', 50, 200), trade('CCC', 10, 40), trade('DDD', 20, 500), trade('ZZZ', 5, 9, { closed_at: '2026-11-01' })],
    holdings: [{ tradingsymbol: 'AAA', quantity: 60, t1_quantity: 0 }, { tradingsymbol: 'CCC', quantity: 10, t1_quantity: 0 }, { tradingsymbol: 'DDD', quantity: 0, t1_quantity: 20 }, { tradingsymbol: 'MANUAL', quantity: 7, t1_quantity: 0 }],
    positions: { net: [{ tradingsymbol: 'AAA', product: 'CNC', quantity: 30 }, { tradingsymbol: 'AAA', product: 'MIS', quantity: 999 }] },
    gtts: [gtt(1, 'AAA', 100, 95), gtt(2, 'CCC', 4, 40), gtt(3, 'DDD', 20, 480), gtt(4, 'GONE', 5, 10), gtt(5, 'BBB', 50, 200, 'triggered')],
  });
  const kinds = d.map(x => `${x.kind}:${x.symbol}`).sort();
  assert.deepEqual(kinds, ['BROKER_ONLY:MANUAL', 'GTT_QTY_MISMATCH:CCC', 'GTT_TRIGGER_MISMATCH:DDD', 'JOURNAL_ONLY:BBB', 'NO_STOP_GTT:BBB', 'ORPHAN_GTT:GONE', 'QTY_MISMATCH:AAA']);
  const aaa = d.find(x => x.kind === 'QTY_MISMATCH');
  assert.deepEqual([aaa.journalQty, aaa.brokerQty, aaa.severity], [100, 90, 'high']);   // 60 settled + 30 bought today (CNC); MIS ignored
  assert.equal(d.find(x => x.kind === 'BROKER_ONLY').severity, 'info');
});

test('reconcile: symbol spellings and partial exits are normalised', () => {
  const t = trade('nse:infy.ns', 100, 95, { partial_exits: [{ qty: 40 }] });
  assert.deepEqual(reconcile({ trades: [t], holdings: [{ tradingsymbol: 'INFY', quantity: 60 }], positions: { net: [] }, gtts: [gtt(1, 'INFY', 60, 95)] }), []);
});

test('protection: PROTECTED only when one GTT covers exactly the position at the journal stop', () => {
  const p = protection({
    trades: [trade('OK', 100, 95), trade('NONE', 50, 200), trade('LESS', 10, 40), trade('MORE', 10, 40), trade('LEVEL', 20, 500), trade('TWO', 30, 60), trade('DONE', 5, 9, { closed_at: '2026-11-01' })],
    holdings: [{ tradingsymbol: 'OK', quantity: 100 }], positions: { net: [] },
    gtts: [gtt(1, 'OK', 100, 95), gtt(2, 'LESS', 4, 40), gtt(3, 'MORE', 15, 40), gtt(4, 'LEVEL', 20, 480), gtt(5, 'TWO', 30, 60), gtt(6, 'TWO', 30, 58), gtt(7, 'NONE', 50, 200, 'triggered')],
  });
  assert.deepEqual(Object.fromEntries(p.map(x => [x.symbol, x.state])), { LESS: 'PARTIAL', LEVEL: 'PARTIAL', MORE: 'PARTIAL', NONE: 'UNPROTECTED', OK: 'PROTECTED', TWO: 'PARTIAL' });
  const ok = p.find(x => x.symbol === 'OK');
  assert.deepEqual([ok.journalQty, ok.brokerQty, ok.gttQty, ok.gttTrigger], [100, 100, 100, 95]);
  assert.match(p.find(x => x.symbol === 'LESS').reason, /covers 4 of 10/);
  assert.match(p.find(x => x.symbol === 'LEVEL').reason, /480 differs from the journal stop 500/);
});

// ── Gateway, end to end over HTTP ──
async function boot(world, { configure = true } = {}) {
  const dataDir = tmp();
  const gw = createGateway({ dataDir, fetchImpl: world.fetch, log: () => {} });
  gw.config.save({ kiteBaseUrl: 'https://kite.test', kiteLoginUrl: 'https://kite.test/connect/login', ipCheckUrl: 'https://ip.test' });
  const port = await gw.start({ port: 0, hosts: ['127.0.0.1'], background: false });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const req = async (method, p, form) => {
    const res = await fetch(base + p, { method, redirect: 'manual', headers: { cookie, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  };
  const csrf = async () => /name="csrf" value="([a-f0-9]+)"/.exec((await req('GET', '/')).text)[1];
  const post = async (p, form = {}) => req('POST', p, { csrf: await csrf(), ...form });
  if (configure) {
    await req('POST', '/setup-password', { password: 'gateway-password-1', password2: 'gateway-password-1' });
    await req('POST', '/login', { password: 'gateway-password-1' });
    await post('/secrets/kite', { apiKey: world.apiKey, apiSecret: world.apiSecret, zerodhaClientId: world.clientId });
    await post('/secrets/journal', { supabaseUrl: 'https://sb.test', supabaseAnonKey: 'anon', journalEmail: 'me@example.com', journalPassword: world.journalPassword });
  }
  return { gw, req, post, dataDir, base, clearCookie: () => { cookie = ''; } };
}

test('first run asks for a password; pages need sign-in; wrong passwords lock out', async t => {
  const w = createFakeWorld(); const g = await boot(w, { configure: false }); t.after(() => g.gw.stop());
  assert.match((await g.req('GET', '/')).text, /first-time setup/i);
  assert.equal((await g.req('POST', '/setup-password', { password: 'short', password2: 'short' })).status, 400);
  await g.req('POST', '/setup-password', { password: 'gateway-password-1', password2: 'gateway-password-1' });
  assert.match((await g.req('GET', '/')).text, /Sign in/);
  assert.equal((await g.req('GET', '/status.json')).status, 401);
  assert.equal((await g.req('GET', '/kite/login')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await g.req('POST', '/login', { password: 'nope' })).status, 401);
  assert.equal((await g.req('POST', '/login', { password: 'gateway-password-1' })).status, 429, 'locked even with the right password');
  assert.equal((await g.req('GET', '/healthz')).text, '{"ok":true}');
});

test('requests with an unknown Host header are refused (DNS rebinding)', async t => {
  const w = createFakeWorld(); const g = await boot(w); t.after(() => g.gw.stop());
  const http = require('http'); const { port } = new URL(g.base);
  const status = await new Promise(r => http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example' } }, res => { res.resume(); r(res.statusCode); }));
  assert.equal(status, 421);
});

test('POST without the CSRF token is refused', async t => {
  const w = createFakeWorld(); const g = await boot(w); t.after(() => g.gw.stop());
  assert.equal((await g.req('POST', '/config', { expectedStaticIp: '203.0.113.10', port: '8787', bindHosts: '127.0.0.1' })).status, 403);
});

test('full flow: login → heartbeat → sync → drift report; no secret ever leaves the gateway', async t => {
  const w = createFakeWorld(); const g = await boot(w); t.after(() => g.gw.stop());
  w.db.trades.push({ ...trade('INFY', 100, 95), user_id: w.uid }, { ...trade('TCS', 10, 3000), user_id: w.uid });
  w.holdings.push({ tradingsymbol: 'INFY', quantity: 100, t1_quantity: 0 });
  w.gtts.push(gtt(77, 'INFY', 100, 95));
  w.orders.push({ order_id: '1001', status: 'COMPLETE', tradingsymbol: 'INFY', exchange: 'NSE', transaction_type: 'BUY', quantity: 100, filled_quantity: 100, pending_quantity: 0, order_timestamp: '2026-11-11 09:31:02' });

  // Before the daily login: heartbeat says not connected, sync does nothing.
  await g.gw.tickHeartbeat();
  assert.equal(w.db.exec_state[0].broker_connected, false);
  assert.equal(await g.gw.tickSync(), null);

  // A login for a different Zerodha account is refused.
  assert.match(decodeURIComponent((await g.req('GET', '/kite/callback?status=success&request_token=other')).location), /different account/);
  assert.equal(g.gw.state.brokerConnected, false);

  // Proper login through the redirect.
  assert.match((await g.req('GET', '/kite/login')).location, /^https:\/\/kite\.test\/connect\/login\?api_key=key123&v=3$/);
  assert.match(decodeURIComponent((await g.req('GET', '/kite/callback?status=success&request_token=req1')).location), /Kite login complete/);
  assert.ok(await g.gw.tickSync(), 'sync failed: ' + g.gw.state.lastSyncError);

  const st = w.db.exec_state[0];
  assert.equal(st.broker_connected, true);
  assert.equal(st.order_sending_enabled, false);
  assert.equal(st.ip_status, 'not_checked');
  assert.equal(st.open_drift_count, 2);
  assert.deepEqual(w.db.drift_log.map(d => `${d.kind}:${d.symbol}:${d.status}`).sort(), ['JOURNAL_ONLY:TCS:open', 'NO_STOP_GTT:TCS:open']);
  assert.equal(w.db.broker_orders[0].order_timestamp, '2026-11-11T04:01:02.000Z');
  assert.equal(w.db.broker_gtts[0].present, true);
  assert.equal(w.db.broker_snapshots.length, 4);
  const prot = w.db.broker_snapshots.find(x => x.kind === 'protection').data;
  assert.deepEqual(prot.map(x => `${x.symbol}:${x.state}`), ['INFY:PROTECTED', 'TCS:UNPROTECTED']);
  assert.deepEqual([st.last_sync_result.positions, st.last_sync_result.notProtected], [2, 1]);

  // A database without migration 010 rejects the protection row; the rest of the sync still works.
  w.rejectKinds = ['protection'];
  const out = await g.gw.tickSync();
  assert.ok(out && out.result.protectionStored === false && g.gw.state.lastSyncError === null);
  w.rejectKinds = [];

  // The difference goes away at the broker → drift resolves, vanished GTT is marked not present.
  w.holdings.push({ tradingsymbol: 'TCS', quantity: 10, t1_quantity: 0 }); w.gtts = [gtt(78, 'TCS', 10, 3000)];
  await new Promise(r => setTimeout(r, 5));
  await g.gw.tickSync();
  assert.deepEqual(w.db.drift_log.filter(d => d.status === 'open').map(d => `${d.kind}:${d.symbol}`), ['NO_STOP_GTT:INFY']);
  assert.equal(w.db.broker_gtts.find(x => x.gtt_id === '77').present, false);

  // Static IP entered later through the page — no code change.
  await g.post('/config', { expectedStaticIp: '203.0.113.10', port: '8787', bindHosts: '127.0.0.1', allowedHosts: '' });
  assert.equal(w.db.exec_state[0].ip_status, 'match');
  w.publicIp = '198.51.100.99'; await g.gw.tickIp(); await g.gw.tickHeartbeat();
  assert.deepEqual([w.db.exec_state[0].ip_ok, w.db.exec_state[0].ip_status], [false, 'mismatch']);
  assert.match((await g.post('/config', { expectedStaticIp: '1.2.3', port: '8787', bindHosts: '127.0.0.1' })).location, /Static%20IP%20must/);
  assert.match((await g.post('/config', { expectedStaticIp: '', port: '8787', bindHosts: '0.0.0.0' })).location, /0\.0\.0\.0/);

  // Nothing secret in any page, the status JSON, the database rows or the config file.
  const leaks = [w.apiSecret, w.accessToken, w.refreshToken, w.journalPassword, 'gateway-password-1'];
  const surfaces = [(await g.req('GET', '/')).text, (await g.req('GET', '/status.json')).text, JSON.stringify(w.db), fs.readFileSync(g.gw.config.file, 'utf8'),
    fs.readFileSync(path.join(g.dataDir, 'secrets.enc'), 'utf8')];
  for (const s of surfaces) for (const leak of leaks) assert.ok(!s.includes(leak), 'secret leaked: ' + leak.slice(0, 4) + '…');
  assert.ok(!JSON.stringify(w.db.exec_state).includes('203.0.113.10'), 'the IP address itself is not written to the journal');

  // Only read calls ever reached Kite.
  assert.deepEqual([...new Set(w.kiteCalls.filter(c => c.path !== '/session/token').map(c => c.method))], ['GET']);
});

test('a dead Kite token is dropped and the journal shows login required; paste-login works', async t => {
  const w = createFakeWorld(); const g = await boot(w); t.after(() => g.gw.stop());
  await g.post('/kite/token', { pasted: 'http://127.0.0.1:8787/kite/callback?action=login&status=success&request_token=req1abc' });
  assert.equal(g.gw.state.brokerConnected, true);
  w.tokenDead = true;
  assert.equal(await g.gw.tickSync(), null);
  assert.equal(g.gw.state.brokerConnected, false);
  await g.gw.tickHeartbeat();
  assert.equal(w.db.exec_state[0].broker_connected, false);
  assert.match((await g.req('GET', '/')).text, /Login required/);
});

test('sign-out ends the session and changing the password signs everyone out', async t => {
  const w = createFakeWorld(); const g = await boot(w); t.after(() => g.gw.stop());
  await g.post('/change-password', { current: 'gateway-password-1', password: 'another-password-22' });
  assert.equal((await g.req('GET', '/status.json')).status, 401);
  assert.equal((await g.req('POST', '/login', { password: 'gateway-password-1' })).status, 401);
  assert.equal((await g.req('POST', '/login', { password: 'another-password-22' })).status, 303);
});
