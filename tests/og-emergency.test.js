/**
 * Order Gateway — Phase 4c: Emergency Exit (stop GTT triggered but not filled / rejected / not triggered).
 * Run with:  npm test.  In-process fake of Kite and the journal database; no network, no real account.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeWorld } = require('./helpers/fake-kite.js');
const { createGateway } = require('../og/server.js');
const { detect } = require('../og/lib/emergency-exit.js');

const IP = '203.0.113.10';
const UID = '11111111-1111-1111-1111-111111111111';
const trade = (symbol, qty, stop) => ({ id: 't_' + symbol, user_id: UID, symbol, direction: 'Long', entries: [{ qty }], pyramids: [], partial_exits: [], final_exit: null, current_stop: stop, closed_at: null });
const firedGtt = (id, symbol, qty, trigger, orderId) => ({ id, status: 'triggered', type: 'single', condition: { tradingsymbol: symbol, exchange: 'NSE', trigger_values: [trigger] },
  orders: [{ transaction_type: 'SELL', quantity: qty, price: trigger - 1.5, result: orderId ? { order_result: { order_id: orderId } } : null }] });
const activeGtt = (id, symbol, qty, trigger) => ({ id, status: 'active', type: 'single', condition: { tradingsymbol: symbol, exchange: 'NSE', trigger_values: [trigger] }, orders: [{ transaction_type: 'SELL', quantity: qty, price: trigger - 1.5 }] });
const gttOrder = (id, qty, filled = 0, status = 'OPEN') => ({ order_id: id, status, tradingsymbol: 'INFY', exchange: 'NSE', transaction_type: 'SELL', order_type: 'LIMIT', product: 'CNC', quantity: qty, filled_quantity: filled, pending_quantity: qty - filled, price: 93.5, average_price: filled ? 93.5 : 0 });

/** Gap-down: INFY 100 shares, stop 95, price 88, GTT 700 triggered, its order 900 open and unfilled. */
async function gapDown({ mode = 'confirm', sell = true, grace = 0 } = {}) {
  const w = createFakeWorld({ publicIp: IP });
  const gw = createGateway({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oge-')), fetchImpl: w.fetch, log: () => {} });
  gw.config.save({ kiteBaseUrl: 'https://kite.test', kiteLoginUrl: 'https://kite.test/connect/login', ipCheckUrl: 'https://ip.test', supabaseUrl: 'https://sb.test',
    zerodhaClientId: w.clientId, expectedStaticIp: IP, gttWritesEnabled: true, sellOrdersEnabled: sell, emergencyExit: mode, gttFillGraceSec: grace, notTriggeredGraceSec: grace,
    exitWindow: [0, 1439], fillWaitSec: 0.05, cancelWaitSec: 0.05, orderPollMs: 5 });
  gw.secrets.set('kiteApiKey', w.apiKey); gw.secrets.set('kiteApiSecret', w.apiSecret); gw.secrets.set('supabaseAnonKey', 'anon'); gw.secrets.set('journalRefreshToken', w.refreshToken);
  w.db.trades.push(trade('INFY', 100, 95));
  w.holdings.push({ tradingsymbol: 'INFY', quantity: 100, t1_quantity: 0, last_price: 88 });
  w.gtts.push(firedGtt(700, 'INFY', 100, 95, '900'));
  w.orders.push(gttOrder('900', 100));
  w.fillPrice = 87;
  await gw.completeKiteLogin('req1');
  await gw.tickIp();
  await new Promise(r => setTimeout(r, 20));
  return { w, gw };
}
const em = w => w.db.order_intents.filter(i => i.action === 'EMERGENCY_EXIT');
const sells = w => w.orderWrites.filter(x => x.method === 'POST');
const cancels = w => w.orderWrites.filter(x => x.method === 'DELETE').map(x => x.id);
const approve = i => { i.status = 'approved'; i.expires_at = new Date(Date.now() + 300000).toISOString(); };
const events = (w, id) => w.db.order_audit.filter(a => a.intent_id === id).map(a => a.event);

test('detect: unfilled only after the grace period; rejected; not triggered; nothing when filled or not held; forgets a condition that went away', () => {
  const seen = new Map(), t0 = Date.parse('2026-11-11T04:00:00Z');
  const base = { trades: [trade('INFY', 100, 95)], holdings: [{ tradingsymbol: 'INFY', quantity: 100, last_price: 88 }], positions: { net: [] } };
  const unfilled = { ...base, gtts: [firedGtt(700, 'INFY', 100, 95, '900')], orders: [gttOrder('900', 100)] };
  const run = (snap, now, o = {}) => detect(snap, { now, seen, gttFillGraceSec: 10, notTriggeredGraceSec: 60, ...o }).map(c => `${c.kind}:${c.qty}:${c.orderId || c.gttId}`);
  assert.deepEqual(run(unfilled, t0), [], 'first sighting starts the clock');
  assert.deepEqual(run(unfilled, t0 + 9000), []);
  assert.deepEqual(run(unfilled, t0 + 10000), ['GTT_ORDER_UNFILLED:100:900']);
  assert.deepEqual(run({ ...unfilled, orders: [gttOrder('900', 100, 100, 'COMPLETE')], holdings: [{ tradingsymbol: 'INFY', quantity: 0 }] }, t0 + 11000), [], 'filled → nothing');
  assert.equal(seen.size, 0, 'forgotten');
  assert.deepEqual(run({ ...unfilled, orders: [gttOrder('900', 100, 40)], holdings: [{ tradingsymbol: 'INFY', quantity: 60, last_price: 88 }] }, t0, { gttFillGraceSec: 0 }), ['GTT_ORDER_UNFILLED:60:900'], 'partly filled → only what is still held');
  assert.deepEqual(run({ ...unfilled, orders: [{ ...gttOrder('900', 100, 0, 'REJECTED'), status_message: 'price out of range' }] }, t0), ['GTT_ORDER_REJECTED:100:900']);
  const asleep = { ...base, gtts: [activeGtt(701, 'INFY', 100, 95)], orders: [] };
  assert.deepEqual(run(asleep, t0), []);
  assert.deepEqual(run(asleep, t0 + 60000), ['GTT_NOT_TRIGGERED:100:701']);
  assert.deepEqual(run({ ...asleep, holdings: [{ tradingsymbol: 'INFY', quantity: 100, last_price: 96 }] }, t0 + 61000), [], 'price above the stop → nothing');
  assert.deepEqual(run({ ...unfilled, trades: [] }, t0, { gttFillGraceSec: 0 }), [], 'not a journal position → not ours to sell');
});

test('confirm mode: proposes once with an alert, touches nothing until approved, then cancel → confirm → verify → sell → booked', async () => {
  const { w, gw } = await gapDown();
  await gw.tickExecute(); await gw.tickExecute();
  assert.equal(em(w).length, 1, 'one proposal, not one per pass');
  const i = em(w)[0];
  assert.deepEqual([i.status, i.mode, i.qty, i.trade_id, i.detail.kind, i.detail.orderId, sells(w).length, cancels(w).length], ['proposed', 'confirm', 100, 't_INFY', 'GTT_ORDER_UNFILLED', '900', 0, 0]);
  assert.match(w.db.alert_log[0].alert_type, /EMERGENCY EXIT/);
  approve(i);
  const out = await gw.tickExecute();
  assert.equal(out.done, 1);
  assert.deepEqual(cancels(w), ['900']);
  assert.equal(w.orders.find(o => o.order_id === '900').status, 'CANCELLED');
  assert.deepEqual(sells(w).map(s => [s.quantity, s.market_protection, s.transaction_type, s.order_type]), [['100', '-1', 'SELL', 'MARKET']]);
  assert.deepEqual(events(w, i.id), ['claimed', 'cancelling', 'cancel_confirmed', 'sending_sell', 'done', 'booked']);
  assert.deepEqual([i.status, i.result.filled, i.result.averagePrice, i.booking], ['done', 100, 87, 'booked_final']);
  const fe = w.db.trades[0].final_exit;
  assert.deepEqual([fe.qty, fe.price, fe.actionSource], [100, 87, 'LC-09 Hard stop — Emergency Exit (Auto)']);
  await gw.tickExecute();
  assert.deepEqual([em(w).length, sells(w).length], [1, 1], 'finished: nothing more is proposed or sold');
});

test('ladder: automatic protection, then 5%, then 10% — each unfilled sell is cancelled and confirmed before the next', async () => {
  const { w, gw } = await gapDown(); await gw.tickExecute(); const i = em(w)[0]; approve(i);
  w.sellScript = ['open', 'open', 'fill'];
  await gw.tickExecute();
  assert.deepEqual(sells(w).map(s => s.market_protection), ['-1', '5', '10']);
  assert.deepEqual(cancels(w), ['900', '5001', '5002']);
  assert.deepEqual(w.orders.map(o => o.status), ['CANCELLED', 'CANCELLED', 'CANCELLED', 'COMPLETE']);
  assert.deepEqual([i.status, i.result.filled, i.result.attempts.map(a => [a.protection, a.filled])], ['done', 100, [[-1, 0], [5, 0], [10, 100]]]);
  assert.equal(new Set(sells(w).map(s => s.tag)).size, 3, 'each attempt has its own tag');
});

test('ladder: a partial fill is kept and only the remainder is sold next; the booked price is the weighted average', async () => {
  const { w, gw } = await gapDown(); await gw.tickExecute(); const i = em(w)[0]; approve(i);
  w.sellScript = ['partial', 'fill'];
  await gw.tickExecute();
  assert.deepEqual(sells(w).map(s => [s.quantity, s.market_protection]), [['100', '-1'], ['50', '5']]);
  assert.deepEqual([i.status, i.result.filled, i.result.averagePrice, w.db.trades[0].final_exit.qty], ['done', 100, 87, 100]);
});

test('every rung fails → failed, says how many shares are still held, books nothing', async () => {
  const { w, gw } = await gapDown(); await gw.tickExecute(); const i = em(w)[0]; approve(i);
  w.sellScript = ['open', 'reject', 'open'];
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length, i.result.stillHeld, i.booking ?? null, w.db.trades[0].final_exit], ['failed', 3, 100, null, null]);
  assert.match(i.result.reason, /still holding 100 shares after 3 attempt\(s\) — sell on Kite now/);
  assert.ok(!w.orders.some(o => o.status === 'OPEN'), 'no order of ours is left open');
});

