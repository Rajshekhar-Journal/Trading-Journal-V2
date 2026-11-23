/**
 * Trade-management strategies: A unchanged; B (2R stop to cost, 3R trailed profit tranche, two-level 21 EMA exit, time exit);
 * custom rules (incl. immediate-sale partial); switching; frozen specs; alert reasons; paper booking. Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const G = globalThis;
G.TLM_HOST = 'server';
for (const f of ['indicators.js', 'tlm-rules.js', 'tlm-engine.js', 'strategies.js']) require(path.join(__dirname, '../js/engine', f));
const S = G.TLMStrategies, E = G.TLMEngine, R = G.TLMRules;
global.db = global.db || {};
require(path.join(__dirname, '../js/engine/alert-service.js'));
const A = G.TLMAlerts;

const NOW = Date.parse('2026-11-18T11:30:00+05:30');                       // a Wednesday
const day = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
const mkDaily = (n, start, step, endDate) => { const d = new Date(endDate + 'T00:00:00Z'); const out = []; for (let i = n - 1; i >= 0; i--) { const x = new Date(d - i * 86400000).toISOString().slice(0, 10); const c = start + step * (n - 1 - i); out.push(day(x, c, c + 1, c - 1, c)); } return out; };
const minutes = (ltp, n, endMs, low) => Array.from({ length: n }, (_, i) => ({ time: Math.floor(endMs / 1000) - (n - i) * 60, open: ltp, high: ltp, low: low ?? ltp, close: ltp }));
const settings = {};
const p = { ...R.DEFAULT_PARAMS };
const ENTERED = Date.parse('2026-11-02T10:00:00+05:30');
const stateB = (over = {}) => ({ ...S.createState({ strategyId: 'B', entryPrice: 100, firstQty: 1000, initialStop: 95, params: p, settings, now: ENTERED }), ...over });
const ev = (s, ltp, open = 1000, intraday) => S.evaluate({ state: s, position: { openQty: open, avgEntry: 100 }, market: { ltp, intraday: intraday || minutes(ltp, 6, NOW), daily: [] }, now: NOW, params: p });
const ds = (s, daily, open = 1000, ltp = 120, now = NOW) => S.dayStart({ state: s, position: { openQty: open, avgEntry: 100 }, market: { ltp, daily }, now, params: p });

test('list: A, B and custom; default A; B carries the agreed rules', () => {
  const l = S.list({ strategies: [{ id: 'c1', name: 'Trend', partial: { on: false }, trail: { type: 'ema', period: 21, bufferPct: 0 }, timeExit: { on: false } }] });
  assert.deepEqual(l.map(x => x.id), ['A', 'B', 'c1']);
  const b = S.find('B', settings);
  assert.deepEqual([b.entryPct, b.add.on, b.stopToCost.on, b.stopToCost.atR, b.partial.mode, b.partial.atR, b.partial.pct, b.partial.holdMin, b.partial.largeAtr, b.partial.largeFrac],
    [100, false, true, 2, 'trail', 3, 50, 5, 3, 0.25]);
  assert.deepEqual([b.trail.type, b.trail.period, b.trail.deepPct, b.trail.confirm, b.timeExit.days, b.timeExit.minR], ['ema', 21, 2, true, 10, 1]);
  assert.equal(S.validate(b), null);
  assert.equal(S.defaultId({}), 'A'); assert.equal(S.defaultId({ defaultStrategy: 'B' }), 'B');
  const d = S.describe(b).join(' ');
  assert.match(d, /at 2R the hard stop moves to your average cost/);
  assert.match(d, /at 3R, 50% becomes a tranche .* sold after 5 min below the stop/);
  assert.match(d, /21 EMA − 2% exits; a close between that and the EMA marks a warning low/);
});

test('strategy A is exactly the lifecycle engine', () => {
  const a = S.createState({ strategyId: 'A', entryPrice: 100, firstQty: 100, initialStop: 95, params: p, settings, now: NOW });
  assert.deepEqual(a, E.createState({ entryPrice: 100, firstQty: 100, initialStop: 95, params: p, now: NOW }));
  const mk = { ltp: 106, intraday: minutes(106, 6, NOW), daily: [] }, pos = { openQty: 100, avgEntry: 100 };
  assert.deepEqual(S.evaluate({ state: a, position: pos, market: mk, now: NOW, params: p }), E.evaluate({ state: a, position: pos, market: mk, now: NOW, params: p }));
  assert.equal(S.paramsFor('B', p, settings).firstEntryPct, 100);
});

test('B at 2R: stop to cost (once); nothing sold', () => {
  const r = ev(stateB(), 111);
  assert.deepEqual(r.actions.map(a => [a.rule, a.kind, a.stop]), [['ST-04', 'STOP', 100]]);
  assert.match(r.actions[0].why, /held above 2R \(₹110\.00\).*stop to your cost ₹100\.00/);
  assert.deepEqual([r.state.costDone, r.state.hardStop, R.stageLabel(r.state)], [true, 100, 'Stop at cost (2R)']);
  assert.deepEqual(ev(r.state, 112).actions, [], 'once only');
});

test('B at 3R: no sale — 50% gets a profit-booking stop = max(today\'s low, hard stop); gapping through 2R does both', () => {
  const intraday = [...minutes(116, 6, NOW).map((c, i) => (i === 0 ? { ...c, low: 108 } : c))];
  const r = ev(stateB(), 116, 1000, intraday);
  assert.deepEqual(r.actions.map(a => [a.rule, a.kind, a.qty ?? a.stop]), [['ST-04', 'STOP', 100], ['ST-01', 'TRAIL', 500]]);
  const t = r.actions[1];
  assert.equal(t.trail, 108); assert.match(t.why, /no sale yet: 500 shares get a profit-booking stop ₹108\.00/);
  assert.deepEqual([r.state.partialDone, S.activeTranche(r.state).trail, R.stageLabel(r.state)], [true, 108, 'Tranche trailing (3R)']);
  const low = ev(stateB({ hardStop: 112, costDone: true, lastEvalAt: NOW - 120000 }), 116, 1000, intraday);   // the ₹108 low came before the stop was raised
  assert.equal(S.activeTranche(low.state).trail, 112, 'hard stop above the day low wins');
});

test('B tranche: sold only after 5 minutes below its stop', () => {
  const s = ev(stateB(), 116, 1000, minutes(116, 6, NOW).map((c, i) => (i === 0 ? { ...c, low: 108 } : c))).state;
  const later = NOW + 86400000;
  const dip = [...minutes(110, 2, later - 180000), ...minutes(107, 3, later)];
  assert.deepEqual(S.evaluate({ state: s, position: { openQty: 1000, avgEntry: 100 }, market: { ltp: 107, intraday: dip, daily: [] }, now: later, params: p }).actions, [], '3 minutes below: no sale');
  const r = S.evaluate({ state: s, position: { openQty: 1000, avgEntry: 100 }, market: { ltp: 107, intraday: minutes(107, 6, later), daily: [] }, now: later, params: p });
  assert.deepEqual(r.actions.map(a => [a.rule, a.kind, a.qty]), [['ST-05', 'SELL', 500]]);
  assert.match(r.actions[0].why, /held below the profit-booking stop ₹108\.00 for 5 min — sell the 500-share tranche/);
  assert.equal(S.activeTranche(r.state), null);
});

test('B morning: tranche stop = max(prev low, stop); after a candle wider than 3 × ATR, max(low + 0.25 × range, stop); never down', () => {
  const s = ev(stateB(), 116, 1000, minutes(116, 6, NOW).map((c, i) => (i === 0 ? { ...c, low: 108 } : c))).state;
  const base = mkDaily(30, 90, 0.5, '2026-11-17');                       // ATR ≈ 2 (each day high − low = 2)
  const d2 = Date.parse('2026-11-19T09:00:00+05:30');
  const normal = [...base.slice(0, -1), day('2026-11-18', 112, 118, 112, 117)];          // range 6 ≤ 3 × ATR? ATR ≈ 2.1 → 6.3: normal
  let r = ds(s, normal, 1000, 117, d2);
  assert.equal(S.activeTranche(r.state).trail, 112);
  assert.match(r.actions.at(-1).why, /profit-booking stop ₹112\.00 for 500 shares \(yesterday's low ₹112\.00\)/);
  const d3 = Date.parse('2026-11-20T09:00:00+05:30');
  const large = [...normal, day('2026-11-19', 118, 131, 117, 130)];      // range 14 > 3 × ATR
  r = ds(r.state, large, 1000, 130, d3);
  assert.equal(S.activeTranche(r.state).trail, 120.5);
  const d4 = Date.parse('2026-11-23T09:00:00+05:30');
  r = ds(r.state, [...large, day('2026-11-20', 125, 126, 110, 125)], 1000, 125, d4);
  assert.equal(S.activeTranche(r.state).trail, 120.5, 'never moves down');
});

test('B trend exit on the trailed half: close < EMA − 2% sells; warning-zone close sets a warning low; later close below it sells; close above EMA clears', () => {
  const s = stateB({ partialDone: true, costDone: true, hardStop: 100, tranches: [{ id: 'P1', qty: 500, trail: 108, status: 'active' }] });
  const up = mkDaily(40, 100, 1, '2026-11-17');                          // EMA21 of 100..139 ≈ 129
  const e = G.TLMIndicators.ema(up.map(c => c.close), 21);
  const at = (d) => Date.parse(`2026-11-${d}T09:00:00+05:30`);
  // deep break
  const deep = [...up, day('2026-11-18', 130, 131, 120, Math.floor(e * 0.97))];
  let r = ds(s, deep, 1000, 125, at(19));
  assert.deepEqual(r.actions.slice(0, 1).map(a => [a.rule, a.kind, a.qty]), [['ST-02', 'SELL', 500]], 'only the trailed half; the tranche keeps its own stop');
  assert.match(r.actions[0].why, /below the 21 EMA − 2%/);
  // warning, then confirmation
  const warnDay = day('2026-11-18', 130, 131, 126.4, Math.round(e * 0.99 * 100) / 100);
  r = ds(s, [...up, warnDay], 1000, 128, at(19));
  assert.equal(r.actions[0].kind, 'BRIEF'); assert.equal(r.state.warnLow, 126.4);
  const e2 = G.TLMIndicators.ema([...up, warnDay].map(c => c.close), 21);
  const holdDay = day('2026-11-19', 128, 129, 127, Math.max(126.5, Math.round(e2 * 0.985 * 100) / 100));
  const r2 = ds(r.state, [...up, warnDay, day('2026-11-19', 128, 129, 125, 126.3)], 1000, 126, at(20));
  assert.deepEqual(r2.actions[0].rule, 'ST-02'); assert.match(r2.actions[0].why, /below the warning low ₹126\.40/);
  // close back above the EMA clears the warning
  const r3 = ds(r.state, [...up, warnDay, day('2026-11-19', 128, 140, 128, 139)], 1000, 139, at(20));
  assert.equal(r3.state.warnLow, null); assert.ok(holdDay);
  // after the tranche is sold, a trend exit closes everything
  const solo = stateB({ partialDone: true, costDone: true, hardStop: 100 });
  const r4 = ds(solo, deep, 500, 125, at(19));
  assert.deepEqual([r4.actions[0].kind, r4.actions[0].qty, r4.state.closed], ['EXIT_ALL', 500, true]);
});

test('B: trail is off before 3R; time exit when +1R never reached in 10 trading days', () => {
  const flat = [];
  for (let d = 2; d <= 17; d++) { const dt = `2026-11-${String(d).padStart(2, '0')}`; if (![7, 8, 14, 15].includes(d)) flat.push(day(dt, 100, 103, 98, 101)); }
  const r = ds(stateB(), flat, 1000, 101);
  assert.deepEqual([r.actions[0].rule, r.actions[0].kind, r.actions[0].qty], ['ST-03', 'EXIT_ALL', 1000]);
  const touched = flat.map((c, i) => (i === 3 ? { ...c, high: 106 } : c));
  assert.deepEqual(ds(stateB(), touched, 1000, 101).actions.map(a => a.kind), ['BRIEF']);
  const down = [...mkDaily(40, 100, 1, '2026-11-16'), day('2026-11-17', 120, 121, 100, 101)];
  assert.deepEqual(ds(stateB({ enteredAt: Date.parse('2026-11-16T10:00:00+05:30') }), down, 1000, 101).actions.map(a => a.kind), ['BRIEF'], 'no trend exit before 3R');
});

test('B: hard stop exits everything', () => {
  const r = ev(stateB(), 94);
  assert.deepEqual([r.actions[0].rule, r.actions[0].kind, r.actions[0].qty, r.state.closed], ['LC-09', 'EXIT_ALL', 1000, true]);
});

test('custom: immediate-sale partial with stop to cost, and an add at 1R', () => {
  const st = { strategies: [{ id: 'c1', name: 'Sell now', entryPct: 50, add: { on: true, atR: 1, pct: 100, stopToR: 0.5 }, stopToCost: { on: false },
    partial: { on: true, atR: 3, pct: 50, mode: 'sell', stopAfter: 'cost' }, trail: { type: 'ema', period: 21, bufferPct: 1, afterPartial: true }, timeExit: { on: false } }] };
  assert.equal(S.validate(S.find('c1', st)), null);
  const s = S.createState({ strategyId: 'c1', entryPrice: 100, firstQty: 50, initialStop: 95, params: p, settings: st, now: ENTERED });
  const add = S.evaluate({ state: s, position: { openQty: 50, avgEntry: 100 }, market: { ltp: 106, intraday: minutes(106, 6, NOW), daily: [] }, now: NOW, params: p });
  assert.deepEqual(add.actions.map(a => [a.rule, a.kind, a.qty, a.stop]), [['LC-02', 'BUY', 50, 97.5]]);
  const r = S.evaluate({ state: add.state, position: { openQty: 100, avgEntry: 103 }, market: { ltp: 116, intraday: minutes(116, 6, NOW + 60000), daily: [] }, now: NOW + 60000, params: p });
  assert.deepEqual(r.actions.map(a => [a.rule, a.kind, a.qty ?? a.stop]), [['ST-01', 'SELL', 50], ['ST-04', 'STOP', 103]]);
});

test('older frozen specs keep their rules (sell at 3R, single EMA buffer)', () => {
  const old = stateB();
  old.spec = { id: 'B', name: 'old', kind: 'rules', entryPct: 100, add: { on: false }, partial: { on: true, atR: 3, pct: 50, stopAfter: 'cost' }, trail: { type: 'ema', period: 21, bufferPct: 1, afterPartial: true }, timeExit: { on: true, days: 10, minR: 1 } };
  const r = ev(old, 116);
  assert.deepEqual(r.actions.map(a => [a.rule, a.kind]), [['ST-01', 'SELL'], ['ST-04', 'STOP']]);
});

test('switching an open position keeps what already happened', () => {
  const trade = { entries: [{ date: '2026-11-02', price: 100, qty: 50 }], pyramids: [{ qty: 50 }], partialExits: [{ qty: 20 }], initialStop: 95, currentStop: 102 };
  const b = S.switchState({ trade, strategyId: 'B', params: p, settings, now: NOW });
  assert.deepEqual([b.strategy, b.hardStop, b.partialDone, b.costDone], ['B', 102, true, true]);
  const a = S.switchState({ trade, strategyId: 'A', params: p, settings, now: NOW });
  assert.deepEqual([a.strategy, a.hardStop, a.stage], [undefined, 102, R.STAGES.R2], 'add done and stop above cost → lock detected');
});

test('every alert says why in one line', () => {
  const m = A.message({ action: { rule: 'LC-09', kind: 'EXIT_ALL', qty: 100, stop: 95 }, symbol: 'INFY', mode: 'real', cmp: 94, params: p });
  assert.match(m.text, /\nReason     : Price fell below the hard stop ₹95\.00 — exit the whole position\.$/);
  for (const rule of ['LC-01', 'LC-02', 'LC-03', 'LC-04', 'LC-05', 'LC-07', 'LC-09', 'LC-10']) assert.ok(A.reason({ rule, kind: 'X' }, p).length > 15, rule);
  const b = ev(stateB({ costDone: true, hardStop: 100 }), 116);
  const pm = A.message({ action: b.actions[0], symbol: 'INFY', mode: 'real', cmp: 116, params: p });
  assert.equal(pm.alertType, 'Partial profit — tranche stop set');
  assert.match(pm.text, /Suggestion : No sale yet · Profit-booking stop ₹116\.00 for Qty 500\nReason     : Price held above 3R/);
});

test('paper trade on B: stop to cost, tranche set (nothing booked), tranche sold as a partial exit', () => {
  G.db = { generateId: pre => pre + '_t' + Math.random().toString(36).slice(2, 6) };
  require(path.join(__dirname, '../js/engine/executors.js'));
  const X = G.TLMExecutors;
  let t = { id: 'pt1', exchange: 'NSE', tradeType: 'Equity', entries: [{ date: '2026-11-02', price: 100, qty: 1000 }], pyramids: [], partialExits: [], finalExit: null, stopRevisions: [], initialStop: 95, currentStop: 95 };
  const r = ev(stateB(), 116, 1000, minutes(116, 6, NOW).map((c, i) => (i === 0 ? { ...c, low: 108 } : c)));
  t = X.applyPaper(t, r.actions, { settings: {}, date: '2026-11-18', openQty: 1000 });
  assert.deepEqual([t.partialExits.length, t.currentStop], [0, 100]);
  const later = NOW + 86400000;
  const x = S.evaluate({ state: r.state, position: { openQty: 1000, avgEntry: 100 }, market: { ltp: 107, intraday: minutes(107, 6, later), daily: [] }, now: later, params: p });
  t = X.applyPaper(t, x.actions, { settings: {}, date: '2026-11-19', openQty: 1000 });
  assert.deepEqual([t.partialExits.length, t.partialExits[0].qty, t.partialExits[0].actionSource], [1, 500, 'ST-05 Tranche sold (Paper)']);
});

test('switch checklist: what the user ticks decides the starting point', () => {
  const trade = { entries: [{ date: '2026-11-02', price: 100, qty: 1000 }], pyramids: [], partialExits: [], initialStop: 95, currentStop: 100 };
  const d = S.detectDone(trade, 'B', settings);
  assert.deepEqual([d.cost, d.partial], [true, false]);
  const b = S.switchState({ trade, strategyId: 'B', params: p, settings, now: NOW, done: { cost: true, partial: true, trancheSold: false, trancheQty: 500, trancheStop: 112 } });
  assert.deepEqual([b.costDone, b.partialDone, S.activeTranche(b).qty, S.activeTranche(b).trail], [true, true, 500, 112]);
  const none = S.switchState({ trade, strategyId: 'B', params: p, settings, now: NOW, done: {} });
  assert.deepEqual([none.costDone, none.partialDone, S.activeTranche(none)], [false, false, null]);
  const a = S.switchState({ trade, strategyId: 'A', params: p, settings, now: NOW, done: { stage: 3 } });
  assert.equal(a.stage, R.STAGES.R2);
  assert.ok(S.describe(S.find('A', settings), p).length >= 6, 'Strategy A is described rule by rule');
});
