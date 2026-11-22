/**
 * Auto Trade Engine — the five modes in the planner, and booking of automatic buys into the journal. Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createMemoryClient } = require('./helpers/memory-supabase.js');

const G = globalThis;
const UID = 'u1';
const tables = {}; const client = createMemoryClient(tables);
G.TLM_HOST = 'server';
G.APP_CONFIG = { SUPABASE_URL: 'https://example.test' };
G.auth = { getClient: () => client, getUser: () => ({ id: UID }) };
G.CustomEvent = G.CustomEvent || class extends Event { constructor(n, o) { super(n); this.detail = o?.detail; } };
for (const f of ['calculations.js', 'db-cloud.js', 'engine/indicators.js', 'engine/tlm-rules.js', 'engine/tlm-engine.js', 'engine/chartbook.js', 'engine/market-data.js',
  'engine/alert-service.js', 'engine/executors.js', 'engine/guards.js', 'engine/order-planner.js', 'engine/fill-booking.js'])
  require(path.join(__dirname, '../js', f));
const { TLMOrders: O, TLMFills: F, TLMRules: { RULES } } = G;

const NOW = Date.parse('2026-11-11T05:30:00Z');            // 11:00 IST, a Wednesday
const state = { heartbeat_at: new Date(NOW - 20000).toISOString(), broker_connected: true, token_valid_until: new Date(NOW + 3600e3).toISOString(), ip_ok: true, ip_status: 'match', last_sync_at: new Date(NOW - 30000).toISOString() };
const ctx = x => ({ x: { ...O.EXEC_DEFAULTS, ...x }, execState: state, drift: [], brokerQty: { INFY: 100 }, funds: 500000, gtts: [], keys: new Set(), intentsToday: 0 });
const mk = { ltp: 100.5, intraday: [{ time: Math.floor(NOW / 1000) - 60 }] };
const entry = { rule: RULES.ENTRY, kind: 'BUY', qty: 10, price: 100.5, stop: 95, trigger: 100 };
const stop = { rule: RULES.LOCK_2R, kind: 'STOP', price: 110, stop: 100 };
const exit_ = { rule: RULES.TRAIL_EXIT, kind: 'SELL', qty: 30, price: 118, trancheId: 'T5' };
let k = 0;
async function rec(x, action, ref = {}) {
  tables.order_intents = []; const e = ctx(x);
  const row = await O.record({ alert: { id: 'a' + (++k) }, action, symbol: 'INFY', exchange: 'NSE', tradeId: 't1', watchlistId: 'w1', openQty: 100, market: mk, exec: e, now: NOW, ...ref });
  return row && { mode: row.mode, status: row.status, auto: !!(row.detail && row.detail.autoEligible) };
}

test('modes: what each of the five modes does with an entry, a stop and an exit', async () => {
  const shadow = { mode: 'shadow', status: 'shadow_ok', auto: false };
  assert.deepEqual(await rec({ mode: 'shadow' }, entry, { openQty: 0 }), { mode: 'shadow', status: 'shadow_ok', auto: false });
  // Confirm: stop always proposed; exits and buys only when ticked
  assert.deepEqual(await rec({ mode: 'confirm' }, stop), { mode: 'confirm', status: 'proposed', auto: false });
  assert.equal((await rec({ mode: 'confirm' }, exit_)).mode, 'shadow');
  assert.deepEqual(await rec({ mode: 'confirm', confirmExits: true }, exit_), { mode: 'confirm', status: 'proposed', auto: false });
  assert.equal((await rec({ mode: 'confirm' }, entry, { openQty: 0 })).mode, 'shadow');
  assert.deepEqual(await rec({ mode: 'confirm', confirmEntries: true }, entry, { openQty: 0 }), { mode: 'confirm', status: 'proposed', auto: false });
  // Auto-Sell: stops and exits are proposed AND eligible for automatic approval; buys are not
  assert.deepEqual(await rec({ mode: 'auto_sell' }, stop), { mode: 'confirm', status: 'proposed', auto: true });
  assert.deepEqual(await rec({ mode: 'auto_sell' }, exit_), { mode: 'confirm', status: 'proposed', auto: true });
  assert.equal((await rec({ mode: 'auto_sell' }, entry, { openQty: 0 })).mode, 'shadow');
  assert.deepEqual(await rec({ mode: 'auto_sell', confirmEntries: true }, entry, { openQty: 0 }), { mode: 'confirm', status: 'proposed', auto: false });
  // Full Auto: everything eligible
  assert.deepEqual(await rec({ mode: 'auto_full' }, entry, { openQty: 0 }), { mode: 'confirm', status: 'proposed', auto: true });
  assert.deepEqual(await rec({ mode: 'auto_full' }, exit_), { mode: 'confirm', status: 'proposed', auto: true });
  assert.ok(shadow);
});

test('modes: a blocked order is never eligible for automatic approval and never proposed', async () => {
  const r = await rec({ mode: 'auto_full', killSwitch: true }, entry, { openQty: 0 });
  assert.deepEqual(r, { mode: 'confirm', status: 'blocked', auto: true });   // stored as blocked: the gateway only approves status "proposed"
  assert.ok(O.isConfirmLike('auto_sell') && O.isConfirmLike('auto_full') && !O.isConfirmLike('shadow') && !O.isConfirmLike('alert'));
});

function seedBuy(over = {}) {
  tables.order_intents = [{ id: 'oi_1', user_id: UID, mode: 'confirm', status: 'done', action: 'ENTRY', symbol: 'TCS', exchange: 'NSE', qty: 10, stop_price: 95, watchlist_id: 'w1', trade_id: null,
    result: { filled: 10, averagePrice: 100.8, orderId: '5001' }, booking: null, created_at: new Date(NOW - 600000).toISOString(), updated_at: new Date(NOW - 300000).toISOString(), ...over }];
  tables.trades = []; tables.watchlist = [{ id: 'w1', user_id: UID, symbol: 'TCS', sector: 'IT', trigger_price: 100, stop_loss: 95, rpt: 2000, status: 'triggered', mode: 'real' }];
  tables.settings = [{ user_id: UID, data: { execution: { mode: 'auto_full' } } }];
}
const settings = () => tables.settings[0].data;

test('booking: a completed entry becomes one journal trade, once, and the stop GTT is then proposed', async () => {
  seedBuy();
  const out = await F.run({ settings: settings(), now: NOW });
  assert.equal(out.booked, 1);
  assert.equal(tables.trades.length, 1);
  const t = tables.trades[0];
  assert.equal(t.id, 'tr_ax_oi_1'); assert.equal(t.symbol, 'TCS'); assert.equal(t.current_stop, 95);
  assert.deepEqual([t.entries[0].qty, t.entries[0].price], [10, 100.8]);
  assert.equal(tables.order_intents[0].booking, 'booked_entry'); assert.ok(tables.order_intents[0].booked_at);
  assert.equal(tables.watchlist[0].status, 'executed');
  const stops = tables.order_intents.filter(i => i.action === 'STOP_ENSURE');
  assert.equal(stops.length, 1); assert.equal(stops[0].qty, 10); assert.equal(stops[0].trigger_price, 95); assert.equal(stops[0].detail.autoEligible, true);
  const again = await F.run({ settings: settings(), now: NOW + 60000 });                 // a second run books nothing and adds no trade
  assert.equal(again.booked, 0); assert.equal(tables.trades.length, 1);
});

test('booking: a completed add becomes a pyramid line; a stop revision raises the journal stop; nothing is booked twice', async () => {
  seedBuy({ action: 'ADD', symbol: 'TCS', trade_id: 't_tcs', result: { filled: 5, averagePrice: 106, orderId: '5002' } });
  tables.trades = [{ id: 't_tcs', user_id: UID, symbol: 'TCS', exchange: 'NSE', direction: 'Long', entries: [{ id: 'e1', qty: 10, price: 100 }], pyramids: [], partial_exits: [], stop_revisions: [],
    initial_stop: 95, current_stop: 95, closed_at: null }];
  await F.run({ settings: settings(), now: NOW });
  assert.deepEqual(tables.trades[0].pyramids.map(p => [p.id, p.qty, p.price]), [['py_ax_oi_1', 5, 106]]);
  await F.run({ settings: settings(), now: NOW + 60000 });
  assert.equal(tables.trades[0].pyramids.length, 1);
  // a revised stop that went through
  tables.order_intents.push({ id: 'oi_2', user_id: UID, mode: 'confirm', status: 'done', action: 'STOP_ENSURE', symbol: 'TCS', qty: 15, trigger_price: 101, result: { verb: 'modify' },
    booking: null, created_at: new Date(NOW - 100000).toISOString(), updated_at: new Date(NOW - 50000).toISOString() });
  await F.run({ settings: settings(), now: NOW + 120000 });
  assert.equal(tables.trades[0].current_stop, 101);
  assert.deepEqual(tables.trades[0].stop_revisions.map(r => [r.oldStop, r.newStop]), [[95, 101]]);
  assert.equal(tables.order_intents.find(i => i.id === 'oi_2').booking, 'booked_stop');
});

test('booking: in alert or shadow mode, and for a nothing-filled buy, nothing is written', async () => {
  seedBuy(); tables.settings[0].data.execution.mode = 'shadow';
  assert.equal((await F.run({ settings: settings(), now: NOW })).booked, 0); assert.equal(tables.trades.length, 0);
  seedBuy({ status: 'failed', result: { filled: 0, reason: 'nothing filled' } });
  assert.equal((await F.run({ settings: settings(), now: NOW })).booked, 0); assert.equal(tables.trades.length, 0);
});