test('the GTT order cannot be cancelled → unknown, and NO sell is sent; once it is final the case is re-detected', async () => {
  const { w, gw } = await gapDown(); await gw.tickExecute(); const i = em(w)[0]; approve(i);
  w.orders[0].stuck = true;
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length], ['unknown', 0]);
  assert.match(i.result.reason, /cancellation of the existing sell order is not confirmed — no other sell will be sent/);
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length, em(w).length], ['unknown', 0, 1], 'still waiting; nothing new while one is pending');
  w.orders[0].stuck = false;
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length, w.orders[0].status], ['failed', 0, 'CANCELLED']);
  await gw.tickExecute();
  assert.deepEqual([em(w).length, em(w)[1].detail.kind, em(w)[1].status], [2, 'GTT_ORDER_REJECTED', 'proposed'], 'position still held and unprotected → proposed again');
});

test('the GTT order was partly filled: only the shares still held are sold, and never more than the broker holds', async () => {
  const { w, gw } = await gapDown();
  Object.assign(w.orders[0], { filled_quantity: 40, pending_quantity: 60 }); w.holdings[0].quantity = 60;
  await gw.tickExecute(); const i = em(w)[0];
  assert.equal(i.qty, 60);
  approve(i); await gw.tickExecute();
  assert.deepEqual([sells(w).map(s => s.quantity), i.status, i.booking, w.db.trades[0].partial_exits.map(x => x.qty)], [['60'], 'done', 'booked_partial', [60]]);
  // the 40 the GTT itself sold is not booked by the gateway: the reconcile report keeps showing it
  assert.ok(w.db.drift_log.some(d => d.symbol === 'INFY' && d.status === 'open'));
});

