/**
 * Order Gateway — the stop GTT always covers exactly what Zerodha holds (C1 after buys, C2 after sells, C3 standing check). Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeWorld } = require('./helpers/fake-kite.js');
const { createGateway } = require('../og/server.js');

const IP = '203.0.113.10';
const trade = (w, symbol, qty, stop) => ({ id: 't_' + symbol, user_id: w.uid, symbol, direction: 'Long', entries: [{ qty }], pyramids: [], partial_exits: [], final_exit: null, current_stop: stop, closed_at: null });
const gtt = (id, symbol, qty, trigger) => ({ id, status: 'active', type: 'single', condition: { tradingsymbol: symbol, exchange: 'NSE', trigger_values: [trigger] }, orders: [{ transaction_type: 'SELL', quantity: qty, price: trigger - 1.5 }] });
let n = 0;
const intent = (w, over) => { const i = { id: 'px_' + (++n), user_id: w.uid, intent_key: 'kp' + n, mode: 'confirm', status: 'approved', symbol: 'INFY', exchange: 'NSE', detail: {},
  expires_at: new Date(Date.now() + 300000).toISOString(), created_at: new Date(Date.now() + n).toISOString(), ...over }; w.db.order_intents.push(i); return i; };

async function ready({ gttOn = true, sell = true, buy = true, grace = 0, autoProtect = true } = {}) {
  const w = createFakeWorld({ publicIp: IP });
  const gw = createGateway({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-')), fetchImpl: w.fetch, log: () => {} });
  gw.config.save({ kiteBaseUrl: 'https://kite.test', kiteLoginUrl: 'https://kite.test/connect/login', ipCheckUrl: 'https://ip.test', supabaseUrl: 'https://sb.test',
    zerodhaClientId: w.clientId, expectedStaticIp: IP, gttWritesEnabled: gttOn, sellOrdersEnabled: sell, buyOrdersEnabled: buy, autoProtect, protectGraceSec: grace,
    entryWindow: [0, 1439], exitWindow: [0, 1439], fillWaitSec: 0.05, cancelWaitSec: 0.05, orderPollMs: 5 });
  gw.secrets.set('kiteApiKey', w.apiKey); gw.secrets.set('kiteApiSecret', w.apiSecret); gw.secrets.set('supabaseAnonKey', 'anon'); gw.secrets.set('journalRefreshToken', w.refreshToken);
  w.db.settings.push({ user_id: w.uid, data: { execution: { mode: 'confirm', gttBufferPct: 1.5 } } });
  w.db.trades.push(trade(w, 'INFY', 100, 95));
  w.holdings.push({ tradingsymbol: 'INFY', quantity: 100, t1_quantity: 0, last_price: 110 });
  w.gtts.push(gtt(700, 'INFY', 100, 95));
  await gw.completeKiteLogin('req1');
  await gw.tickIp();
  await new Promise(r => setTimeout(r, 20));
  return { w, gw };
}
const g = (w, sym) => w.gtts.filter(x => x.status === 'active' && x.condition.tradingsymbol === sym);
const shape = x => [x.orders[0].quantity, x.condition.trigger_values[0]];
const ev = (w, id) => w.db.order_audit.filter(a => a.intent_id === id);

test('C1: a filled entry gets its stop GTT in the same pass, for the shares held, and it is verified', async () => {
  const { w, gw } = await ready();
  const i = intent(w, { action: 'ENTRY', rule_id: 'LC-01', symbol: 'TCS', qty: 10, side: 'BUY', route: 'LIMIT_IOC', limit_price: 101, ref_price: 100.5, stop_price: 95 });
  await gw.tickExecute();
  assert.equal(i.status, 'done');
  assert.deepEqual(g(w, 'TCS').map(shape), [[10, 95]]);
  assert.equal(g(w, 'TCS')[0].orders[0].price, 93.55, 'limit = trigger − 1.5%, rounded down to the tick');
  const a = ev(w, i.id).find(x => x.event === 'gtt_after_buy');
  assert.equal(a.detail.action, 'placed');
  assert.ok(ev(w, i.id).some(x => x.event === 'protect_verified'));
});

test('C1: an add raises and resizes the existing GTT; a buy is never sent while stop-GTT placement is off', async () => {
  const { w, gw } = await ready();
  const i = intent(w, { action: 'ADD', rule_id: 'LC-02', qty: 20, side: 'BUY', route: 'LIMIT_IOC', limit_price: 111, ref_price: 110, stop_price: 100 });
  await gw.tickExecute();
  assert.equal(i.status, 'done');
  assert.deepEqual(g(w, 'INFY').map(shape), [[120, 100]]);
  const off = await ready({ gttOn: false });
  const j = intent(off.w, { action: 'ENTRY', rule_id: 'LC-01', symbol: 'TCS', qty: 10, side: 'BUY', route: 'LIMIT_IOC', limit_price: 101, ref_price: 100.5, stop_price: 95 });
  await off.gw.tickExecute();
  assert.equal(off.w.orderWrites.filter(x => x.transaction_type === 'BUY').length, 0);
  assert.notEqual(j.status, 'done');
});

test('C2: GTT cut before a partial sell, sell refused → GTT restored to the 100 shares still held', async () => {
  const { w, gw } = await ready();
  w.sellBehaviour = 'refuse';
  const i = intent(w, { action: 'EXIT_PARTIAL', rule_id: 'ST-05', qty: 50, trade_id: 't_INFY', side: 'SELL', route: 'MARKET' });
  await gw.tickExecute();
  assert.equal(i.status, 'failed');
  assert.deepEqual(g(w, 'INFY').map(shape), [[100, 95]], 'back to the held quantity');
  assert.equal(ev(w, i.id).find(x => x.event === 'gtt_checked_after_exit').detail.action, 'modified');
});

test('C2: a partly filled partial sell leaves the GTT on exactly what is still held', async () => {
  const { w, gw } = await ready();
  w.sellBehaviour = 'partial';                                    // 25 of 50 sold
  const i = intent(w, { action: 'EXIT_PARTIAL', rule_id: 'ST-05', qty: 50, trade_id: 't_INFY', side: 'SELL', route: 'MARKET' });
  await gw.tickExecute();
  assert.deepEqual(g(w, 'INFY').map(shape), [[75, 95]]);
  assert.ok(i.status === 'failed' || i.status === 'done');
});

test('C3: shares sold by hand on Kite → GTT resized after the grace period; never lowered', async () => {
  const { w, gw } = await ready({ grace: 0 });
  w.gtts[0].condition.trigger_values = [98]; w.gtts[0].orders[0].price = 96.5;
  w.holdings[0].quantity = 60;
  await gw.tickExecute();
  assert.deepEqual(g(w, 'INFY').map(shape), [[60, 98]], 'quantity follows the holding; the higher trigger is kept');
  const slow = await ready({ grace: 3600 });
  slow.w.holdings[0].quantity = 60;
  await slow.gw.tickExecute();
  assert.deepEqual(g(slow.w, 'INFY').map(shape), [[100, 95]], 'waits for the grace period');
});

test('C3: a missing GTT is placed at the journal stop; a stop below the journal stop is raised', async () => {
  const { w, gw } = await ready();
  w.gtts = [];
  await gw.tickExecute();
  assert.deepEqual(g(w, 'INFY').map(shape), [[100, 95]]);
  const r = await ready();
  r.w.gtts[0].condition.trigger_values = [90];
  await r.gw.tickExecute();
  assert.deepEqual(g(r.w, 'INFY').map(shape), [[100, 95]]);
});

test('C3: hands off while a sell is live, after a GTT triggered today, or with the keeper switched off', async () => {
  const live = await ready();
  live.w.gtts = [];
  live.w.orders.push({ order_id: '77', status: 'OPEN', tradingsymbol: 'INFY', transaction_type: 'SELL', quantity: 100, filled_quantity: 0 });
  await live.gw.tickExecute();
  assert.equal(g(live.w, 'INFY').length, 0);
  const fired = await ready();
  fired.w.gtts[0].status = 'triggered'; fired.w.gtts[0].updated_at = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) + ' 10:00:00';
  await fired.gw.tickExecute();
  assert.equal(g(fired.w, 'INFY').length, 0, 'Emergency Exit owns it');
  const off = await ready({ autoProtect: false });
  off.w.gtts = [];
  await off.gw.tickExecute();
  assert.equal(g(off.w, 'INFY').length, 0);
});

test('C3: repeated failure raises one Telegram alert', async () => {
  const { w, gw } = await ready();
  w.gtts = []; w.placeBehaviour = 'reject';
  await gw.tickExecute(); await gw.tickExecute(); await gw.tickExecute();
  const al = w.db.alert_log.filter(a => a.rule_id === 'EX-06');
  assert.equal(al.length, 1);
  assert.equal(al[0].telegram_status, 'pending');
});

test('shares held outside the journal are never put under the trade stop (journal 100, broker 250)', async () => {
  const { w, gw } = await ready({ grace: 0 });
  w.holdings[0].quantity = 250;                                  // 150 extra shares outside the journal
  w.gtts = [];
  await gw.tickExecute();
  assert.deepEqual(g(w, 'INFY').map(shape), [[100, 95]], 'GTT covers the journal position only');
  const b = await ready();
  b.w.holdings[0].quantity = 250;                                // GTT 100 = journal 100 → nothing to change
  await b.gw.tickExecute();
  assert.deepEqual(g(b.w, 'INFY').map(shape), [[100, 95]]);
});
