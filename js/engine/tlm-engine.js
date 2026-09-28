/**
 * engine/tlm-engine.js — Trade Lifecycle Management rule engine v3.0.
 *
 * Pure functions only: given a trade's lifecycle state, its position and the
 * market data, return the new state plus the actions the rules ask for.
 * The engine never places orders, saves data or sends alerts — executors do.
 * Real and paper trades call exactly the same functions.
 *
 * Market input:  { ltp, intraday: [{time, open, high, low, close}] (1-min, epoch sec),
 *                  daily: [{date:'YYYY-MM-DD', open, high, low, close}] }
 * Action kinds:  BUY · STOP · TRAIL · SELL · EXIT_ALL · BRIEF
 */
(function (root) {
  const R = root.TLMRules || (typeof require !== 'undefined' ? require('./tlm-rules.js') : null);
  const I = root.TLMIndicators || (typeof require !== 'undefined' ? require('./indicators.js') : null);
  const { RULES, STAGES, TARGET_R } = R;

  const round2 = v => Math.round(v * 100) / 100;
  const clone = o => JSON.parse(JSON.stringify(o));
  const params0 = p => ({ ...R.DEFAULT_PARAMS, ...(p || {}) });

  // ── Sizing (LC-01 set-up) ────────────────────────────────────────────────
  /** Full size from RPT and first-entry qty. Returns null when levels are invalid. */
  function planPosition({ trigger, stop, rpt, params }) {
    const p = params0(params);
    const risk = trigger - stop;
    if (!(risk > 0) || !(rpt > 0)) return null;
    const fullQty = Math.floor(rpt / risk);
    const firstQty = Math.floor(fullQty * p.firstEntryPct / 100);
    return firstQty > 0 ? { riskPerShare: risk, fullQty, firstQty } : null;
  }

  // ── State ────────────────────────────────────────────────────────────────
  /** New lifecycle state once the first entry has filled at `entryPrice`. */
  function createState({ entryPrice, firstQty, initialStop, params, now }) {
    const p = params0(params);
    const r = entryPrice - initialStop;
    if (!(r > 0)) return null;
    const targets = {};
    Object.entries(TARGET_R).forEach(([k, m]) => { targets[k] = round2(entryPrice + m * r); });
    return {
      rulesVersion: p.rulesVersion,
      stage: STAGES.ENTERED,
      entryPrice: round2(entryPrice),
      initialStop: round2(initialStop),
      r: round2(r),
      firstQty,
      targets,
      hardStop: round2(initialStop),
      tranches: [],
      lastEvalAt: now || null,
      lastDayStart: null,
      snapshotsTaken: [],
    };
  }

  /** Build a state for a trade that has none yet (older trades, manual entries). */
  function stateFromTrade(trade, currentStop, params) {
    const first = (trade.entries || [])[0];
    if (!first) return null;
    const s = createState({ entryPrice: Number(first.price), firstQty: Number(first.qty), initialStop: Number(trade.initialStop), params });
    if (!s) return null;
    if ((trade.pyramids || []).length > 0) s.stage = STAGES.R1;
    s.hardStop = Math.max(s.hardStop, Number(currentStop) || 0);
    return s;
  }

  const activeTranche = s => (s.tranches || []).find(t => t.status === 'active') || null;

  // ── Helpers ──────────────────────────────────────────────────────────────
  /** Trail base from the last closed day: its low, or low + ½ move on a large-candle day (LC-06). */
  function trailBase(daily, todayIso, p) {
    const days = I.closedDays(daily, todayIso);
    const prev = days[days.length - 1];
    if (!prev) return 0;
    const before = days[days.length - 2];
    const a = I.atr(days, p.atrPeriod);
    const move = before ? prev.close - before.close : 0;
    const base = a && move > p.largeCandleAtrMult * a ? prev.low + move / 2 : prev.low;
    return I.roundTick(base);
  }

  function emaStop(daily, todayIso, p) {
    const closes = I.closedDays(daily, todayIso).map(c => c.close);
    const e = I.ema(closes, p.emaPeriod);
    return e ? I.roundTick(e * (1 - p.emaBufferPct / 100)) : 0;
  }

  // ── LC-01 Entry (watchlist) ──────────────────────────────────────────────
  /** Returns a BUY action when price has held above the trigger for the entry hold time. */
  function evaluateWatch({ item, market, now, params }) {
    const p = params0(params);
    const trigger = Number(item.trigger_price ?? item.trigger);
    const stop = Number(item.stop_loss ?? item.stop);
    if (!(trigger > stop) || !market || !(market.ltp > 0)) return null;
    if (!I.holdAbove(market.intraday, trigger, p.entryHoldMin, market.ltp, now)) return null;
    return { rule: RULES.ENTRY, kind: 'BUY', price: market.ltp, stop: I.roundTick(stop), trigger };
  }

  // ── LC-06, LC-08, LC-10 Day start ────────────────────────────────────────
  /** Once per trading day: raise the hard stop and trails from the last close, then brief. */
  function dayStart({ state, position, market, now, params }) {
    const p = params0(params);
    const today = I.istDate(now);
    if (!state || state.lastDayStart === today) return { state, actions: [] };
    const s = clone(state);
    const daily = (market && market.daily) || [];

    if (s.stage >= STAGES.R2) {                                    // LC-08
      const e = emaStop(daily, today, p);
      if (e > s.hardStop) s.hardStop = e;
    }
    const t = activeTranche(s);
    if (t) t.trail = Math.max(t.trail, trailBase(daily, today, p), s.hardStop);   // LC-06

    s.lastDayStart = today;
    const brief = { rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: position.openQty, stop: s.hardStop };
    if (t) Object.assign(brief, { trail: t.trail, trailQty: Math.min(t.qty, position.openQty) });
    return { state: s, actions: [brief] };
  }

  // ── Intraday evaluation ──────────────────────────────────────────────────
  /**
   * Evaluate one open position. Order: LC-09 hard stop → LC-07 trail exit →
   * forward stages LC-02..05 (several in one cycle if price gapped through).
   */
  function evaluate({ state, position, market, now, params }) {
    const p = params0(params);
    if (!state || !market || !(market.ltp > 0) || !(position.openQty > 0)) return { state, actions: [] };
    const s = clone(state);
    const actions = [];
    const ltp = market.ltp;
    const today = I.istDate(now);
    let open = position.openQty;
    let avg = position.avgEntry;

    // LC-09 — any price below the hard stop since the last evaluation, today.
    const since = Math.max(s.lastEvalAt || 0, Date.parse(today + 'T03:45:00Z')); // 09:15 IST
    const recent = (market.intraday || []).filter(c => (c.time + 60) * 1000 > since && c.time * 1000 <= now);
    const firstBreach = recent.find(c => c.low < s.hardStop);
    if (firstBreach || ltp < s.hardStop) {
      const fill = firstBreach ? Math.min(firstBreach.open, s.hardStop) : ltp;
      actions.push({ rule: RULES.HARD_EXIT, kind: 'EXIT_ALL', qty: open, price: ltp, fill: round2(fill), stop: s.hardStop });
      s.lastEvalAt = now;
      s.closed = true;
      return { state: s, actions };
    }

    // LC-07 — active tranche trail.
    const t = activeTranche(s);
    if (t) {
      const deep = ltp <= t.trail * (1 - p.trailDeepBreakPct / 100);
      const held = I.holdBelow(market.intraday, t.trail, p.trailHoldMin, ltp, now);
      if (deep || held) {
        const qty = Math.min(t.qty, open);
        t.status = 'sold';
        actions.push({ rule: RULES.TRAIL_EXIT, kind: qty >= open ? 'EXIT_ALL' : 'SELL', qty, price: ltp, fill: ltp, trail: t.trail, trancheId: t.id });
        open -= qty;
        if (open <= 0) { s.closed = true; s.lastEvalAt = now; return { state: s, actions }; }
      }
    }

    // Forward stages.
    const hold = level => I.holdAbove(market.intraday, level, p.targetHoldMin, ltp, now);
    for (let guard = 0; guard < 4; guard++) {
      if (s.stage === STAGES.ENTERED && hold(s.targets.T1)) {                          // LC-02
        const qty = s.firstQty;
        const stop = I.roundTick(s.initialStop + p.stopRaiseAt1R * s.r);
        s.hardStop = Math.max(s.hardStop, stop);
        avg = (avg * open + ltp * qty) / (open + qty);
        open += qty;
        s.stage = STAGES.R1;
        actions.push({ rule: RULES.ADD_1R, kind: 'BUY', qty, price: ltp, fill: ltp, stop: s.hardStop });
      } else if (s.stage === STAGES.R1 && hold(s.targets.T2)) {                        // LC-03
        const stop = Math.max(s.hardStop, I.roundTick(avg), emaStop(market.daily, today, p));
        s.hardStop = stop;
        s.stage = STAGES.R2;
        actions.push({ rule: RULES.LOCK_2R, kind: 'STOP', price: ltp, stop });
      } else if (s.stage === STAGES.R2 && hold(s.targets.T5)) {                        // LC-04
        const qty = Math.floor(open * p.tranche5Pct / 100);
        const trail = Math.max(trailBase(market.daily, today, p), s.hardStop);
        s.tranches.push({ id: 'T5', rule: RULES.BOOK_5R, qty, trail, status: 'active', openedAt: today });
        s.stage = STAGES.R5;
        actions.push({ rule: RULES.BOOK_5R, kind: 'TRAIL', qty, price: ltp, trail, trancheId: 'T5' });
      } else if (s.stage === STAGES.R5 && hold(s.targets.T10)) {                       // LC-05
        const prev = activeTranche(s);
        if (prev) prev.status = 'dropped';
        const qty = Math.floor(open * p.tranche10Pct / 100);
        const trail = Math.max(trailBase(market.daily, today, p), s.hardStop);
        s.tranches.push({ id: 'T10', rule: RULES.BOOK_10R, qty, trail, status: 'active', openedAt: today });
        s.stage = STAGES.R10;
        actions.push({ rule: RULES.BOOK_10R, kind: 'TRAIL', qty, price: ltp, trail, trancheId: 'T10', dropped: prev ? prev.id : null });
      } else break;
    }

    s.lastEvalAt = now;
    return { state: s, actions };
  }

  const api = { planPosition, createState, stateFromTrade, evaluateWatch, dayStart, evaluate, activeTranche, trailBase, emaStop };
  root.TLMEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