test('auto mode: an unfilled GTT order is handled without approval; a GTT that has not triggered always waits for you', async () => {
  const { w, gw } = await gapDown({ mode: 'auto' });
  await gw.tickExecute();
  const i = em(w)[0];
  assert.deepEqual([i.status, i.detail.auto, sells(w).length, w.db.trades[0].final_exit.qty], ['done', true, 1, 100]);

  const { w: w2, gw: gw2 } = await gapDown({ mode: 'auto' });
  w2.gtts.length = 0; w2.orders.length = 0; w2.gtts.push(activeGtt(701, 'INFY', 100, 95));
  await gw2.tickExecute(); await gw2.tickExecute();
  assert.deepEqual([em(w2)[0].status, em(w2)[0].detail.kind, sells(w2).length], ['proposed', 'GTT_NOT_TRIGGERED', 0]);
});

test('GTT not triggered: on approval the GTT is deleted first, then sold; if the price is back above the stop nothing is done', async () => {
  let { w, gw } = await gapDown();
  w.gtts.length = 0; w.orders.length = 0; w.gtts.push(activeGtt(701, 'INFY', 100, 95));
  await gw.tickExecute(); let i = em(w)[0]; approve(i);
  await gw.tickExecute();
  assert.deepEqual([w.gttWrites.map(x => `${x.method}:${x.id}`), sells(w).length, i.status, w.gtts.length], [['DELETE:701'], 1, 'done', 0]);
  assert.deepEqual(events(w, i.id).slice(0, 3), ['claimed', 'gtt_deleted', 'sending_sell']);

  ({ w, gw } = await gapDown());
  w.gtts.length = 0; w.orders.length = 0; w.gtts.push(activeGtt(701, 'INFY', 100, 95));
  await gw.tickExecute(); i = em(w)[0]; approve(i);
  w.holdings[0].last_price = 97;
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length, w.gtts.length], ['failed', 0, 1]);
  assert.match(i.result.reason, /back at or above the stop/);
});

