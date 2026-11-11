/**
 * Auto Trade Engine — Phase 2 (SHADOW). Run with:  npm test
 *  1. Planner: each engine action becomes the right order intent (route, quantity, prices).
 *  2. Guards: every guard blocks or warns as specified; unknown facts block entries and warn exits.
 *  3. Runner: with mode = alert nothing is recorded; with mode = shadow each real alert yields one
 *     intent, repeated cycles add no duplicates, alerts are unchanged and nothing is "sent".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createMemoryClient } = require('./helpers/memory-supabase.js');

const G = globalThis;
const UID = 'u1';
let tables = {}, client = createMemoryClient(tables);
G.TLM_HOST = 'server';
G.APP_CONFIG = { SUPABASE_URL: 'https://example.test' };
G.auth = { getClient: () => client, getUser: () => ({ id: UID }) };
G.CustomEvent = G.CustomEvent || class extends Event { constructor(n, o) { super(n); this.detail = o?.detail; } };
for (const f of ['calculations.js', 'db-cloud.js', 'engine/indicators.js', 'engine/tlm-rules.js', 'engine/tlm-engine.js', 'engine/chartbook.js',
  'engine/market-data.js', 'engine/alert-service.js', 'engine/executors.js', 'engine/guards.js', 'engine/order-planner.js', 'engine/runner.js'])
  require(path.join(__dirname, '../js', f));
const { TLMOrders: O, TLMGuards: GD, TLMRules: { RULES } } = G;

const X = { ...O.EXEC_DEFAULTS, mode: 'shadow' };
const NOW = Date.parse('2026-11-11T05:30:00Z');            // 11:00 IST, a Wednesday
const okState = { heartbeat_at: new Date(NOW - 20000).toISOString(), broker_connected: true, token_valid_until: new Date(NOW + 3600e3).toISOString(), ip_ok: true, ip_status: 'match', last_sync_at: new Date(NOW - 30000).toISOString() };
const gctx = over => ({ now: NOW, minute: 660, x: X, execState: okState, drift: [], brokerQty: { INFY: 100 }, funds: 500000, intentsToday: 0,
  ltp: 100.5, quoteAt: NOW - 30000, openQty: 100, trigger: 100, stop: 95, ...over });
const failed = rs => rs.filter(r => !r.ok && r.level === 'block').map(r => r.id);
const warned = rs => rs.filter(r => !r.ok && r.level === 'warn').map(r => r.id);

// ── Planner ──
test('planner: entry and add become IOC limit buys inside the band', () => {
  const e = O.plan({ rule: RULES.ENTRY, kind: 'BUY', qty: 50, price: 100.5, stop: 95, trigger: 100 }, { symbol: 'INFY', watchlistId: 'w1', openQty: 0, ltp: 100.5 }, X);
  assert.deepEqual([e.action, e.side, e.qty, e.route, e.limit_price, e.stop_price], ['ENTRY', 'BUY', 50, 'LIMIT_IOC', 101, 95]);
  const a = O.plan({ rule: RULES.ADD_1R, kind: 'BUY', qty: 50, price: 105, stop: 100 }, { symbol: 'INFY', tradeId: 't1', openQty: 50, ltp: 105 }, X);
  assert.deepEqual([a.action, a.route, a.limit_price], ['ADD', 'LIMIT_IOC', 106.05]);
});

test('planner: stop → GTT for the whole open quantity with a limit below the trigger; trail is tracked, not sent', () => {
  const s = O.plan({ rule: RULES.LOCK_2R, kind: 'STOP', price: 110, stop: 100 }, { symbol: 'INFY', tradeId: 't1', openQty: 100, ltp: 110 }, X);
  assert.deepEqual([s.action, s.route, s.qty, s.trigger_price, s.gtt_limit_price], ['STOP_ENSURE', 'GTT', 100, 100, 98.5]);
  const b = O.plan({ rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: 100, stop: 100, trail: 108, trailQty: 30 }, { symbol: 'INFY', tradeId: 't1', openQty: 100, ltp: 110 }, X);
  assert.equal(b.action, 'STOP_ENSURE');
  assert.match(b.detail.note, /tracked by the engine/);
  const t = O.plan({ rule: RULES.BOOK_5R, kind: 'TRAIL', qty: 30, price: 125, trail: 118, trancheId: 'T5' }, { symbol: 'INFY', tradeId: 't1', openQty: 100, ltp: 125 }, X);
  assert.deepEqual([t.action, t.route], ['TRAIL_TRACK', 'NONE']);
});

test('planner: exits are market sells with automatic protection, in the right order around the GTT', () => {
  const p = O.plan({ rule: RULES.TRAIL_EXIT, kind: 'SELL', qty: 30, price: 118, trancheId: 'T5' }, { symbol: 'INFY', tradeId: 't1', openQty: 100, ltp: 118 }, X);
  assert.deepEqual([p.action, p.route, p.market_protection, p.qty], ['EXIT_PARTIAL', 'MARKET', -1, 30]);
  assert.match(p.detail.before, /reduce stop GTT quantity to 70/);
  const f = O.plan({ rule: RULES.TRAIL_EXIT, kind: 'EXIT_ALL', qty: 70, price: 118 }, { symbol: 'INFY', tradeId: 't1', openQty: 70, ltp: 118 }, X);
  assert.match(f.detail.after, /delete the stop GTT/);
  const h = O.plan({ rule: RULES.HARD_EXIT, kind: 'EXIT_ALL', qty: 100, price: 94, stop: 95 }, { symbol: 'INFY', tradeId: 't1', openQty: 100, ltp: 94 }, X);
  assert.match(h.detail.note, /Emergency Exit/);
});

test('intent key: same signal same day is one key; a moved stop is a new key', () => {
  const mk = stop => O.plan({ rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: 100, stop }, { symbol: 'INFY', tradeId: 't1', openQty: 100, ltp: 110 }, X);
  const a = { rule: RULES.DAY_BRIEF };
  assert.equal(O.intentKey(mk(100), a, '2026-11-11'), O.intentKey(mk(100), a, '2026-11-11'));
  assert.notEqual(O.intentKey(mk(100), a, '2026-11-11'), O.intentKey(mk(102), a, '2026-11-11'));
  assert.notEqual(O.intentKey(mk(100), a, '2026-11-11'), O.intentKey(mk(100), a, '2026-11-12'));
});

// ── Guards ──
const ENTRY = { action: 'ENTRY', symbol: 'INFY', qty: 50, limit_price: 101 };
test('guards: a clean entry passes every guard', () => {
  const rs = GD.evaluate(ENTRY, gctx());
  assert.deepEqual([failed(rs), warned(rs), GD.wouldSend(rs)], [[], [], true]);
});

test('guards: each switch blocks an entry', () => {
  const one = (over, id) => assert.deepEqual(failed(GD.evaluate(ENTRY, gctx(over))), [id], id);
  one({ x: { ...X, mode: 'alert' } }, 'MODE');
  one({ x: { ...X, killSwitch: true } }, 'KILL_SWITCH');
  one({ execState: { ...okState, heartbeat_at: new Date(NOW - 600000).toISOString() } }, 'GATEWAY_ONLINE');
  one({ execState: { ...okState, broker_connected: false } }, 'BROKER_LOGIN');
  one({ execState: { ...okState, token_valid_until: new Date(NOW - 1000).toISOString() } }, 'BROKER_LOGIN');
  one({ execState: { ...okState, ip_ok: false, ip_status: 'mismatch' } }, 'STATIC_IP');
  one({ minute: 555 }, 'MARKET_WINDOW');
  one({ minute: 920 }, 'MARKET_WINDOW');
  assert.deepEqual(failed(GD.evaluate(ENTRY, gctx({ execState: null }))), ['GATEWAY_ONLINE', 'BROKER_LOGIN', 'STATIC_IP']);
});

test('guards: gap-up, slip, stale quote, price at stop, value, funds, daily cap and unprotected positions block an entry', () => {
  const one = (over, id, intent = ENTRY) => assert.deepEqual(failed(GD.evaluate(intent, gctx(over))), [id], id);
  one({ ltp: 103.5 }, 'ENTRY_NOT_GAPPED');                         // > 3% above trigger
  one({ ltp: 101.5 }, 'ENTRY_NOT_GAPPED');                         // > 0.25R (1.25) above trigger
  one({ quoteAt: NOW - 200000 }, 'QUOTE_FRESH');
  one({ quoteAt: null }, 'QUOTE_FRESH');
  assert.deepEqual(failed(GD.evaluate(ENTRY, gctx({ ltp: 94 }))), ['PRICE_ABOVE_STOP']);
  one({ x: { ...X, maxOrderValue: 5000 } }, 'ORDER_VALUE');
  one({ funds: 4000 }, 'FUNDS');
  one({ funds: null }, 'FUNDS');
  one({ intentsToday: 30 }, 'ORDERS_PER_DAY');
  one({ drift: [{ kind: 'NO_STOP_GTT', symbol: 'TCS' }] }, 'ALL_POSITIONS_PROTECTED');
  one({ drift: null }, 'ALL_POSITIONS_PROTECTED');
  assert.deepEqual(failed(GD.evaluate(ENTRY, gctx({ drift: [{ kind: 'BROKER_ONLY', symbol: 'X' }, { kind: 'ORPHAN_GTT', symbol: 'Y' }] }))), [], 'manual holdings do not block');
  one({}, 'QTY_VALID', { ...ENTRY, qty: 0 });
});

test('guards: exits are not stopped by the kill switch or unprotected positions; unknowns only warn', () => {
  const EXIT = { action: 'EXIT_ALL', symbol: 'INFY', qty: 100 };
  const rs = GD.evaluate(EXIT, gctx({ x: { ...X, killSwitch: true }, drift: [{ kind: 'NO_STOP_GTT', symbol: 'TCS' }], quoteAt: null, brokerQty: null, funds: null }));
  assert.deepEqual([failed(rs), warned(rs).sort(), GD.wouldSend(rs)], [[], ['QUOTE_FRESH', 'WITHIN_BROKER_QTY'], true]);
  assert.deepEqual(failed(GD.evaluate(EXIT, gctx({ minute: 921 }))), [], 'exit window is wider than the entry window');
});

test('guards: never sell more than the lifecycle or the broker holds; stop at or above price is refused', () => {
  assert.deepEqual(failed(GD.evaluate({ action: 'EXIT_PARTIAL', symbol: 'INFY', qty: 120 }, gctx())), ['WITHIN_LIFECYCLE_QTY', 'WITHIN_BROKER_QTY']);
  assert.deepEqual(failed(GD.evaluate({ action: 'EXIT_ALL', symbol: 'INFY', qty: 100 }, gctx({ brokerQty: { INFY: 60 } }))), ['WITHIN_BROKER_QTY']);
  assert.deepEqual(failed(GD.evaluate({ action: 'EXIT_ALL', symbol: 'INFY', qty: 100 }, gctx({ brokerQty: {} }))), ['WITHIN_BROKER_QTY']);
  assert.deepEqual(failed(GD.evaluate({ action: 'STOP_ENSURE', symbol: 'INFY', qty: 100, trigger_price: 101 }, gctx())), ['STOP_BELOW_PRICE']);
  assert.deepEqual(failed(GD.evaluate({ action: 'STOP_ENSURE', symbol: 'INFY', qty: 100, trigger_price: 95 }, gctx())), []);
});

// ── Runner in shadow mode ──
const DAY = 864e5;
function marketSource(prices) {
  return async (tk, interval) => {
    const px = prices[tk.replace(/\.(NS|BO)$/, '')] ?? 100;
    const mk = c => ({ meta: { regularMarketPrice: px }, timestamp: c.map(x => x.time), indicators: { quote: [{ open: c.map(x => x.o), high: c.map(x => x.h), low: c.map(x => x.l), close: c.map(x => x.c) }] } });
    if (interval === '1d') return mk(Array.from({ length: 60 }, (_, i) => ({ time: Math.floor((Date.now() - (60 - i) * DAY) / 1000), o: px - 2, h: px - 1, l: px - 3, c: px - 2 })));
    const last = Math.floor(Date.now() / 60000) * 60 - 60;
    return mk(Array.from({ length: 10 }, (_, i) => ({ time: last - (9 - i) * 60, o: px, h: px, l: px, c: px })));
  };
}
function seed(execution) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, {
    settings: [{ user_id: UID, data: { rMode: 'fixed', fixedR: 10000, ...(execution ? { execution } : {}) } }],
    trades: [{ id: 'tr1', user_id: UID, symbol: 'REAL1', direction: 'Long', trade_type: 'Equity', exchange: 'NSE', initial_stop: 95, current_stop: 95, cmp: 100,
      entries: [{ id: 'en1', date: today, price: 100, qty: 100, charges: 0 }], pyramids: [], partial_exits: [], final_exit: null, stop_revisions: [], alerts: [], notes: [], tags: [], created_at: new Date().toISOString() }],
    paper_trades: [], capital: [{ id: 'c1', user_id: UID, date: '2026-01-01', type: 'Deposit', amount: 1000000, running_balance: 1000000 }],
    watchlist: [{ id: 'wl1', user_id: UID, symbol: 'WATCH1', trigger_price: 100, stop_loss: 95, status: 'monitoring', mode: 'real', created_at: new Date().toISOString() }],
    alert_log: [], trade_snapshots: [], runner_status: [{ id: 'tlm-runner' }],
    exec_state: [], drift_log: [], broker_snapshots: [], broker_gtts: [], order_intents: [],
  });
}

test('runner: mode alert (default) records no intent and reads no execution tables', async () => {
  seed(null);
  G.TLMMarketData.setSource(marketSource({ WATCH1: 101, REAL1: 101 }));
  assert.equal(await G.TLMRunner.runCycle({ force: true }), true);
  assert.deepEqual(G.TLMRunner.lastErrors(), []);
  assert.ok(tables.alert_log.some(a => a.symbol === 'WATCH1' && a.mode === 'real'), 'alert still raised');
  assert.equal(tables.order_intents.length, 0);
});

test('runner: shadow mode records one intent per real alert, blocked with reasons, never duplicated, alerts unchanged', async () => {
  seed(null);
  G.TLMMarketData.setSource(marketSource({ WATCH1: 101, REAL1: 101 }));
  await G.TLMRunner.runCycle({ force: true });
  const alertsWithout = tables.alert_log.map(a => `${a.symbol}:${a.rule_id}:${a.mode}`).sort();

  seed({ mode: 'shadow' });
  await G.TLMRunner.runCycle({ force: true });
  assert.deepEqual(G.TLMRunner.lastErrors(), []);
  assert.deepEqual(tables.alert_log.map(a => `${a.symbol}:${a.rule_id}:${a.mode}`).sort(), alertsWithout, 'shadow mode does not change alerts');
  assert.equal(tables.watchlist[0].status, 'triggered');

  const entry = tables.order_intents.find(i => i.symbol === 'WATCH1');
  assert.ok(entry, 'entry intent recorded');
  assert.deepEqual([entry.action, entry.route, entry.side, entry.mode, entry.user_id], ['ENTRY', 'LIMIT_IOC', 'BUY', 'shadow', UID]);
  assert.equal(entry.limit_price, 101.5);
  assert.equal(entry.alert_id, tables.alert_log.find(a => a.symbol === 'WATCH1').id);
  // No gateway has reported in this test → it must be blocked, with the reasons written down.
  assert.deepEqual([entry.status, entry.would_send], ['shadow_blocked', false]);
  for (const id of ['GATEWAY_ONLINE', 'BROKER_LOGIN', 'STATIC_IP', 'FUNDS', 'ALL_POSITIONS_PROTECTED']) assert.ok(entry.block_reasons.some(r => r.startsWith(id + ':')), id);
  assert.ok(entry.guards.length >= 10 && entry.guards.every(g => 'ok' in g && g.detail));

  const n = tables.order_intents.length, keys = tables.order_intents.map(i => i.intent_key);
  assert.equal(new Set(keys).size, n, 'keys are unique');
  tables.watchlist[0].status = 'monitoring';                      // even if the same signal fires again today
  tables.alert_log.length = 0;
  await G.TLMRunner.runCycle({ force: true });
  assert.equal(tables.order_intents.filter(i => i.symbol === 'WATCH1').length, 1, 'same signal, same day → still one intent');
});

test('runner: with a healthy gateway and a protected book the same entry would be sent; an in-place stop GTT is a no-op', async () => {
  seed({ mode: 'shadow' });
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  tables.exec_state.push({ user_id: UID, heartbeat_at: iso(now), broker_connected: true, token_valid_until: iso(now + 3600e3), ip_ok: true, ip_status: 'match', last_sync_at: iso(now) });
  tables.broker_snapshots.push({ user_id: UID, kind: 'funds', data: { equity: { net: 900000, available: { live_balance: 800000 } } } },
    { user_id: UID, kind: 'holdings', data: [{ tradingsymbol: 'REAL1', quantity: 100, t1_quantity: 0 }] }, { user_id: UID, kind: 'positions', data: { net: [] } });
  const ctx = await O.loadContext({ settings: tables.settings[0].data, now });
  assert.deepEqual([ctx.funds, ctx.brokerQty.REAL1, ctx.drift.length], [800000, 100, 0]);

  const minute = G.TLMIndicators.istMinutes(now);
  const inHours = minute >= 560 && minute <= 915;
  const market = { ltp: 100.5, intraday: [{ time: Math.floor(now / 1000) - 90 }] };
  const row = await O.record({ alert: { id: 'al1' }, action: { rule: RULES.ENTRY, kind: 'BUY', qty: 50, price: 100.5, stop: 95, trigger: 100 }, symbol: 'NEWCO', watchlistId: 'w9', openQty: 0, market, trigger: 100, exec: ctx, now });
  const blocked = row.guards.filter(g => !g.ok && g.level === 'block').map(g => g.id);
  assert.deepEqual(blocked, inHours ? [] : ['MARKET_WINDOW'], 'only the clock can block this entry');
  assert.equal(row.status, inHours ? 'shadow_ok' : 'shadow_blocked');
  assert.equal(await O.record({ alert: { id: 'al2' }, action: { rule: RULES.ENTRY, kind: 'BUY', qty: 50, price: 100.5, stop: 95 }, symbol: 'NEWCO', watchlistId: 'w9', openQty: 0, market, trigger: 100, exec: ctx, now }), null, 'duplicate refused');

  tables.broker_gtts.push({ user_id: UID, gtt_id: '7', present: true, status: 'active', tradingsymbol: 'REAL1', trigger_values: [95], orders: [{ transaction_type: 'SELL', quantity: 100 }] });
  const ctx2 = await O.loadContext({ settings: tables.settings[0].data, now });
  const stop = await O.record({ alert: { id: 'al3' }, action: { rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: 100, stop: 95 }, symbol: 'REAL1', tradeId: 'tr1', openQty: 100, market: { ltp: 101, intraday: market.intraday }, exec: ctx2, now });
  assert.equal(stop.status, 'shadow_noop');
  const moved = await O.record({ alert: { id: 'al4' }, action: { rule: RULES.LOCK_2R, kind: 'STOP', stop: 100 }, symbol: 'REAL1', tradeId: 'tr1', openQty: 100, market: { ltp: 110, intraday: market.intraday }, exec: ctx2, now });
  assert.deepEqual([moved.action, moved.trigger_price, moved.gtt_limit_price], ['STOP_ENSURE', 100, 98.5]);
  assert.ok(tables.order_intents.every(i => i.mode === 'shadow'), 'nothing leaves shadow');
});

// ── Confirm mode: stop GTTs only ──
test('confirm mode: an engine stop that passes the guards is PROPOSED; entries stay shadow; blocked stops are not proposed', async () => {
  seed({ mode: 'confirm' });
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  tables.exec_state.push({ user_id: UID, heartbeat_at: iso(now), broker_connected: true, token_valid_until: iso(now + 3600e3), ip_ok: true, ip_status: 'match', last_sync_at: iso(now) });
  tables.broker_snapshots.push({ user_id: UID, kind: 'holdings', data: [{ tradingsymbol: 'REAL1', quantity: 100, t1_quantity: 0 }] }, { user_id: UID, kind: 'positions', data: { net: [] } });
  const market = { ltp: 110, intraday: [{ time: Math.floor(now / 1000) - 90 }] };
  const ctx = await O.loadContext({ settings: tables.settings[0].data, now });
  const stop = await O.record({ alert: { id: 'a1' }, action: { rule: RULES.LOCK_2R, kind: 'STOP', stop: 100 }, symbol: 'REAL1', tradeId: 'tr1', openQty: 100, market, exec: ctx, now });
  assert.deepEqual([stop.mode, stop.status, stop.trigger_price, stop.gtt_limit_price, stop.qty], ['confirm', 'proposed', 100, 98.5, 100]);
  assert.ok(Date.parse(stop.expires_at) - now > 14 * 60000, 'waits about 15 minutes for approval');
  const entry = await O.record({ alert: { id: 'a2' }, action: { rule: RULES.ENTRY, kind: 'BUY', qty: 10, price: 110, stop: 100, trigger: 110 }, symbol: 'NEWCO', watchlistId: 'w1', openQty: 0, market, trigger: 110, exec: ctx, now });
  assert.equal(entry.mode, 'shadow');
  assert.match(entry.status, /^shadow_/);
  const tooMany = await O.record({ alert: { id: 'a3' }, action: { rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: 150, stop: 101 }, symbol: 'REAL1', tradeId: 'tr1', openQty: 150, market, exec: ctx, now });
  assert.deepEqual([tooMany.mode, tooMany.status], ['confirm', 'blocked']);
  assert.ok(tooMany.block_reasons.some(r => r.startsWith('WITHIN_BROKER_QTY')));
});

test('propose stop from the protection report: needs confirm mode, one pending per stock, guarded like an engine stop', async () => {
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const p = { symbol: 'REAL1', journalQty: 100, journalStop: 95, lastPrice: 101 };
  seed({ mode: 'shadow' });
  await assert.rejects(O.proposeStop({ p, takenAt: iso(now), settings: tables.settings[0].data, now }), /Switch the mode to Confirm/);
  seed({ mode: 'confirm' });
  tables.exec_state.push({ user_id: UID, heartbeat_at: iso(now), broker_connected: true, token_valid_until: iso(now + 3600e3), ip_ok: true, ip_status: 'match', last_sync_at: iso(now) });
  tables.broker_snapshots.push({ user_id: UID, kind: 'holdings', data: [{ tradingsymbol: 'REAL1', quantity: 100 }] });
  const s = tables.settings[0].data;
  await assert.rejects(O.proposeStop({ p: { ...p, journalStop: null }, takenAt: iso(now), settings: s, now }), /no stop in the journal/);
  const row = await O.proposeStop({ p, takenAt: iso(now), settings: s, now });
  assert.deepEqual([row.mode, row.status, row.action, row.rule_id, row.qty, row.trigger_price, row.gtt_limit_price], ['confirm', 'proposed', 'STOP_ENSURE', 'MANUAL', 100, 95, 93.6]);
  await assert.rejects(O.proposeStop({ p, takenAt: iso(now), settings: s, now: now + 1 }), /already waiting/);
  tables.order_intents[0].status = 'failed';
  const again = await O.proposeStop({ p: { ...p, lastPrice: 94 }, takenAt: iso(now), settings: s, now: now + 2 });
  assert.equal(again.status, 'blocked');
  assert.ok(again.block_reasons.some(r => r.startsWith('STOP_BELOW_PRICE')), 'a stop at or above the price is never proposed');
  tables.exec_state[0].ip_ok = false;
  const noIp = await O.proposeStop({ p, takenAt: iso(now), settings: s, now: now + 3 });
  assert.ok(noIp.status === 'blocked' && noIp.block_reasons.some(r => r.startsWith('STATIC_IP')));
});

test('confirm mode: exits are proposed for approval only when "confirm exits" is ticked; entries always stay shadow', async () => {
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const market = { ltp: 118, intraday: [{ time: Math.floor(now / 1000) - 90 }] };
  const exit = { rule: RULES.TRAIL_EXIT, kind: 'EXIT_ALL', qty: 100, price: 118 };
  const run = async (execution, action, ref) => {
    seed(execution);
    tables.exec_state.push({ user_id: UID, heartbeat_at: iso(now), broker_connected: true, token_valid_until: iso(now + 3600e3), ip_ok: true, ip_status: 'match', last_sync_at: iso(now) });
    tables.broker_snapshots.push({ user_id: UID, kind: 'holdings', data: [{ tradingsymbol: 'REAL1', quantity: 100 }] }, { user_id: UID, kind: 'funds', data: { equity: { net: 900000 } } });
    const exec = await O.loadContext({ settings: tables.settings[0].data, now });
    return O.record({ alert: { id: 'a1' }, action, symbol: 'REAL1', tradeId: 'tr1', openQty: 100, market, exec, now, ...ref });
  };
  const off = await run({ mode: 'confirm' }, exit);
  assert.deepEqual([off.mode, /^shadow_/.test(off.status)], ['shadow', true]);
  const on = await run({ mode: 'confirm', confirmExits: true }, exit);
  const inHours = (m => m >= 556 && m <= 925)(G.TLMIndicators.istMinutes(now));
  assert.deepEqual([on.mode, on.action, on.route, on.market_protection, on.status], ['confirm', 'EXIT_ALL', 'MARKET', -1, inHours ? 'proposed' : 'blocked']);
  const entry = await run({ mode: 'confirm', confirmExits: true }, { rule: RULES.ENTRY, kind: 'BUY', qty: 50, price: 100.5, stop: 95, trigger: 100 }, { tradeId: null, watchlistId: 'w1', openQty: 0, market: { ltp: 100.5, intraday: market.intraday }, trigger: 100 });
  assert.equal(entry.mode, 'shadow', 'no buy is ever proposed for sending');
});
