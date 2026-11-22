/**
 * Trade-management strategies: A unchanged, B (3R partial + 21 EMA trail + time exit), custom rules, switching, alert reasons. Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const G = globalThis;
G.TLM_HOST = 'server';
for (const f of ['indicators.js', 'tlm-rules.js', 'tlm-engine.js', 'strategies.js']) require(path.join(__dirname, '../js/engine', f));
const S = G.TLMStrategies, E = G.TLMEngine, R = G.TLMRules, I = G.TLMIndicators;
global.db = global.db || {};
require(path.join(__dirname, '../js/engine/alert-service.js'));
const A = G.TLMAlerts;

const NOW = Date.parse('2026-11-18T09:20:00+05:30');                       // a Wednesday, just after the open
const day = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
const mkDaily = (n, start, step, endDate) => { const out = []; let d = new Date(endDate + 'T00:00:00Z'); for (let i = n - 1; i >= 0; i--) { const x = new Date(d - i * 86400000).toISOString().slice(0, 10); const c = start + step * (n - 1 - i); out.push(day(x, c, c + 1, c - 1, c)); } return out; };
const minutes = (ltp, n, endMs) => Array.from({ length: n }, (_, i) => ({ time: Math.floor(endMs / 1000) - (n - i) * 60, open: ltp, high: ltp, low: ltp, close: ltp }));
const settings = {};
const p = { ...R.DEFAULT_PARAMS };
const stateB = (over = {}) => ({ ...S.createState({ strategyId: 'B', entryPrice: 100, firstQty: 100, initialStop: 95, params: p, settings, now: Date.parse('2026-11-02T10:00:00+05:30') }), ...over });

test('list: A, B and custom strategies; default is A; B carries the requested rules', () => {
  const l = S.list({ strategies: [{ id: 'c1', name: 'Trend', partial: { on: false }, trail: { type: 'ema', period: 21, bufferPct: 0 }, timeExit: { on: false } }] });
  assert.deepEqual(l.map(x => x.id), ['A', 'B', 'c1']);
  const b = S.find('B', settings);
  assert.deepEqual([b.entryPct, b.partial.on, b.partial.atR, b.partial.pct, b.trail.type, b.trail.period, b.timeExit.on, b.timeExit.minR], [100, true, 3, 50, 'ema', 21, true, 1]);
  assert.equal(S.defaultId({}), 'A'); assert.equal(S.defaultId({ defaultStrategy: 'B' }), 'B'); assert.equal(S.defaultId({ defaultStrategy: 'zzz' }), 'A');
  assert.equal(S.validate(b), null);
  assert.match(S.validate({ ...b, partial: { ...b.partial, pct: 100 } }), /between 1 and 99/);
  assert.match(S.validate({ ...b, partial: { ...b.partial, on: false }, trail: { ...b.trail, type: 'none' }, timeExit: { ...b.timeExit, on: false } }), /no way to exit/);
  assert.ok(S.describe(b).some(t => /sell 50% at 3R/.test(t)) && S.describe(b).some(t => /21 EMA less 1%/.test(t)));
});

test('strategy A: state and behaviour are exactly the lifecycle engine (no strategy fields, same actions)', () => {
  const a = S.createState({ strategyId: 'A', entryPrice: 100, firstQty: 100, initialStop: 95, params: p, settings, now: NOW });
  const e = E.createState({ entryPrice: 100, firstQty: 100, initialStop: 95, params: p, now: NOW });
  assert.deepEqual(a, e); assert.equal(a.spec, undefined);
  const mk = { ltp: 106, intraday: minutes(106, 6, NOW), daily: [] };
  assert.deepEqual(S.evaluate({ state: a, position: { openQty: 100, avgEntry: 100 }, market: mk, now: NOW, params: p }), E.evaluate({ state: a, position: { openQty: 100, avgEntry: 100 }, market: mk, now: NOW, params: p }));
  assert.equal(S.paramsFor('A', p, settings).firstEntryPct, 50);
  assert.equal(S.paramsFor('B', p, settings).firstEntryPct, 100, 'B buys the full planned size at entry');
});

test('B: at 3R (held 5 min) sell 50% and move the stop to cost; once only', () => {
  const s = stateB();
  assert.deepEqual([s.strategy, s.partialDone, s.stage, R.stageLabel(s)], ['B', false, 1, 'Entered']);
  const pos = { openQty: 100, avgEntry: 100 };
  const below = S.evaluate({ state: s, position: pos, market: { ltp: 114, intraday: minutes(114, 6, NOW), daily: [] }, now: NOW, params: p });
  assert.deepEqual(below.actions, [], '114 is below 3R = 115');
  const r = S.evaluate({ state: s, position: pos, market: { ltp: 116, intraday: minutes(116, 6, NOW), daily: [] }, now: NOW, params: p });
  assert.deepEqual(r.actions.map(a => [a.rule, a.kind, a.qty ?? a.stop]), [['ST-01', 'SELL', 50], ['ST-04', 'STOP', 100]]);
  assert.ok(r.actions.every(a => a.why && a.why.length > 20), 'every action says why');
  assert.deepEqual([r.state.partialDone, r.state.hardStop, R.stageLabel(r.state)], [true, 100, 'Partial booked at 3R']);
  const again = S.evaluate({ state: r.state, position: { openQty: 50, avgEntry: 100 }, market: { ltp: 118, intraday: minutes(118, 6, NOW), daily: [] }, now: NOW + 60000, params: p });
  assert.deepEqual(again.actions, [], 'the partial is booked once');
});

test('B: hard stop still exits everything', () => {
  const r = S.evaluate({ state: stateB(), position: { openQty: 100, avgEntry: 100 }, market: { ltp: 94, intraday: minutes(94, 6, NOW), daily: [] }, now: NOW, params: p });
  assert.deepEqual([r.actions[0].rule, r.actions[0].kind, r.actions[0].qty, r.state.closed], ['LC-09', 'EXIT_ALL', 100, true]);
});

test('B day start: trail only after the partial; exit on a daily close below the 21 EMA less 1%; brief shows the level', () => {
  const up = mkDaily(40, 100, 1, '2026-11-17');                                // rising: close above the EMA
  const pos = { openQty: 50, avgEntry: 100 };
  const before = S.dayStart({ state: stateB({ partialDone: false }), position: pos, market: { ltp: 140, daily: up }, now: NOW });
  assert.deepEqual(before.actions.map(a => a.kind), ['BRIEF'], 'trail not active before the partial');
  assert.ok(!before.actions[0].trail);
  const on = S.dayStart({ state: stateB({ partialDone: true }), position: pos, market: { ltp: 140, daily: up }, now: NOW });
  assert.deepEqual(on.actions.map(a => a.kind), ['BRIEF']);
  assert.ok(on.actions[0].trail > 0 && /21 EMA/.test(on.actions[0].why));
  const down = [...up.slice(0, -1), day('2026-11-17', 120, 121, 100, 101)];       // last close far below the EMA
  const x = S.dayStart({ state: stateB({ partialDone: true }), position: pos, market: { ltp: 101, daily: down }, now: NOW });
  assert.deepEqual([x.actions[0].rule, x.actions[0].kind, x.actions[0].qty, x.state.closed], ['ST-02', 'EXIT_ALL', 50, true]);
  assert.match(x.actions[0].why, /Daily close ₹101\.00 is below the trail .*21 EMA.*exit the remaining/);
  const again = S.dayStart({ state: x.state, position: pos, market: { ltp: 101, daily: down }, now: NOW + 600000 });
  assert.deepEqual(again.actions, [], 'once a day');
});

test('B time exit: not +1R within N trading days → exit all; reached +1R once → no time exit', () => {
  const entry = Date.parse('2026-11-02T10:00:00+05:30');                          // Mon; closed days after it by Tue 17th: 11
  const flat = [];
  for (let d = 2; d <= 17; d++) { const dt = `2026-11-${String(d).padStart(2, '0')}`; if (![7, 8, 14, 15].includes(d)) flat.push(day(dt, 100, 103, 98, 101)); }
  const pos = { openQty: 100, avgEntry: 100 };
  const s = stateB({ enteredAt: entry });
  const r = S.dayStart({ state: s, position: pos, market: { ltp: 101, daily: flat }, now: NOW });
  assert.deepEqual([r.actions[0].rule, r.actions[0].kind, r.actions[0].qty], ['ST-03', 'EXIT_ALL', 100]);
  assert.match(r.actions[0].why, /trading days since entry and \+1R \(₹105\.00\) was never reached/);
  const touched = flat.map((c, i) => (i === 3 ? { ...c, high: 106 } : c));
  const r2 = S.dayStart({ state: s, position: pos, market: { ltp: 101, daily: touched }, now: NOW });
  assert.deepEqual(r2.actions.map(a => a.kind), ['BRIEF']);
  const early = S.dayStart({ state: s, position: pos, market: { ltp: 101, daily: flat.slice(0, 4) }, now: NOW });
  assert.deepEqual(early.actions.map(a => a.kind), ['BRIEF'], 'too early for a time exit');
});

test('custom strategy: pure trend following (no partial, EMA 21 trail from entry) and add at 1R', () => {
  const st = { strategies: [{ id: 'c1', name: 'Trend + add', entryPct: 50, add: { on: true, atR: 1, pct: 100, stopToR: 0.5 }, partial: { on: false }, trail: { type: 'ema', period: 21, bufferPct: 0, afterPartial: false }, timeExit: { on: false } }] };
  assert.equal(S.validate(S.find('c1', st)), null);
  const s = S.createState({ strategyId: 'c1', entryPrice: 100, firstQty: 50, initialStop: 95, params: p, settings: st, now: Date.parse('2026-11-02T10:00:00+05:30') });
  assert.equal(s.firstQty, 50);
  const add = S.evaluate({ state: s, position: { openQty: 50, avgEntry: 100 }, market: { ltp: 106, intraday: minutes(106, 6, NOW), daily: [] }, now: NOW, params: p });
  assert.deepEqual(add.actions.map(a => [a.rule, a.kind, a.qty, a.stop, a.r]), [['LC-02', 'BUY', 50, 97.5, 1]]);
  assert.match(add.actions[0].why, /Price held above 1R .* add 50 shares and raise the stop to ₹97\.50/);
  const down = [...mkDaily(40, 100, 1, '2026-11-16'), day('2026-11-17', 120, 121, 100, 101)];
  const x = S.dayStart({ state: add.state, position: { openQty: 100, avgEntry: 103 }, market: { ltp: 101, daily: down }, now: NOW });
  assert.equal(x.actions[0].rule, 'ST-02', 'trail is active from entry because afterPartial is off');
});

test('the strategy is frozen into the trade: editing it later changes nothing for an open trade', () => {
  const s = stateB();
  const edited = { strategies: [{ ...S.find('B', settings), partial: { on: true, atR: 2, pct: 30, stopAfter: 'cost' } }] };
  assert.equal(S.find('B', edited).partial.atR, 2);
  const r = S.evaluate({ state: s, position: { openQty: 100, avgEntry: 100 }, market: { ltp: 116, intraday: minutes(116, 6, NOW), daily: [] }, now: NOW, params: p });
  assert.equal(r.actions[0].qty, 50, 'still 50% at 3R');
});

test('switching an open position to another strategy keeps what already happened', () => {
  const trade = { entries: [{ date: '2026-11-02', price: 100, qty: 50 }], pyramids: [{ qty: 50 }], partialExits: [{ qty: 20 }], initialStop: 95, currentStop: 102 };
  const b = S.switchState({ trade, strategyId: 'B', params: p, settings, now: NOW });
  assert.deepEqual([b.strategy, b.hardStop, b.partialDone, b.firstQty], ['B', 102, true, 50]);
  const a = S.switchState({ trade, strategyId: 'A', params: p, settings, now: NOW });
  assert.deepEqual([a.strategy, a.hardStop, a.stage], [undefined, 102, R.STAGES.R1]);
});

test('every alert says why in one line: strategy actions and the lifecycle rules', () => {
  const base = { action: { rule: 'LC-09', kind: 'EXIT_ALL', qty: 100, stop: 95 }, symbol: 'INFY', mode: 'real', cmp: 94, params: p };
  const m = A.message(base);
  assert.match(m.text, /\nReason     : Price fell below the hard stop ₹95\.00 — exit the whole position\.$/);
  for (const rule of ['LC-01', 'LC-02', 'LC-03', 'LC-04', 'LC-05', 'LC-07', 'LC-09', 'LC-10']) assert.ok(A.reason({ rule, kind: 'X' }, p).length > 15, rule);
  const b = S.evaluate({ state: stateB(), position: { openQty: 100, avgEntry: 100 }, market: { ltp: 116, intraday: minutes(116, 6, NOW), daily: [] }, now: NOW, params: p });
  const pm = A.message({ action: b.actions[0], symbol: 'INFY', mode: 'real', cmp: 116, params: p });
  assert.equal(pm.alertType, 'Partial profit');
  assert.match(pm.text, /Suggestion : Sell Qty 50 at market price \(partial profit\)\nReason     : Price held above 3R/);
});