test('nothing is proposed or sold when the Emergency Exit is off, exits are off, or the grace period has not passed', async () => {
  for (const setup of [{ mode: 'off' }, { sell: false }, { grace: 3600 }]) {
    const { w, gw } = await gapDown(setup);
    await gw.tickExecute(); await gw.tickExecute();
    assert.deepEqual([em(w).length, sells(w).length, cancels(w).length], [0, 0, 0], JSON.stringify(setup));
  }
});

test('a timeout on the emergency sell: outcome unknown → next pass finds the order by its tag, does not sell again', async () => {
  const { w, gw } = await gapDown(); await gw.tickExecute(); const i = em(w)[0]; approve(i);
  w.sellScript = ['timeout_applied'];
  await gw.tickExecute();
  assert.deepEqual([i.status, sells(w).length], ['unknown', 1]);
  await gw.tickExecute();
  assert.deepEqual([i.status, i.result.filled, sells(w).length, i.booking], ['done', 100, 1, 'booked_final']);
});

test('stop-GTT fill booking: a filled GTT order is booked once as the exit; off by default; needs the order link; a partial GTT fill plus the emergency sell close the trade', async () => {
  const filled = async over => {
    const { w, gw } = await gapDown({ mode: 'off' });
    Object.assign(w.orders[0], { status: 'COMPLETE', filled_quantity: 100, pending_quantity: 0, average_price: 93.5 }); w.holdings[0].quantity = 0;
    gw.config.save({ bookGttFills: true, ...over });
    return { w, gw };
  };
  let { w, gw } = await filled({ bookGttFills: false });
  await gw.tickSync();
  assert.deepEqual([w.db.order_intents.length, w.db.trades[0].final_exit], [0, null], 'off by default');

  ({ w, gw } = await filled());
  await gw.tickSync(); await new Promise(r => setTimeout(r, 30)); await gw.tickSync();
  const i = w.db.order_intents[0], fe = w.db.trades[0].final_exit;
  assert.deepEqual([w.db.order_intents.length, i.action, i.status, i.booking, fe.qty, fe.price, fe.actionSource, fe.orderRef], [1, 'GTT_STOP_FILL', 'done', 'booked_final', 100, 93.5, 'LC-09 Hard stop — stop GTT (Auto)', '900']);
  assert.equal(w.db.drift_log.filter(d => d.status === 'open' && d.kind !== 'ORPHAN_GTT').length, 0, 'journal and broker agree again');
  assert.equal(w.kiteCalls.filter(c => c.method !== 'GET' && c.path !== '/session/token').length, 0, 'nothing was sent to the broker');

  ({ w, gw } = await filled());
  w.gtts[0].orders[0].result = null;                                     // no link from the GTT to its order → never guess
  await gw.tickSync();
  assert.deepEqual([w.db.order_intents.length, w.db.trades[0].final_exit], [0, null]);

  ({ w, gw } = await gapDown({ mode: 'auto' }));                         // GTT sold 40, the Emergency Exit sells the other 60
  gw.config.save({ bookGttFills: true });
  Object.assign(w.orders[0], { filled_quantity: 40, pending_quantity: 60, average_price: 93.5 }); w.holdings[0].quantity = 60;
  await gw.tickExecute(); await new Promise(r => setTimeout(r, 30)); await gw.tickSync(); await new Promise(r => setTimeout(r, 30));
  const t = w.db.trades[0];
  assert.deepEqual([[...t.partial_exits.map(x => x.qty), t.final_exit && t.final_exit.qty].sort(), w.db.order_intents.map(x => x.booking).sort()], [[40, 60], ['booked_final', 'booked_partial']]);
});
