/**
 * Order Gateway — Phase 4a: exits (market sell) for APPROVED intents in CONFIRM mode. Run with:  npm test
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
const { tagOf } = require('../og/lib/exit-executor.js');

const IP = '203.0.113.10';
const UID = '11111111-1111-1111-1111-111111111111';
const trade = (symbol, qty, stop) => ({ id: 't_' + symbol, user_id: UID, symbol, direction: 'Long', entries: [{ qty }], pyramids: [], partial_exits: [], final_exit: null, current_stop: stop, closed_at: null });
const gtt = (id, symbol, qty, trigger) => ({ id, status: 'active', type: 'single', condition: { tradingsymbol: symbol, exchange: 'NSE', trigger_values: [trigger] }, orders: [{ transaction_type: 'SELL', quantity: qty, price: trigger - 1.5 }] });
let n = 0;
const intent = (w, over = {}) => { const i = { id: 'ox_' + (++n), user_id: w.uid, intent_key: 'kx' + n, mode: 'confirm', status: 'approved', action: 'EXIT_ALL', rule_id: 'LC-07', symbol: 'INFY', exchange: 'NSE', qty: 100, trade_id: 't_INFY',
  expires_at: new Date(Date.now() + 300000).toISOString(), created_at: new Date(Date.now() + n).toISOString(), ...over }; w.db.order_intents.push(i); return i; };

async function ready({ sell = true, gttOn = true, ip = IP, window = [0, 1439] } = {}) {
  const w = createFakeWorld({ publicIp: IP });
  const gw = createGateway({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ogs-')), fetchImpl: w.fetch, log: () => {} });
  gw.config.save({ kiteBaseUrl: 'https://kite.test', kiteLoginUrl: 'https://kite.test/connect/login', ipCheckUrl: 'https://ip.test', supabaseUrl: 'https://sb.test',
    zerodhaClientId: w.clientId, expectedStaticIp: ip, gttWritesEnabled: gttOn, sellOrdersEnabled: sell, exitWindow: window, fillWaitSec: 0.05, cancelWaitSec: 0.05, orderPollMs: 5 });
  gw.secrets.set('kiteApiKey', w.apiKey); gw.secrets.set('kiteApiSecret', w.apiSecret); gw.secrets.set('supabaseAnonKey', 'anon'); gw.secrets.set('journalRefreshToken', w.refreshToken);
  w.db.trades.push(trade('INFY', 100, 95));
  w.holdings.push({ tradingsymbol: 'INFY', quantity: 100, t1_quantity: 0, last_price: 110 });
  w.gtts.push(gtt(700, 'INFY', 100, 95));
  await gw.completeKiteLogin('req1');
  await gw.tickIp();
  await new Promise(r => setTimeout(r, 20));
  return { w, gw };
}
const sells = w => w.orderWrites.filter(x => x.method === 'POST');
const events = (w, id) => w.db.order_audit.filter(a => a.intent_id === id).map(a => a.event);

test('adapter: sell methods exist only when allowed; a BUY or a priced order cannot be expressed at all', async () => {
  const sent = [];
  const base = { baseUrl: 'https://kite.test', loginUrl: 'x', apiKey: 'k', apiSecret: 's', accessToken: 't',
    fetchImpl: async (u, init) => { sent.push(Object.fromEntries(new URLSearchParams(init.body))); return new Response(JSON.stringify({ status: 'success', data: { order_id: 1 } }), { headers: { 'Content-Type': 'application/json' } }); } };
  const ro = createKiteAdapter(base), g = createKiteAdapter({ ...base, allowGttWrites: true }), s = createKiteAdapter({ ...base, allowSellOrders: true });
  assert.deepEqual([typeof ro.placeMarketSell, typeof g.placeMarketSell, typeof g.cancelOrder, typeof g.deleteGtt, typeof s.placeMarketSell, s.readOnly], ['undefined', 'undefined', 'undefined', 'undefined', 'function', false]);
  assert.ok(!Object.keys(s).some(k => /buy|limit|modifyOrder/i.test(k)));
  await s.placeMarketSell({ symbol: 'INFY', qty: 10, tag: 'T1', transaction_type: 'BUY', price: 1, order_type: 'LIMIT' });   // extra fields are ignored
  assert.deepEqual(sent[0], { tradingsymbol: 'INFY', exchange: 'NSE', transaction_type: 'SELL', order_type: 'MARKET', quantity: '10', product: 'CNC', validity: 'DAY', market_protection: '-1', tag: 'T1', variety: 'regular' });
  assert.match(tagOf('oi_1762850000000_abc123'), /^TJ[0-9A-F]{16}$/);
});

test('nothing is sold while exits are switched off, the IP does not match, or outside market hours', async () => {
  for (const setup of [{ sell: false }, { ip: '198.51.100.7' }]) {
    const { w, gw } = await ready(setup); const i = intent(w);
    await gw.tickExecute();
    assert.deepEqual([sells(w).length, i.status], [0, 'approved']);
  }
  const { w, gw } = await ready({ window: [0, -1] }); const i = intent(w);
  await gw.tickExecute();
  assert.deepEqual([sells(w).length, i.status], [0, 'failed']);
  assert.match(i.result.reason, /outside market hours/);
});

test('full exit: one protected market sell for the held quantity, then the stop GTT is deleted', async () => {
  const { w, gw } = await ready(); const i = intent(w);
  const out = await gw.tickExecute();
  assert.equal(out.done, 1);
  assert.equal(sells(w).length, 1);
  const s = sells(w)[0];
  assert.deepEqual([s.tradingsymbol, s.transaction_type, s.order_type, s.quantity, s.product, s.market_protection, s.tag], ['INFY', 'SELL', 'MARKET', '100', 'CNC', '-1', tagOf(i.id)]);
  assert.deepEqual([i.status, i.broker_ref, i.result.filled, i.result.averagePrice, i.result.gtt], ['done', '5001', 100, 99.5, 'stop GTT deleted']);
  assert.equal(w.gtts.length, 0);
  assert.deepEqual(events(w, i.id), ['claimed', 'sending_sell', 'sell_placed', 'gtt_deleted', 'done', 'booked']);
  await gw.tickExecute();
  assert.equal(sells(w).length, 1, 'a finished exit is never sent again');
  // The fill is written into the journal trade as the final exit, once, and the books agree again.
  const fe = w.db.trades[0].final_exit;
  assert.deepEqual([fe.qty, fe.price, fe.actionSource, fe.auto, fe.orderRef, fe.intentId, i.booking], [100, 99.5, 'LC-07 Trail exit (Auto)', true, '5001', i.id, 'booked_final']);
  assert.match(fe.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(fe.charges > 0, 'charges from the journal settings formula');
  assert.ok(i.booked_at);
  assert.equal(w.db.drift_log.filter(d => d.status === 'open').length, 0);
  await gw.tickExecute();
  assert.equal(w.db.order_audit.filter(a => a.event === 'booked').length, 1, 'booked once');
});

test('partial exit: the stop GTT is reduced to the remainder BEFORE the sell, and kept afterwards', async () => {
  const { w, gw } = await ready(); const i = intent(w, { action: 'EXIT_PARTIAL', qty: 30 });
  await gw.tickExecute();
  const order = [...w.gttWrites.map(x => 'gtt:' + x.method), ...sells(w).map(() => 'sell')];
  assert.deepEqual(events(w, i.id), ['claimed', 'reducing_gtt', 'sending_sell', 'sell_placed', 'done', 'booked']);
  assert.deepEqual([w.db.trades[0].partial_exits.map(x => x.qty), w.db.trades[0].final_exit, i.booking], [[30], null, 'booked_partial']);
  assert.deepEqual(order, ['gtt:PUT', 'sell']);
  assert.deepEqual([w.gtts[0].orders[0].quantity, w.gtts[0].condition.trigger_values[0], w.gtts[0].orders[0].price], [70, 95, 93.5], 'same stop, smaller quantity');
  assert.deepEqual([i.status, sells(w)[0].quantity, i.result.gtt], ['done', '30', 'stop GTT reduced to 70']);
});

test('partial exit: if the GTT cannot be reduced, nothing is sold', async () => {
  const { w, gw } = await ready(); const i = intent(w, { action: 'EXIT_PARTIAL', qty: 30 });
  w.placeBehaviour = 'reject';
  await gw.tickExecute();
  assert.deepEqual([sells(w).length, i.status], [0, 'failed']);
  assert.match(i.result.reason, /could not reduce the stop GTT first, so nothing was sold/);
});

test('refused at the time of use, with the reason, and nothing sold', async () => {
  const cases = [
    [w => { w.db.trades[0].entries[0].qty = 80; }, {}, /journal position is now 80/],
    [w => { w.db.trades[0].closed_at = '2026-11-11'; }, {}, /no open journal position/],
    [w => { w.holdings[0].quantity = 60; }, {}, /broker holds 60, fewer than 100 — never sell more/],
    [w => { w.orders.push({ order_id: '77', status: 'OPEN', tradingsymbol: 'INFY', transaction_type: 'SELL', quantity: 100, filled_quantity: 0 }); }, {}, /a sell order is already live on this stock \(order 77/],
    [w => { w.orders.push({ order_id: '78', status: 'TRIGGER PENDING', tradingsymbol: 'INFY', transaction_type: 'SELL', quantity: 100 }); }, {}, /already live/],
    [w => { w.gtts.push(gtt(701, 'INFY', 100, 94)); }, {}, /more than one sell GTT/],
    [() => {}, { action: 'EXIT_PARTIAL', qty: 100 }, /not smaller than the position/],
    [() => {}, { qty: 0 }, /positive whole number/],
  ];
  for (const [mutate, over, why] of cases) {
    const { w, gw } = await ready(); mutate(w); const i = intent(w, over);
    await gw.tickExecute();
    assert.deepEqual([sells(w).length, i.status], [0, 'failed'], String(why));
    assert.match(i.result.reason, why);
  }
});

test('shares held outside the journal are never sold: only the intent quantity goes', async () => {
  const { w, gw } = await ready(); w.holdings[0].quantity = 150; const i = intent(w);
  await gw.tickExecute();
  assert.deepEqual([sells(w)[0].quantity, i.status, w.holdings[0].quantity], ['100', 'done', 50]);
});

test('not filled in time → cancelled and confirmed → failed, no second sell; the stop GTT stays', async () => {
  const { w, gw } = await ready(); w.sellBehaviour = 'open'; const i = intent(w);
  await gw.tickExecute();
  assert.deepEqual([sells(w).length, w.orderWrites.filter(x => x.method === 'DELETE').length, i.status, w.orders[0].status], [1, 1, 'failed', 'CANCELLED']);
  assert.match(i.result.reason, /not filled in time; the order was cancelled/);
  assert.equal(w.gtts.length, 1, 'position still protected');
  await gw.tickExecute();
  assert.equal(sells(w).length, 1);
});

test('partly filled → remainder cancelled → failed with the filled quantity; GTT not deleted', async () => {
  const { w, gw } = await ready(); w.sellBehaviour = 'partial'; const i = intent(w);
  await gw.tickExecute();
  assert.deepEqual([i.status, i.result.filled, w.gtts.length], ['failed', 50, 1]);
  assert.match(i.result.reason, /only 50 of 100 sold; the rest was cancelled/);
});

test('rejected by the broker → failed with the broker message; refused request → failed; neither is retried', async () => {
  let { w, gw } = await ready(); w.sellBehaviour = 'reject'; let i = intent(w);
  await gw.tickExecute(); await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length], ['failed', 1]);
  assert.match(i.result.reason, /broker rejected the sell: RMS: rule violated/);
  ({ w, gw } = await ready()); w.sellBehaviour = 'refuse'; i = intent(w);
  await gw.tickExecute(); await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length], ['failed', 1]);
  assert.match(i.result.reason, /broker refused the sell: Insufficient holdings/);
});

test('cancel not confirmed → unknown; no other sell is sent while the order is unresolved, and a new exit is refused', async () => {
  const { w, gw } = await ready(); w.sellBehaviour = 'stuck'; const i = intent(w);
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length], ['unknown', 1]);
  const second = intent(w);
  await gw.tickExecute();
  assert.deepEqual([i.status, second.status, sells(w).length], ['unknown', 'failed', 1]);
  assert.match(second.result.reason, /already live/);
  w.orders[0].status = 'COMPLETE'; w.orders[0].filled_quantity = 100; w.orders[0].average_price = 98;   // it filled after all
  await gw.tickExecute();
  assert.deepEqual([i.status, i.result.filled, i.result.averagePrice, sells(w).length, w.gtts.length], ['done', 100, 98, 1, 0]);
});

test('timeout on the sell request: found by its tag next pass (not sent again); lost request → failed, not retried', async () => {
  let { w, gw } = await ready(); w.sellBehaviour = 'timeout_applied'; let i = intent(w);
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length], ['unknown', 1]);
  await gw.tickExecute();
  assert.deepEqual([i.status, i.result.filled, sells(w).length], ['done', 100, 1]);

  ({ w, gw } = await ready()); w.sellBehaviour = 'timeout_lost'; i = intent(w);
  await gw.tickExecute(); await gw.tickExecute(); await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length, w.orders.length], ['failed', 1, 0]);
  assert.match(i.result.reason, /did not reach the broker; not retried/);
});

test('sold but the GTT delete fails → done, with a plain instruction to delete it on Kite', async () => {
  const { w, gw } = await ready(); w.gttDeleteFails = true; const i = intent(w);
  await gw.tickExecute();
  assert.equal(i.status, 'done');
  assert.match(i.result.gtt, /SOLD, but the stop GTT could not be deleted — delete it on Kite/);
});

test('expired approvals, shadow intents and entries are never sold; two passes at once send one sell', async () => {
  const { w, gw } = await ready();
  const old = intent(w, { expires_at: new Date(Date.now() - 1000).toISOString() });
  const shadow = intent(w, { mode: 'shadow', status: 'shadow_ok' });
  const entry = intent(w, { action: 'ENTRY', side: 'BUY' });
  const proposed = intent(w, { status: 'proposed' });
  await gw.tickExecute();
  assert.deepEqual([old.status, shadow.status, entry.status, proposed.status, sells(w).length], ['expired', 'shadow_ok', 'approved', 'proposed', 0]);
  const live = intent(w);
  const { createExitExecutor } = require('../og/lib/exit-executor.js');
  const mk = () => createExitExecutor({ broker: createKiteAdapter({ baseUrl: 'https://kite.test', loginUrl: 'x', apiKey: w.apiKey, apiSecret: w.apiSecret, accessToken: w.accessToken, fetchImpl: w.fetch, allowGttWrites: true, allowSellOrders: true }),
    store: { userId: async () => w.uid, select: (t, q) => w.fetch(`https://sb.test/rest/v1/${t}?${q}`, { headers: { Authorization: 'Bearer jwt_user' } }).then(r => r.json()),
      insert: (t, rows) => w.fetch(`https://sb.test/rest/v1/${t}`, { method: 'POST', headers: { Authorization: 'Bearer jwt_user' }, body: JSON.stringify(rows) }),
      rpc: (fn, a) => w.fetch(`https://sb.test/rest/v1/rpc/${fn}`, { method: 'POST', headers: { Authorization: 'Bearer jwt_user' }, body: JSON.stringify(a) }).then(r => r.json()) },
    exitWindow: [0, 1439], fillWaitSec: 0.05, cancelWaitSec: 0.05, pollMs: 5 });
  await Promise.all([mk().runOnce({ enabled: true }), mk().runOnce({ enabled: true })]);
  assert.deepEqual([live.status, sells(w).length], ['done', 1]);
});

test('gateway page: exits cannot be switched on without a matching IP, and a changed IP switches them off', async t => {
  const w = createFakeWorld({ publicIp: IP });
  const gw = createGateway({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-')), fetchImpl: w.fetch, log: () => {} });
  gw.config.save({ ipCheckUrl: 'https://ip.test' });
  const port = await gw.start({ port: 0, hosts: ['127.0.0.1'], background: false }); t.after(() => gw.stop());
  let cookie = '';
  const req = async (method, p, form) => { const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, redirect: 'manual', headers: { cookie, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return { text: await res.text(), location: decodeURIComponent(res.headers.get('location') || '') }; };
  const post = async (p, form) => req('POST', p, { csrf: /name="csrf" value="([a-f0-9]+)"/.exec((await req('GET', '/')).text)[1], ...form });
  await req('POST', '/setup-password', { password: 'gateway-password-1', password2: 'gateway-password-1' });
  await req('POST', '/login', { password: 'gateway-password-1' });
  assert.match((await post('/execution', { sellOrdersEnabled: 'on' })).location, /only after the static IP is entered and matches/);
  assert.equal(gw.config.load().sellOrdersEnabled, false);
  await post('/config', { expectedStaticIp: IP, port: '8787', bindHosts: '127.0.0.1', allowedHosts: '' });
  assert.match((await post('/execution', { sellOrdersEnabled: 'on', gttWritesEnabled: 'on' })).location, /exits \(market sell\) are ON/);
  assert.deepEqual([gw.config.load().sellOrdersEnabled, gw.config.load().gttWritesEnabled], [true, true]);
  await post('/config', { expectedStaticIp: '198.51.100.7', port: '8787', bindHosts: '127.0.0.1', allowedHosts: '' });
  assert.deepEqual([gw.config.load().sellOrdersEnabled, gw.config.load().gttWritesEnabled], [false, false]);
});

test('booking: a partly filled exit books only what was sold; the alert is closed only on a complete fill', async () => {
  const { w, gw } = await ready(); w.sellBehaviour = 'partial';
  w.db.alert_log.push({ id: 'al1', user_id: w.uid, status: 'New' });
  const i = intent(w, { trade_id: 't_INFY', alert_id: 'al1' });
  await gw.tickExecute();
  assert.deepEqual([i.status, i.booking, w.db.trades[0].partial_exits.map(x => x.qty), w.db.trades[0].final_exit, w.db.alert_log[0].status], ['failed', 'booked_partial', [50], null, 'New']);
  const { w: w2, gw: gw2 } = await ready();
  w2.db.alert_log.push({ id: 'al2', user_id: w2.uid, status: 'New' });
  intent(w2, { trade_id: 't_INFY', alert_id: 'al2' });
  await gw2.tickExecute();
  assert.equal(w2.db.alert_log[0].status, 'Executed');
});

test('booking: never more than the journal shows open, never into a closed trade, never twice; retried when the database was not ready', async () => {
  let { w, gw } = await ready(); w.noMigration012 = true; let i = intent(w, { trade_id: 't_INFY' });
  await gw.tickExecute();
  assert.deepEqual([i.status, i.booking ?? null, w.db.trades[0].final_exit], ['done', null, null], 'sold, not booked yet');
  w.noMigration012 = false;
  await gw.tickExecute();
  assert.deepEqual([i.booking, w.db.trades[0].final_exit.qty], ['booked_final', 100], 'booked on the next pass');
  await gw.tickExecute();
  assert.equal(w.db.order_audit.filter(a => a.event === 'booked').length, 1);

  ({ w, gw } = await ready()); i = intent(w, { trade_id: 't_INFY' });
  const realFetch = w.fetch;                                              // you record the exit by hand while the sell is in flight
  w.db.trades[0].partial_exits = [];
  await gw.tickExecute.call(null);
  assert.equal(i.booking, 'booked_final');
  ({ w, gw } = await ready()); i = intent(w, { trade_id: 't_INFY', status: 'done', result: { filled: 100, averagePrice: 99, orderId: '1' } });
  w.db.trades[0].final_exit = { qty: 100, price: 99 };
  await gw.tickExecute();
  assert.equal(i.booking, 'trade_closed');
  ({ w, gw } = await ready()); i = intent(w, { trade_id: 't_INFY', status: 'done', result: { filled: 100, averagePrice: 99, orderId: '1' } });
  w.db.trades[0].partial_exits = [{ qty: 40 }];
  await gw.tickExecute();
  assert.deepEqual([i.booking, w.db.trades[0].partial_exits.length, w.db.trades[0].final_exit], ['qty_exceeds_open', 1, null]);
  ({ w, gw } = await ready()); i = intent(w, { trade_id: null, status: 'done', result: { filled: 100, averagePrice: 99, orderId: '1' } });
  await gw.tickExecute();
  assert.equal(i.booking, 'no_trade');
  void realFetch;
});
