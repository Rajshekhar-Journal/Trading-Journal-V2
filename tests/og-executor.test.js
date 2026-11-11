/**
 * Order Gateway — Phase 3: stop-GTT placement for APPROVED intents (CONFIRM mode). Run with:  npm test
 * In-process fake of Kite and the journal database; no network, no real account.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeWorld } = require('./helpers/fake-kite.js');
const { createKiteAdapter } = require('../og/lib/kite-adapter.js');
const { createGateway } = require('../og/server.js');

const IP = '203.0.113.10';
const trade = (symbol, qty, stop, extra = {}) => ({ id: 't_' + symbol, user_id: '11111111-1111-1111-1111-111111111111', symbol, direction: 'Long', entries: [{ qty }], pyramids: [], partial_exits: [], final_exit: null, current_stop: stop, closed_at: null, ...extra });
const gtt = (id, symbol, qty, trigger) => ({ id, status: 'active', type: 'single', condition: { tradingsymbol: symbol, exchange: 'NSE', trigger_values: [trigger] }, orders: [{ transaction_type: 'SELL', quantity: qty, price: trigger - 1 }] });
let n = 0;
const intent = (w, over = {}) => { const i = { id: 'oi_' + (++n), user_id: w.uid, intent_key: 'k' + n, mode: 'confirm', status: 'approved', action: 'STOP_ENSURE', symbol: 'INFY', exchange: 'NSE', qty: 100, trigger_price: 95, gtt_limit_price: 93.55, expires_at: new Date(Date.now() + 300000).toISOString(), created_at: new Date(Date.now() + n).toISOString(), ...over }; w.db.order_intents.push(i); return i; };

/** A gateway that is logged in, linked, with a matching static IP. Stop-GTT placement on unless told otherwise. */
async function ready({ enable = true, ip = IP } = {}) {
  const w = createFakeWorld({ publicIp: IP });
  const gw = createGateway({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ogx-')), fetchImpl: w.fetch, log: () => {} });
  gw.config.save({ kiteBaseUrl: 'https://kite.test', kiteLoginUrl: 'https://kite.test/connect/login', ipCheckUrl: 'https://ip.test', supabaseUrl: 'https://sb.test',
    zerodhaClientId: w.clientId, expectedStaticIp: ip, gttWritesEnabled: enable });
  gw.secrets.set('kiteApiKey', w.apiKey); gw.secrets.set('kiteApiSecret', w.apiSecret); gw.secrets.set('supabaseAnonKey', 'anon'); gw.secrets.set('journalRefreshToken', w.refreshToken);
  w.db.trades.push(trade('INFY', 100, 95));
  w.holdings.push({ tradingsymbol: 'INFY', quantity: 100, t1_quantity: 0, last_price: 101 });
  await gw.completeKiteLogin('req1');
  await gw.tickIp();
  await new Promise(r => setTimeout(r, 20));        // let the login's background sync finish
  return { w, gw };
}
const writes = w => w.gttWrites.map(x => x.method);
const events = (w, id) => w.db.order_audit.filter(a => a.intent_id === id).map(a => a.event);

test('adapter: GTT writes exist only when allowed, and there is still no order or delete method', () => {
  const base = { baseUrl: 'https://kite.test', loginUrl: 'x', apiKey: 'k', apiSecret: 's', fetchImpl: async () => { throw new Error('unused'); } };
  const ro = createKiteAdapter(base), rw = createKiteAdapter({ ...base, allowGttWrites: true });
  assert.deepEqual([ro.readOnly, typeof ro.placeStopGtt, rw.readOnly, typeof rw.placeStopGtt, typeof rw.modifyStopGtt], [true, 'undefined', false, 'function', 'function']);
  for (const name of Object.keys(rw)) assert.ok(!/order|cancel|delete/i.test(name) || name === 'orders', `unexpected method ${name}`);
});

test('nothing is sent while placement is switched off, the IP does not match, or there is no login', async () => {
  for (const setup of [{ enable: false }, { ip: '198.51.100.7' }]) {
    const { w, gw } = await ready(setup); const i = intent(w);
    await gw.tickExecute(); await gw.tickHeartbeat();
    assert.deepEqual([writes(w), i.status, w.db.exec_state[0].order_sending_enabled], [[], 'approved', false]);
  }
  const { w, gw } = await ready(); const i = intent(w);
  w.tokenDead = true; await gw.tickSync();                               // token dropped
  await gw.tickExecute();
  assert.deepEqual([writes(w), i.status], [[], 'approved']);
});

test('place: no GTT at the broker → one POST with the exact stop, verified, recorded, protection turns PROTECTED', async () => {
  const { w, gw } = await ready(); const i = intent(w);
  assert.equal(w.db.broker_snapshots.find(x => x.kind === 'protection').data[0].state, 'UNPROTECTED');
  const out = await gw.tickExecute();
  assert.equal(out.done, 1);
  assert.deepEqual(writes(w), ['POST']);
  const sent = w.gttWrites[0];
  assert.deepEqual([sent.cond.tradingsymbol, sent.cond.trigger_values, sent.cond.last_price], ['INFY', [95], 101]);
  assert.deepEqual(sent.orders, [{ exchange: 'NSE', tradingsymbol: 'INFY', transaction_type: 'SELL', quantity: 100, order_type: 'LIMIT', product: 'CNC', price: 93.55 }]);
  assert.deepEqual([i.status, i.broker_ref], ['done', '9001']);
  assert.deepEqual(events(w, i.id), ['claimed', 'sending_place', 'done']);
  assert.equal(w.db.broker_snapshots.find(x => x.kind === 'protection').data[0].state, 'PROTECTED');
  assert.equal(w.db.exec_state[0].order_sending_enabled, true);
  await gw.tickExecute();
  assert.deepEqual(writes(w), ['POST'], 'a finished intent is never sent again');
});

test('modify: one GTT with an older, lower stop → one PUT on that GTT; same level and quantity → nothing sent', async () => {
  const { w, gw } = await ready();
  w.gtts.push(gtt(501, 'INFY', 100, 90));
  const i = intent(w); await gw.tickExecute();
  assert.deepEqual([writes(w), w.gttWrites[0].id, i.status, i.broker_ref, w.gtts[0].condition.trigger_values[0]], [['PUT'], '501', 'done', '501', 95]);
  const j = intent(w); await gw.tickExecute();
  assert.deepEqual([writes(w), j.status, events(w, j.id)], [['PUT'], 'done', ['claimed', 'already_in_place']]);
});

test('refused at the time of use, with the reason, and nothing sent', async () => {
  const cases = [
    [w => { w.db.trades[0].entries = [{ qty: 60 }]; }, /journal position is now 60/],
    [w => { w.db.trades[0].closed_at = '2026-11-11'; }, /no open journal position/],
    [w => { w.db.trades[0].current_stop = 97; }, /not a stop level of this position/],
    [w => { w.holdings[0].quantity = 40; }, /broker holds 40/],
    [w => { w.holdings[0].last_price = 94; }, /at or above the price 94/],
    [w => { w.holdings[0].last_price = 0; }, /no last price/],
    [w => { w.gtts.push(gtt(1, 'INFY', 100, 90), gtt(2, 'INFY', 100, 91)); }, /2 sell GTTs already exist/],
    [w => { w.gtts.push(gtt(1, 'INFY', 100, 98)); }, /never lowered automatically/],
    [(w, i) => { i.gtt_limit_price = 96; }, /limit price must be below the trigger/],
    [(w, i) => { i.qty = 0; }, /positive whole number/],
  ];
  for (const [mutate, why] of cases) {
    const { w, gw } = await ready(); const i = intent(w); mutate(w, i);
    await gw.tickExecute();
    assert.deepEqual([writes(w), i.status], [[], 'failed'], String(why));
    assert.match(i.result.reason, why);
    assert.deepEqual(events(w, i.id), ['claimed', 'refused']);
  }
});

test('the engine stop (tlm_state.hardStop) is accepted even when the journal stop has not been revised yet', async () => {
  const { w, gw } = await ready();
  w.db.trades[0].tlm_state = { hardStop: 98 };
  const i = intent(w, { trigger_price: 98, gtt_limit_price: 96.55 }); await gw.tickExecute();
  assert.deepEqual([i.status, w.gttWrites[0].cond.trigger_values], ['done', [98]]);
});

test('broker refusal → failed with the broker message; no retry', async () => {
  const { w, gw } = await ready(); w.placeBehaviour = 'reject'; const i = intent(w);
  await gw.tickExecute(); await gw.tickExecute();
  assert.deepEqual([writes(w), i.status], [['POST'], 'failed']);
  assert.match(i.result.reason, /broker refused: Trigger price is too close/);
});

test('timeout: outcome unknown → the next pass checks the broker instead of sending again', async () => {
  let { w, gw } = await ready(); w.placeBehaviour = 'timeout_applied'; let i = intent(w);
  await gw.tickExecute();
  assert.deepEqual([i.status, writes(w)], ['unknown', ['POST']]);
  w.placeBehaviour = 'ok'; await gw.tickExecute();
  assert.deepEqual([i.status, i.broker_ref, writes(w), w.gtts.length], ['done', '9001', ['POST'], 1], 'found at the broker; exactly one GTT, one request');

  ({ w, gw } = await ready()); w.placeBehaviour = 'timeout_lost'; i = intent(w);
  await gw.tickExecute();
  w.placeBehaviour = 'ok'; await gw.tickExecute(); await gw.tickExecute();
  assert.deepEqual([i.status, writes(w), w.gtts.length], ['failed', ['POST'], 0], 'request never arrived; reported, not re-sent');
  assert.match(i.result.reason, /not retried/);
});

test('an approval that has expired is not sent; only approved confirm stop intents are touched', async () => {
  const { w, gw } = await ready();
  const old = intent(w, { expires_at: new Date(Date.now() - 1000).toISOString() });
  const others = [intent(w, { status: 'proposed' }), intent(w, { status: 'rejected' }), intent(w, { mode: 'shadow', status: 'shadow_ok' }), intent(w, { action: 'ENTRY' }), intent(w, { action: 'EXIT_ALL' })];
  const before = others.map(o => o.status);
  await gw.tickExecute();
  assert.deepEqual([old.status, writes(w), others.map(o => o.status)], ['expired', [], before]);
});

test('two passes at the same moment send one request (claim is compare-and-swap)', async () => {
  const { w, gw } = await ready(); const i = intent(w);
  const { createExecutor } = require('../og/lib/executor.js');
  const { createSupabase } = require('../og/lib/supabase-rest.js');
  const mk = () => createExecutor({
    broker: createKiteAdapter({ baseUrl: 'https://kite.test', loginUrl: 'x', apiKey: w.apiKey, apiSecret: w.apiSecret, accessToken: w.accessToken, fetchImpl: w.fetch, allowGttWrites: true }),
    store: createSupabase({ url: 'https://sb.test', anonKey: 'anon', fetchImpl: w.fetch, getRefreshToken: () => w.refreshToken, setRefreshToken: () => {} }) });
  await Promise.all([mk().runOnce({ enabled: true }), mk().runOnce({ enabled: true })]);
  assert.deepEqual([writes(w), i.status, w.gtts.length], [['POST'], 'done', 1]);
});

test('gateway page: placement cannot be switched on without a matching IP, and a changed IP switches it off', async t => {
  const { w, gw } = await ready({ enable: false, ip: '' });
  const port = await gw.start({ port: 0, hosts: ['127.0.0.1'], background: false }); t.after(() => gw.stop());
  gw.secrets.set('adminPasswordHash', require('../og/lib/admin-auth.js').hashPassword('gateway-password-1'));
  let cookie = '';
  const req = async (method, p, form) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual', headers: { cookie, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined }); const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0]; return { text: await r.text(), location: decodeURIComponent(r.headers.get('location') || '') }; };
  await req('POST', '/login', { password: 'gateway-password-1' });
  const post = async (p, f) => req('POST', p, { csrf: /name="csrf" value="([a-f0-9]+)"/.exec((await req('GET', '/')).text)[1], ...f });
  assert.match((await post('/execution', { gttWritesEnabled: 'on' })).location, /only after the static IP/);
  assert.equal(gw.config.load().gttWritesEnabled, false);
  await post('/config', { expectedStaticIp: IP, port: '8787', bindHosts: '127.0.0.1', allowedHosts: '' });
  assert.match((await post('/execution', { gttWritesEnabled: 'on' })).location, /placement is ON/);
  assert.match((await req('GET', '/')).text, /ON — approved intents only/);
  await post('/config', { expectedStaticIp: '198.51.100.7', port: '8787', bindHosts: '127.0.0.1', allowedHosts: '' });
  assert.equal(gw.config.load().gttWritesEnabled, false, 'IP no longer matches → switched off');
  const i = intent(w); await gw.tickExecute();
  assert.deepEqual([writes(w), i.status], [[], 'approved']);
});
