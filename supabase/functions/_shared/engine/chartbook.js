/**
 * engine/chartbook.js — which trade charts to save, and what goes into each (pure, no I/O).
 *
 * Three kinds of chart per trade, real and paper alike:
 *   entry  — each entry record:   ~6 months of daily candles up to the entry day + that day's 1-min candles
 *   add    — each 1R add (pyramid): same layout, marking the add
 *   exit   — when fully closed:    daily candles from ~30 days before entry to the exit day, markers for
 *                                  entry / adds / partial exits / final exit and the stop-loss path
 * A chart saved during the session is "provisional"; after the close (or any later day) it is re-saved
 * as "final" with the complete day. Final charts are never re-taken.
 * Used by engine/runner.js on the server (and the browser fallback), and by the Chartbook backfill.
 */
(function (root) {
  const KINDS = Object.freeze({ ENTRY: 'entry', ADD: 'add', EXIT: 'exit' });
  const RULE = { entry: 'LC-01', add: 'LC-02', exit: 'EXIT' };
  const ENTRY_DAYS = 250;       // daily candles saved up to the entry day (~1 year; the chart opens on the last ~6 months)
  const EXIT_LEAD_DAYS = 75;    // calendar days before the first entry on the exit chart (room for the 20-day EMA)

  const num = v => Number(v) || 0;
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

  /** Stable id: one row per trade / kind / record, so re-saving replaces it. */
  const snapId = (tradeId, kind, ref) => `sn_${tradeId}_${kind}_${ref}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);

  /** Record id, or a positional one for older records saved without an id. */
  const refOf = (rec, prefix, i) => rec?.id || `${prefix}${i}`;

  /** Quantities still open (same rule as db.getTradeRemainingQty). */
  function openQty(t) {
    const buy = (t.entries || []).reduce((s, e) => s + num(e.qty), 0) + (t.pyramids || []).reduce((s, p) => s + num(p.qty), 0);
    const sell = (t.partialExits || []).reduce((s, p) => s + num(p.qty), 0) + num(t.finalExit?.qty);
    return buy - sell;
  }

  /** Last exit date of a fully closed trade, else null. */
  function exitDate(t) {
    if (!(t.entries || []).length || openQty(t) > 0) return null;
    const dates = [t.finalExit?.date, ...(t.partialExits || []).map(p => p.date), t.closedAt].filter(Boolean).map(d => String(d).slice(0, 10));
    return dates.sort().at(-1) || null;
  }

  /** Every chart this trade should have: [{ kind, ref, date }]. */
  function events(t) {
    const out = [];
    (t.entries || []).forEach((e, i) => e?.date && out.push({ kind: KINDS.ENTRY, ref: refOf(e, 'e', i), date: String(e.date).slice(0, 10), rec: e }));
    (t.pyramids || []).forEach((p, i) => p?.date && out.push({ kind: KINDS.ADD, ref: refOf(p, 'p', i), date: String(p.date).slice(0, 10), rec: p }));
    const x = exitDate(t);
    if (x) out.push({ kind: KINDS.EXIT, ref: 'exit', date: x, rec: t.finalExit || null });
    return out;
  }

  /**
   * Index of saved charts: Map("tradeId|kind|ref" → { final }). Accepts rows from getSnapshotIndex().
   * rebuildBefore (ISO time): charts taken earlier count as missing, so they are taken again.
   */
  function indexOf(rows, rebuildBefore) {
    const m = new Map();
    for (const r of rows || []) {
      if (rebuildBefore && (!r.taken_at || r.taken_at < rebuildBefore)) continue;
      const kind = r.kind || (r.rule_id === 'LC-02' ? KINDS.ADD : r.rule_id === 'EXIT' ? KINDS.EXIT : KINDS.ENTRY);
      const k = `${r.trade_id}|${kind}|${r.entry_ref}`;
      const prev = m.get(k);
      m.set(k, { final: !!r.final || !!prev?.final });
    }
    return m;
  }

  /**
   * Charts to take now for one trade.
   * @param today      IST date (YYYY-MM-DD)
   * @param afterClose true once the session's last candle is in (≥ close + 3 min)
   * @param provisional allow an intraday (not final) chart for an event dated today
   * @returns [{ kind, ref, date, rec, final }]
   */
  function pending(t, index, { today, afterClose, provisional = true }) {
    const out = [];
    for (const ev of events(t)) {
      const saved = index.get(`${t.id}|${ev.kind}|${ev.ref}`);
      if (saved?.final) continue;
      const canFinal = ev.date < today || (ev.date === today && afterClose);
      if (canFinal) out.push({ ...ev, final: true });
      else if (!saved && provisional && ev.date === today) out.push({ ...ev, final: false });
    }
    return out;
  }

  /** Earliest date the daily history must reach for a chart. */
  function historyFrom(t, ev) {
    if (ev.kind === KINDS.EXIT) {
      const first = (t.entries || []).map(e => String(e.date).slice(0, 10)).sort()[0] || ev.date;
      return addDays(first, -EXIT_LEAD_DAYS);
    }
    return addDays(ev.date, -Math.ceil(ENTRY_DAYS * 1.5));
  }

  /** Markers and stop path drawn on the exit chart. */
  function lifecycleMarks(t) {
    const marks = [];
    (t.entries || []).forEach(e => marks.push({ date: String(e.date).slice(0, 10), type: 'entry', price: num(e.price), qty: num(e.qty) }));
    (t.pyramids || []).forEach(p => marks.push({ date: String(p.date).slice(0, 10), type: 'add', price: num(p.price), qty: num(p.qty) }));
    (t.partialExits || []).forEach(p => marks.push({ date: String(p.date).slice(0, 10), type: 'partial', price: num(p.price), qty: num(p.qty) }));
    if (t.finalExit) marks.push({ date: String(t.finalExit.date).slice(0, 10), type: 'exit', price: num(t.finalExit.price), qty: num(t.finalExit.qty) });
    marks.sort((a, b) => a.date.localeCompare(b.date));
    const first = marks[0]?.date;
    const path = [];
    if (first && num(t.initialStop) > 0) path.push({ date: first, stop: num(t.initialStop) });
    (t.stopRevisions || []).filter(r => num(r.newStop) > 0 && r.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .forEach(r => {
        const d = String(r.date).slice(0, 10);
        if (path.length && path.at(-1).date === d) path.at(-1).stop = num(r.newStop); else path.push({ date: d, stop: num(r.newStop) });
      });
    return { marks, stopPath: path };
  }

  /**
   * The snapshot row for one chart.
   * @param daily     daily candles with `date` (any span; trimmed here)
   * @param intraday  1-min candles of the event day ([] when not available)
   * @param result    for exit charts: { r, pnl, holdingDays } (optional)
   */
  function build({ trade, mode, ev, daily, intraday, final, now, result }) {
    const s = trade.tlmState || {};
    const first = (trade.entries || [])[0] || {};
    let days, levels;
    if (ev.kind === KINDS.EXIT) {
      const from = historyFrom(trade, ev);
      days = (daily || []).filter(c => c.date >= from && c.date <= ev.date);
      const { marks, stopPath } = lifecycleMarks(trade);
      levels = {
        fill: num(first.price), initialStop: num(trade.initialStop || s.initialStop), qty: num(first.qty),
        exitPrice: num(trade.finalExit?.price), exitDate: ev.date, markers: marks, stopPath,
        result: result || null,
      };
    } else {
      days = (daily || []).filter(c => c.date <= ev.date).slice(-ENTRY_DAYS);
      levels = {
        fill: num(ev.rec?.price), qty: num(ev.rec?.qty),
        initialStop: num(trade.initialStop || s.initialStop),
        stop: num(ev.kind === KINDS.ADD ? (trade.currentStop || s.hardStop) : (trade.initialStop || s.initialStop)),
        targets: s.targets || {},
      };
    }
    return {
      id: snapId(trade.id, ev.kind, ev.ref),
      trade_id: trade.id, mode, kind: ev.kind, rule_id: RULE[ev.kind], entry_ref: ev.ref, entry_date: ev.date,
      final: !!final, taken_at: new Date(now || Date.now()).toISOString(),
      daily: days.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close })),
      intraday: (intraday || []).map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
      levels,
    };
  }

  /** Yahoo range wide enough to reach `fromIso` from `todayIso`. */
  function rangeFor(fromIso, todayIso) {
    const d = daysBetween(fromIso, todayIso);
    if (d <= 28) return '1mo';
    if (d <= 88) return '3mo';
    if (d <= 178) return '6mo';
    if (d <= 360) return '1y';
    if (d <= 725) return '2y';
    if (d <= 1820) return '5y';
    return '10y';
  }

  const api = { KINDS, snapId, openQty, exitDate, events, indexOf, pending, historyFrom, lifecycleMarks, build, rangeFor, addDays, daysBetween };
  root.TLMChartbook = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
