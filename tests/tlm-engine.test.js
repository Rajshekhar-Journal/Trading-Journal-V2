/**
 * Unit tests for the TLM rule engine v3.0 — run with:  node --test tests/
 * Replays the spec's worked example (entry 100, stop 95, RPT 10,000) and Scenario B.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/engine/indicators.js');
require('../js/engine/tlm-rules.js');
const E = require('../js/engine/tlm-engine.js');
const { RULES, STAGES } = require('../js/engine/tlm-rules.js');

const DAY = '2026-09-29';                                 // a Tuesday
const t0 = Date.parse(DAY + 'T03:45:00Z') / 1000;         // 09:15 IST, epoch sec
/** 1-min candles starting at `startMin` minutes after 09:15 with the given closes. */
const mins = (startMin, closes, low) => closes.map((c, i) => ({ time: t0 + (startMin + i) * 60, open: c, high: c, low: low ?? c, close: c }));
/** `now` just after the last candle closed. */
const after = candles => (candles[candles.length - 1].time + 60) * 1000 + 5000;
/** Daily history: n closed days before DAY, all at `close`, last day low `lastLow`. */
function daily(n, close, lastLow) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.parse(DAY) - i * 864e5).toISOString().slice(0, 10);
    out.push({ date: d, open: close, high: close + 1, low: close - 1, close });
  }
  if (lastLow != null) out[out.length - 1].low = lastLow;
  return out;
}

test('sizing: full qty from RPT, first entry is half', () => {
  assert.deepEqual(E.planPosition({ trigger: 100, stop: 95, rpt: 10000 }), { riskPerShare: 5, fullQty: 2000, firstQty: 1000 });
  assert.equal(E.planPosition({ trigger: 95, stop: 100, rpt: 10000 }), null);
});

test('LC-01 entry needs a full 5-min hold; a dip resets it', () => {
  const item = { trigger_price: 100, stop_loss: 95 };
  const four = mins(0, [101, 101, 101, 101]);
  assert.equal(E.evaluateWatch({ item, market: { ltp: 101, intraday: four }, now: after(four) }), null);
  const dip = mins(0, [101, 101, 99, 101, 101, 101]);
  assert.equal(E.evaluateWatch({ item, market: { ltp: 101, intraday: dip }, now: after(dip) }), null);
  const five = mins(0, [99, 101, 101, 101, 101, 101]);
  const a = E.evaluateWatch({ item, market: { ltp: 101, intraday: five }, now: after(five) });
  assert.equal(a.rule, RULES.ENTRY);
  assert.equal(a.stop, 95);
});

test('state: targets from the entry fill', () => {
  const s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95 });
  assert.deepEqual(s.targets, { T1: 105, T2: 110, T5: 125, T10: 150 });
  assert.equal(s.hardStop, 95);
  assert.equal(s.stage, STAGES.ENTERED);
});

