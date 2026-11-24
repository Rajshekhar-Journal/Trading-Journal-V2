/**
 * Order Gateway — buy orders (entries, adds) and automatic approval (Auto-Sell, Full Auto). Run with:  npm test
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
const trade = (symbol, qty, stop) => ({ id: 't_' + symbol, user_id: 'x', symbol, direction: 'Long', entries: [{ qty }], pyramids: [], partial_exits: [], final_exit: null, current_stop: stop, closed_at: null });
const gtt = (id, symbol, qty, trigger) => ({ id, status: 'active', type: 'single', condition: { tradingsymbol: symbol, exchange: 'NSE', trigger_values: [trigger] }, orders: [{ transaction_type: 'SELL', quantity: qty, price: trigger - 1.5 }] });
let n = 0;
const buy = (w, over = {}) => { const i = { id: 'bx_' + (++n), user_id: w.uid, intent_key: 'kb' + n, mode: 'confirm', status: 'approved', action: 'ENTRY', rule_id: 'LC-01', symbol: 'TCS', exchange: 'NSE', qty: 10,
  side: 'BUY', route: 'LIMIT_IOC', limit_price: 101, ref_price: 100.5, stop_price: 95, detail: {}, expires_at: new Date(Date.now() + 300000).toISOString(), created_at: new Date(Date.now() + n).toISOString(), ...over }; w.db.order_intents.push(i); return i; };

async function ready({ buyOn = true, ip = IP, exec = {}, window = [0, 1439], protectedInfy = true } = {}) {
  const w = createFakeWorld({ publicIp: IP });
  const gw = createGateway({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ogb-')), fetchImpl: w.fetch, log: () => {} });
  gw.config.save({ kiteBaseUrl: 'https://kite.test', kiteLoginUrl: 'https://kite.test/connect/login', ipCheckUrl: 'https://ip.test', supabaseUrl: 'https://sb.test',
    zerodhaClientId: w.clientId, expectedStaticIp: ip, buyOrdersEnabled: buyOn, gttWritesEnabled: true, sellOrdersEnabled: false, entryWindow: window, fillWaitSec: 0.05, orderPollMs: 5 });
  gw.secrets.set('kiteApiKey', w.apiKey); gw.secrets.set('kiteApiSecret', w.apiSecret); gw.secrets.set('supabaseAnonKey', 'anon'); gw.secrets.set('journalRefreshToken', w.refreshToken);
  w.db.settings.push({ user_id: w.uid, data: { execution: { mode: 'confirm', maxOrderValue: 5000, ...exec } } });
  const t = trade('INFY', 100, 95); t.user_id = w.uid; w.db.trades.push(t);
  w.holdings.push({ tradingsymbol: 'INFY', quantity: 100, t1_quantity: 0, last_price: 110 });
  if (protectedInfy) w.gtts.push(gtt(700, 'INFY', 100, 95));
  await gw.completeKiteLogin('req1');
  await gw.tickIp();
  await new Promise(r => setTimeout(r, 20));
  return { w, gw };
}
const buys = w => w.orderWrites.filter(x => x.method === 'POST' && x.transaction_type === 'BUY');
const events = (w, id) => w.db.order_audit.filter(a => a.intent_id === id).map(a => a.event);

test('adapter: a buy exists only when allowed, and is always a delivery LIMIT order with validity IOC', async () => {
  const sent = [];
  const base = { baseUrl: 'https://kite.test', loginUrl: 'x', apiKey: 'k', apiSecret: 's', accessToken: 't',
    fetchImpl: async (u, init) => { sent.push(Object.fromEntries(new URLSearchParams(init.body))); return new Response(JSON.stringify({ status: 'success', data: { order_id: 1 } }), { headers: { 'Content-Type': 'application/json' } }); } };
  const none = createKiteAdapter(base), b = createKiteAdapter({ ...base, allowBuyOrders: true });
  assert.deepEqual([typeof none.placeBuyIoc, typeof b.placeBuyIoc, b.readOnly], ['undefined', 'function', false]);
  await b.placeBuyIoc({ symbol: 'TCS', qty: 10, limit: 101, tag: 'T1', product: 'MIS', order_type: 'MARKET', validity: 'DAY' });   // extra fields are ignored
  assert.equal(sent[0].transaction_type, 'BUY'); assert.equal(sent[0].order_type, 'LIMIT'); assert.equal(sent[0].product, 'CNC');
  assert.equal(sent[0].validity, 'IOC'); assert.equal(sent[0].price, '101'); assert.equal(sent[0].quantity, '10');
  await assert.rejects(() => b.placeBuyIoc({ symbol: 'TCS', qty: 10, limit: 0, tag: 'T2' }));
  await assert.rejects(() => b.placeBuyIoc({ symbol: 'TCS', qty: 1.5, limit: 100, tag: 'T3' }));
});

test('an approved entry is sent once as a limit IOC order and its fill is recorded', async () => {
  const { w, gw } = await ready(); const i = buy(w);
  await gw.tickExecute(); await gw.tickExecute();
  assert.equal(buys(w).length, 1);
  assert.equal(i.status, 'done'); assert.equal(i.result.filled, 10); assert.ok(i.result.averagePrice > 0);
  assert.ok(events(w, i.id).includes('buy_placed'));
});

test('nothing is bought while buys are switched off or the IP does not match', async () => {
  for (const setup of [{ buyOn: false }, { ip: '198.51.100.7' }]) {
    const { w, gw } = await ready(setup); const i = buy(w);
    await gw.tickExecute();
    assert.deepEqual([buys(w).length, i.status], [0, 'approved']);
  }
});

test('re-checks at the time of use: kill switch, order value cap, unprotected position, open position, window, funds', async () => {
  const cases = [
    [{ exec: { killSwitch: true } }, {}, /kill switch/],
    [{}, { qty: 100 }, /above the cap/],                                  // 100 × 101 = 10,100 > 5,000
    [{ protectedInfy: false }, {}, /not protected/],
    [{}, { symbol: 'INFY' }, /already open/],
    [{ window: [0, -1] }, {}, /entry window/],
    [{}, { limit_price: 90, ref_price: 91, stop_price: 95 }, /stop/],
  ];
  for (const [setup, over, re] of cases) {
    const { w, gw } = await ready(setup); const i = buy(w, over);
    await gw.tickExecute();
    assert.equal(buys(w).length, 0, String(re));
    assert.equal(i.status, 'failed'); assert.match(i.result.reason, re);
  }
  const { w, gw } = await ready(); w.margins.equity.net = 500; const i = buy(w);
  await gw.tickExecute();
  assert.deepEqual([buys(w).length, i.status], [0, 'failed']); assert.match(i.result.reason, /available funds/);
});

test('an add needs an open journal position; a partial fill is recorded as it is and not chased', async () => {
  const { w, gw } = await ready(); const bad = buy(w, { action: 'ADD', symbol: 'TCS' });
  await gw.tickExecute();
  assert.equal(bad.status, 'failed'); assert.match(bad.result.reason, /no open journal position/);
  w.buyBehaviour = 'partial'; w.margins.equity.net = 100000;
  const ok = buy(w, { action: 'ADD', symbol: 'INFY', qty: 20, limit_price: 111, ref_price: 110.5, stop_price: 100 });
  await gw.tickExecute(); await gw.tickExecute();
  assert.equal(buys(w).length, 1); assert.equal(ok.status, 'done'); assert.equal(ok.result.filled, 10); assert.match(ok.result.note, /partly filled/);
});

test('nothing filled, a rejection, or a broker refusal ends as failed with a reason and no second order', async () => {
  for (const beh of ['none', 'reject', 'refuse']) {
    const { w, gw } = await ready(); w.buyBehaviour = beh; const i = buy(w);
    await gw.tickExecute(); await gw.tickExecute();
    assert.equal(i.status, 'failed', beh); assert.equal(buys(w).length, 1, beh);   // exactly one attempt, never a second assert.ok(i.result.reason, beh);
  }
});

test('a lost reply is never resent: the intent becomes unknown, then failed when no order exists', async () => {
  const { w, gw } = await ready(); w.buyBehaviour = 'timeout_lost'; const i = buy(w);
  await gw.tickExecute();
  assert.equal(i.status, 'unknown');
  await gw.tickExecute();
  assert.equal(i.status, 'failed'); assert.equal(buys(w).length, 1);
});

test('automatic approval: refused without the track record, in the wrong mode, or with the kill switch; approved once earned', async () => {
  const done = (w, action, n2) => { for (let k = 0; k < n2; k++) w.db.order_intents.push({ id: `h${action}${k}${++n}`, user_id: w.uid, mode: 'confirm', status: 'done', action, decided_at: new Date().toISOString(),
    decided_by: 'user', result: action === 'STOP_ENSURE' ? { verb: 'place' } : { filled: 5 }, created_at: new Date().toISOString() }); };
  // no track record
  let { w, gw } = await ready({ exec: { mode: 'auto_full' } }); let i = buy(w, { status: 'proposed', detail: { autoEligible: true } });
  await gw.tickExecute();
  assert.deepEqual([i.status, buys(w).length], ['proposed', 0]);
  // wrong mode (Confirm): even with a record, never automatic
  ({ w, gw } = await ready({ exec: { mode: 'confirm' } })); done(w, 'ENTRY', 3); i = buy(w, { status: 'proposed', detail: { autoEligible: true } });
  await gw.tickExecute();
  assert.deepEqual([i.status, buys(w).length], ['proposed', 0]);
  // Auto-Sell never approves a buy
  ({ w, gw } = await ready({ exec: { mode: 'auto_sell' } })); done(w, 'ENTRY', 3); i = buy(w, { status: 'proposed', detail: { autoEligible: true } });
  await gw.tickExecute();
  assert.deepEqual([i.status, buys(w).length], ['proposed', 0]);
  // kill switch
  ({ w, gw } = await ready({ exec: { mode: 'auto_full', killSwitch: true } })); done(w, 'ENTRY', 3); i = buy(w, { status: 'proposed', detail: { autoEligible: true } });
  await gw.tickExecute();
  assert.deepEqual([i.status, buys(w).length], ['proposed', 0]);
  // earned, and only for proposals the planner marked eligible
  ({ w, gw } = await ready({ exec: { mode: 'auto_full', autoMinDone: 2 } })); done(w, 'ENTRY', 2);
  const manual = buy(w, { status: 'proposed', symbol: 'WIPRO' }), auto = buy(w, { status: 'proposed', detail: { autoEligible: true } });
  await gw.tickExecute();
  assert.equal(manual.status, 'proposed');
  assert.deepEqual([auto.status, auto.decided_by, buys(w).length], ['done', 'auto', 1]);
  // a track record made of automatic approvals does not count
  ({ w, gw } = await ready({ exec: { mode: 'auto_full', autoMinDone: 1 } })); done(w, 'ENTRY', 1); w.db.order_intents[w.db.order_intents.length - 1].decided_by = 'auto';
  i = buy(w, { status: 'proposed', detail: { autoEligible: true } });
  await gw.tickExecute();
  assert.equal(i.status, 'proposed');
});
