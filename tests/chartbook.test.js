/**
 * Chartbook tests — run with:  npm test
 * Pure rules (which charts, what goes in them) and the capture pass against an in-memory database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryClient } = require('./helpers/memory-supabase.js');

const G = globalThis;
require('../js/calculations.js');
require('../js/engine/indicators.js');
require('../js/engine/tlm-rules.js');
require('../js/engine/tlm-engine.js');
const C = require('../js/engine/chartbook.js');
const I = G.TLMIndicators;

const TODAY = I.istDate(Date.now());
const day = n => C.addDays(TODAY, n);

const trade = over => ({
  id: 'tr1', symbol: 'ABC', exchange: 'NSE', initialStop: 95, currentStop: 95,
  entries: [{ id: 'en1', date: day(-20), price: 100, qty: 10 }],
  pyramids: [], partialExits: [], finalExit: null, stopRevisions: [], ...over,
});

test('events: entry per record, add per pyramid, exit only when fully closed; old records get positional refs', () => {
  const open = trade({ pyramids: [{ date: day(-10), price: 105, qty: 10 }] });
  assert.deepEqual(C.events(open).map(e => `${e.kind}:${e.ref}`), ['entry:en1', 'add:p0']);
  const closed = trade({ finalExit: { date: day(-2), price: 120, qty: 10 } });
  assert.equal(C.exitDate(closed), day(-2));
  assert.deepEqual(C.events(closed).map(e => e.kind), ['entry', 'exit']);
  const legacy = trade({ entries: [{ date: day(-5), price: 100, qty: 10 }] });
  assert.equal(C.events(legacy)[0].ref, 'e0');
});

test('pending: provisional on the day, final after the close or any later day, never re-taken once final', () => {
  const t = trade({ entries: [{ id: 'en1', date: TODAY, price: 100, qty: 10 }] });
  const none = C.indexOf([]);
  assert.deepEqual(C.pending(t, none, { today: TODAY, afterClose: false }).map(p => p.final), [false]);
  const prov = C.indexOf([{ trade_id: 'tr1', kind: 'entry', entry_ref: 'en1', final: false }]);
  assert.equal(C.pending(t, prov, { today: TODAY, afterClose: false }).length, 0, 'one provisional chart is enough during the day');
  assert.deepEqual(C.pending(t, prov, { today: TODAY, afterClose: true }).map(p => p.final), [true]);
  const fin = C.indexOf([{ trade_id: 'tr1', rule_id: 'LC-01', entry_ref: 'en1', final: true }]);
  assert.equal(C.pending(t, fin, { today: TODAY, afterClose: true }).length, 0);
  assert.equal(C.pending(trade(), none, { today: TODAY, afterClose: false })[0].final, true, 'past entry → final straight away');
});

test('build: entry chart window and levels; exit chart markers, stop path and 20-EMA lead-in', () => {
  const daily = [];
  for (let i = 300; i >= 0; i--) daily.push({ date: day(-i), open: 90, high: 92, low: 88, close: 91 });
  const t = trade({
    tlmState: { initialStop: 95, targets: { T1: 105, T2: 110 }, hardStop: 95 },
    pyramids: [{ id: 'py1', date: day(-12), price: 105, qty: 10 }],
    partialExits: [{ date: day(-6), price: 115, qty: 5 }],
    finalExit: { date: day(-1), price: 112, qty: 15 },
    stopRevisions: [{ date: day(-12), newStop: 98 }, { date: day(-6), newStop: 106 }],
  });
  const [entry, , exit] = C.events(t);
  const e = C.build({ trade: t, mode: 'real', ev: entry, daily, intraday: [], final: true });
  assert.equal(e.id, 'sn_tr1_entry_en1');
  assert.equal(e.daily.length, 130);
  assert.equal(e.daily.at(-1).date, day(-20));
  assert.equal(e.levels.fill, 100);
  assert.equal(e.levels.targets.T1, 105);
  const x = C.build({ trade: t, mode: 'real', ev: exit, daily, intraday: [], final: true, result: { r: 2.1 } });
  assert.equal(x.kind, 'exit');
  assert.equal(x.daily.at(-1).date, day(-1));
  assert.ok(x.daily[0].date <= C.addDays(day(-20), -75), 'starts ~75 days before entry');
  assert.ok(x.daily.filter(c => c.date < day(-20)).length >= 20, 'enough candles before entry for a 20-day EMA');
  assert.deepEqual(x.levels.markers.map(m => m.type), ['entry', 'add', 'partial', 'exit']);
  assert.deepEqual(x.levels.stopPath.map(s => s.stop), [95, 98, 106]);
  assert.equal(x.levels.result.r, 2.1);
});

test('emaSeries matches ema() at every point', () => {
  const v = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 5);
  const s = I.emaSeries(v, 20);
  assert.equal(s[18], null);
  for (const n of [20, 27, 40]) assert.ok(Math.abs(s[n - 1] - I.ema(v.slice(0, n), 20)) < 1e-9);
});

test('captureCharts: provisional → final after close, exit chart for closed trades, backfill in batches, old copies replaced', async () => {
  const tables = {
    settings: [{ user_id: 'u1', data: {} }],
    trades: [
      { id: 't-open', user_id: 'u1', symbol: 'AAA', exchange: 'NSE', direction: 'Long', initial_stop: 95, current_stop: 95,
        entries: [{ id: 'eA', date: TODAY, price: 100, qty: 10 }], pyramids: [], partial_exits: [], final_exit: null, stop_revisions: [], created_at: '1' },
      { id: 't-closed', user_id: 'u1', symbol: 'BBB', exchange: 'NSE', direction: 'Long', initial_stop: 90, current_stop: 90,
        entries: [{ id: 'eB', date: day(-30), price: 100, qty: 10 }], pyramids: [], partial_exits: [],
        final_exit: { date: day(-3), price: 120, qty: 10 }, stop_revisions: [], created_at: '2' },
      { id: 't-old', user_id: 'u1', symbol: 'CCC', exchange: 'NSE', direction: 'Long', initial_stop: 90, current_stop: 90,
        entries: [{ id: 'eC', date: day(-400), price: 100, qty: 10 }], pyramids: [], partial_exits: [],
        final_exit: { date: day(-300), price: 80, qty: 10 }, stop_revisions: [], created_at: '3' },
    ],
    paper_trades: [], capital: [], watchlist: [], alert_log: [], runner_status: [{ id: 'tlm-runner' }],
    trade_snapshots: [{ id: 'old-random', user_id: 'u1', trade_id: 't-open', rule_id: 'LC-01', entry_ref: 'eA', final: false, daily: [] }],
  };
  const client = createMemoryClient(tables);
  G.TLM_HOST = 'server';
  G.auth = { getClient: () => client, getUser: () => ({ id: 'u1' }) };
  G.CustomEvent = G.CustomEvent || class extends Event { constructor(n, o) { super(n); this.detail = o?.detail; } };
  require('../js/db-cloud.js');
  require('../js/engine/market-data.js');
  require('../js/engine/alert-service.js');
  require('../js/engine/executors.js');
  require('../js/engine/runner.js');
  const fetched = [];
  G.TLMMarketData.setSource(async (tk, interval, range) => {
    fetched.push(`${tk}:${interval}:${range}`);
    const step = interval === '1d' ? 86400 : 60;
    const n = interval === '1d' ? 900 : 375;
    const end = interval === '1d' ? Math.floor(Date.parse(TODAY + 'T10:00:00Z') / 1000) : Math.floor(Date.parse(TODAY + 'T09:59:00Z') / 1000);
    const ts = Array.from({ length: n }, (_, i) => end - (n - 1 - i) * step);
    const q = ts.map(() => 100);
    return { meta: { regularMarketPrice: 100 }, timestamp: ts, indicators: { quote: [{ open: q, high: q, low: q, close: q }] } };
  });
  const R = G.TLMRunner;
  const midday = Date.parse(TODAY + 'T12:00:00+05:30'), evening = Date.parse(TODAY + 'T15:40:00+05:30');

  let r = await R.captureCharts({ now: midday });
  // t-open entry already has a provisional (old) copy → nothing; t-closed: entry + exit final; t-old skipped (closed long ago)
  assert.equal(r.saved, 2);
  assert.ok(tables.trade_snapshots.some(s => s.id === 'sn_t-closed_exit_exit' && s.final && s.levels.markers.length === 2));
  assert.ok(!tables.trade_snapshots.some(s => s.trade_id === 't-old'));

  r = await R.captureCharts({ now: evening });
  assert.equal(r.saved, 1, 'today\'s entry finalised after the close');
  const fin = tables.trade_snapshots.filter(s => s.trade_id === 't-open');
  assert.equal(fin.length, 1, 'old provisional copy replaced');
  assert.equal(fin[0].final, true);
  assert.ok(fin[0].intraday.length > 0, 'entry-day 1-min candles saved');

  r = await R.captureCharts({ now: evening, backfill: true, limit: 1 });
  assert.equal(r.saved, 1);
  assert.equal(r.remaining, 1, 'backfill continues in batches');
  r = await R.captureCharts({ now: evening, backfill: true, limit: 5 });
  assert.equal(r.saved, 1);
  assert.equal(r.remaining, 0);
  const old = tables.trade_snapshots.filter(s => s.trade_id === 't-old');
  assert.equal(old.length, 2);
  assert.ok(old.every(s => s.intraday.length === 0), 'no 1-min data for old days');
  assert.ok(fetched.some(f => f.startsWith('CCC.NS:1d:2y')), 'history range reaches the old entry');
  assert.ok(tables.trade_snapshots.every(s => s.user_id === 'u1'));
});