test('worked example: 1R add, 2R lock, 5R trail, trail exit, 10R, hard stop', () => {
  let s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95 });
  let pos = { openQty: 1000, avgEntry: 100 };
  const hist = daily(60, 104, 121.4);

  // 1R: +1,000 and stop to 97.50 → risk on 2,000 = 10,000
  let c = mins(0, [105, 105, 105, 105, 105]);
  let r = E.evaluate({ state: s, position: pos, market: { ltp: 105, intraday: c, daily: hist }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.ADD_1R);
  assert.equal(r.actions[0].qty, 1000);
  assert.equal(r.state.hardStop, 97.5);
  s = r.state; pos = { openQty: 2000, avgEntry: 102.5 };
  assert.equal((pos.avgEntry - s.hardStop) * pos.openQty, 10000);

  // 2R: stop = max(97.5, 102.5, EMA20 104 × 0.98) = 102.5
  c = mins(10, [110, 110, 110, 110, 110]);
  r = E.evaluate({ state: s, position: pos, market: { ltp: 110, intraday: c, daily: hist }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.LOCK_2R);
  assert.equal(r.state.hardStop, 102.5);
  s = r.state;

  // 5R: tranche A = 40% of 2,000 on trail max(prev low 121.40, hard stop)
  c = mins(20, [125, 125, 125, 125, 125]);
  r = E.evaluate({ state: s, position: pos, market: { ltp: 125, intraday: c, daily: hist }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.BOOK_5R);
  assert.equal(r.actions[0].qty, 800);
  assert.equal(r.actions[0].trail, 121.4);
  s = r.state;

  // 14 minutes below the trail: not yet; 15 minutes: sell the tranche
  s.tranches[0].trail = 128.6;
  c = mins(30, Array(14).fill(128.5));
  r = E.evaluate({ state: s, position: pos, market: { ltp: 128.5, intraday: c, daily: hist }, now: after(c) });
  assert.equal(r.actions.length, 0);
  c = mins(30, Array(15).fill(128.5));
  r = E.evaluate({ state: s, position: pos, market: { ltp: 128.5, intraday: c, daily: hist }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.TRAIL_EXIT);
  assert.equal(r.actions[0].qty, 800);
  s = r.state; pos = { openQty: 1200, avgEntry: 102.5 };

  // 10R: tranche B = 50% of 1,200
  c = mins(60, [150, 150, 150, 150, 150]);
  r = E.evaluate({ state: s, position: pos, market: { ltp: 150, intraday: c, daily: daily(60, 104, 146) }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.BOOK_10R);
  assert.equal(r.actions[0].qty, 600);
  assert.equal(r.actions[0].trail, 146);
  assert.equal(r.actions[0].dropped, null);
  s = r.state;

  // Deep break (2% below trail) sells at once
  s.tranches[1].trail = 152;
  c = mins(70, [148.9]);
  r = E.evaluate({ state: s, position: pos, market: { ltp: 148.9, intraday: c, daily: hist }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.TRAIL_EXIT);
  assert.equal(r.actions[0].qty, 600);
  s = r.state; pos = { openQty: 600, avgEntry: 102.5 };

  // Hard stop: a 1-min low under it fires EXIT_ALL immediately
  s.hardStop = 142.1;
  c = mins(80, [143]).map(k => ({ ...k, low: 142 }));
  r = E.evaluate({ state: s, position: pos, market: { ltp: 143, intraday: c, daily: hist }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.HARD_EXIT);
  assert.equal(r.actions[0].kind, 'EXIT_ALL');
  assert.equal(r.actions[0].qty, 600);
  assert.equal(r.actions[0].fill, 142.1);
});

test('scenario B: reaching 10R drops the unsold 5R tranche', () => {
  let s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95 });
  s.stage = STAGES.R5; s.hardStop = 115.6;
  s.tranches = [{ id: 'T5', rule: RULES.BOOK_5R, qty: 800, trail: 141, status: 'active' }];
  const c = mins(0, [150, 150, 150, 150, 150]);
  const r = E.evaluate({ state: s, position: { openQty: 2000, avgEntry: 102.5 }, market: { ltp: 150, intraday: c, daily: daily(60, 104, 146) }, now: after(c) });
  assert.equal(r.actions[0].dropped, 'T5');
  assert.equal(r.actions[0].qty, 1000);
  assert.equal(r.state.tranches[0].status, 'dropped');
  assert.equal(E.activeTranche(r.state).id, 'T10');
});

test('gap through several targets runs the stages in order in one cycle', () => {
  const s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95 });
  const c = mins(0, [112, 112, 112, 112, 112]);
  const r = E.evaluate({ state: s, position: { openQty: 1000, avgEntry: 100 }, market: { ltp: 112, intraday: c, daily: daily(60, 104) }, now: after(c) });
  assert.deepEqual(r.actions.map(a => a.rule), [RULES.ADD_1R, RULES.LOCK_2R]);
  assert.equal(r.state.stage, STAGES.R2);
});

test('stages never go back; hard stop never lowers', () => {
  let s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95 });
  s.stage = STAGES.R2; s.hardStop = 102.5;
  const c = mins(0, [104, 104, 104, 104, 104]);
  const r = E.evaluate({ state: s, position: { openQty: 2000, avgEntry: 102.5 }, market: { ltp: 104, intraday: c, daily: daily(60, 90) }, now: after(c) });
  assert.equal(r.actions.length, 0);
  assert.equal(r.state.stage, STAGES.R2);
  const d = E.dayStart({ state: r.state, position: { openQty: 2000 }, market: { daily: daily(60, 90) }, now: after(c) });
  assert.equal(d.state.hardStop, 102.5);  // EMA20 − 2% = 88.2 is lower → unchanged
});

test('day start: LC-08 raises hard stop to EMA20 − 2%; LC-06 trail = max(trail, prev low, hard stop); once a day', () => {
  let s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95 });
  s.stage = STAGES.R5; s.hardStop = 102.5;
  s.tranches = [{ id: 'T5', qty: 800, trail: 121.4, status: 'active' }];
  const now = Date.parse(DAY + 'T03:35:00Z');   // 09:05 IST
  const d = E.dayStart({ state: s, position: { openQty: 2000 }, market: { daily: daily(60, 130, 127) }, now });
  assert.equal(d.state.hardStop, 127.4);          // 130 × 0.98
  assert.equal(d.state.tranches[0].trail, 127.4); // max(121.4, 127, 127.4)
  assert.equal(d.actions[0].rule, RULES.DAY_BRIEF);
  const again = E.dayStart({ state: d.state, position: { openQty: 2000 }, market: { daily: daily(60, 130, 127) }, now });
  assert.equal(again.actions.length, 0);
});

test('large-candle day: trail base = day low + half the move', () => {
  const hist = daily(60, 100);
  hist[hist.length - 1] = { ...hist[hist.length - 1], close: 110, low: 101 };  // +10 move vs ATR ≈ 2
  assert.equal(E.trailBase(hist, DAY, require('../js/engine/tlm-rules.js').DEFAULT_PARAMS), 106);
});

test('custom targets: levels follow the configured R multiples', () => {
  const s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95, params: { target1R: 1.5, target2R: 3, target5R: 6, target10R: 12 } });
  assert.deepEqual(s.targets, { T1: 107.5, T2: 115, T5: 130, T10: 160 });
  assert.equal(s.plan.T1.r, 1.5);
});

test('a target switched off advances the stage silently', () => {
  const p = { enable1R: false };
  const s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95, params: p });
  const c = mins(0, [105, 105, 105, 105, 105]);
  const r = E.evaluate({ state: s, position: { openQty: 1000, avgEntry: 100 }, market: { ltp: 105, intraday: c, daily: daily(60, 104) }, now: after(c), params: p });
  assert.equal(r.actions.length, 0);          // no add, no stop raise
  assert.equal(r.state.stage, STAGES.R1);
  assert.equal(r.state.hardStop, 95);
});

test('5R trail off, 10R on: 10R trail sized on full open qty, nothing to drop', () => {
  let s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95, params: { enable5R: false } });
  s.stage = STAGES.R2; s.hardStop = 102.5;
  let c = mins(0, [125, 125, 125, 125, 125]);
  let r = E.evaluate({ state: s, position: { openQty: 2000, avgEntry: 102.5 }, market: { ltp: 125, intraday: c, daily: daily(60, 104, 121.4) }, now: after(c) });
  assert.equal(r.actions.length, 0);
  assert.equal(r.state.stage, STAGES.R5);
  c = mins(10, [150, 150, 150, 150, 150]);
  r = E.evaluate({ state: r.state, position: { openQty: 2000, avgEntry: 102.5 }, market: { ltp: 150, intraday: c, daily: daily(60, 104, 146) }, now: after(c) });
  assert.equal(r.actions[0].rule, RULES.BOOK_10R);
  assert.equal(r.actions[0].qty, 1000);
  assert.equal(r.actions[0].dropped, null);
});

test('validateTargets rejects non-ascending targets', () => {
  const { validateTargets } = require('../js/engine/tlm-rules.js');
  assert.equal(validateTargets({}), null);
  assert.match(validateTargets({ target2R: 0.5 }), /increase/);
});

test('open trades keep their frozen plan when settings change later', () => {
  const s = E.createState({ entryPrice: 100, firstQty: 1000, initialStop: 95 });       // default plan
  const c = mins(0, [105, 105, 105, 105, 105]);
  const r = E.evaluate({ state: s, position: { openQty: 1000, avgEntry: 100 }, market: { ltp: 105, intraday: c, daily: daily(60, 104) },
    now: after(c), params: { enable1R: false, target1R: 3 } });                       // settings changed afterwards
  assert.equal(r.actions[0].rule, RULES.ADD_1R);                                       // trade still follows its own plan
});

test('trades created before configurable targets derive their plan from stored prices', () => {
  const { planOf, stageLabel } = require('../js/engine/tlm-rules.js');
  const legacy = { stage: STAGES.R1, entryPrice: 100, r: 5, targets: { T1: 105, T2: 110, T5: 125, T10: 150 } };
  assert.deepEqual([planOf(legacy).T1.r, planOf(legacy).T5.r], [1, 5]);
  assert.equal(stageLabel(legacy), 'S2 1R');
});
