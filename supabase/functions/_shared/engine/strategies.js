/**
 * engine/strategies.js — trade-management strategies. A position follows exactly one.
 *
 *   A       the lifecycle already built (LC-01…LC-10, js/engine/tlm-engine.js). Untouched.
 *   B       full size at entry · stop to cost at 2R · at 3R half becomes a profit-booking tranche with its own rising stop
 *           (start: max(day low, hard stop); each morning max(prev low, stop), or max(prev low + 0.25·range, stop) after a
 *           candle wider than 3 × ATR; sold after 5 min below it) · the other half trails the 21 EMA from 3R: a close below
 *           EMA − 2% exits, a close between EMA − 2% and EMA sets a warning low, a later close below it exits ·
 *           time exit if +1R is not reached within 10 trading days.
 *   custom  any number of strategies built from the same blocks (settings.strategies).
 *
 * A strategy of kind 'rules' is a plain data object; the one interpreter below runs all of them.
 * The strategy is frozen into the trade's lifecycle state (state.spec) when it opens or is switched.
 * Every action carries `why`: one line saying what happened and what to do (shown in the alert).
 * Pure functions: no orders, no saving, no alerts. Real and paper trades use the same code.
 */
(function (root) {
  const R = root.TLMRules || (typeof require !== 'undefined' ? require('./tlm-rules.js') : null);
  const I = root.TLMIndicators || (typeof require !== 'undefined' ? require('./indicators.js') : null);
  const E = root.TLMEngine || (typeof require !== 'undefined' ? require('./tlm-engine.js') : null);
  const { RULES, STAGES } = R;

  const clone = o => JSON.parse(JSON.stringify(o));
  const round2 = v => Math.round(v * 100) / 100;
  const inr = v => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);

  const STRATEGY_A = Object.freeze({ id: 'A', name: 'Strategy A — Lifecycle (LC-01 … LC-10)', kind: 'lifecycle', builtin: true });
  const STRATEGY_B = Object.freeze({
    id: 'B', name: 'Strategy B — 3R trailed partial + 21 EMA', kind: 'rules', builtin: true,
    entryPct: 100,                                                           // % of the planned full size bought at entry
    add:        { on: false, atR: 1, pct: 100, stopToR: 0.5 },               // add pct% of the first qty at atR; stop to initial + stopToR·R
    stopToCost: { on: true, atR: 2, trail: true, emaPeriod: 21, emaPct: 2, holdMin: 10 },   // at atR: hard stop to cost; protective trail = max(cost, EMA − emaPct%), sell all after holdMin below it
    partial:    { on: true, atR: 3, pct: 50, mode: 'trail', stopAfter: 'none',   // mode: 'sell' at once | 'trail' a tranche with its own stop
                  holdMin: 10, largeAtr: 3, largeFrac: 0.25 },                //   trail: sold after holdMin below its stop; large candle = range > largeAtr × ATR14
    trail:      { type: 'ema', period: 21, deepPct: 2, confirm: true, bufferPct: 1, pct: 8, afterPartial: true },
    //            ema + confirm: close < EMA − deepPct% exits; close between that and the EMA sets a warning low; a later close below it exits
    //            ema without confirm: close < EMA − bufferPct% exits · pct: close pct% below the highest close since entry exits
    timeExit:   { on: true, days: 10, minR: 1 },
    closeMinute: 925,                                                        // 15:25 IST: daily-close decisions use this price as the day's close
  });

  /** Error text for a rules strategy, or null. */
  function validate(sp) {
    if (!sp || sp.kind === 'lifecycle') return null;
    if (!String(sp.name || '').trim()) return 'Give the strategy a name.';
    if (!(sp.entryPct >= 10 && sp.entryPct <= 100)) return 'Entry size must be between 10% and 100% of the planned size.';
    if (sp.add.on && !(sp.add.atR > 0 && sp.add.pct > 0 && sp.add.pct <= 200 && sp.add.stopToR >= 0)) return 'Add: R level and size must be positive.';
    if (sp.stopToCost.on && !(sp.stopToCost.atR > 0)) return 'Stop to cost: the R level must be positive.';
    if (sp.stopToCost.on && sp.stopToCost.trail && !(sp.stopToCost.emaPeriod >= 2 && sp.stopToCost.emaPct >= 0 && sp.stopToCost.emaPct <= 10 && sp.stopToCost.holdMin >= 1 && sp.stopToCost.holdMin <= 60)) return 'Protective trail: EMA 2–200, 0–10%, hold 1–60 min.';
    if (sp.closeMinute && !(sp.closeMinute >= 900 && sp.closeMinute <= 928)) return 'Close check must be between 15:00 and 15:28.';
    if (sp.partial.on) {
      if (!(sp.partial.atR > 0)) return 'Partial profit: the R level must be positive.';
      if (!(sp.partial.pct >= 1 && sp.partial.pct <= 99)) return 'Partial profit: the percentage must be between 1 and 99.';
      if (sp.add.on && !(sp.add.atR < sp.partial.atR)) return 'The add level must be below the partial-profit level.';
      if (sp.partial.mode === 'trail' && !(sp.partial.holdMin >= 1 && sp.partial.holdMin <= 60 && sp.partial.largeAtr > 0 && sp.partial.largeFrac >= 0 && sp.partial.largeFrac < 1))
        return 'Partial tranche: hold 1–60 min, large-candle ATR multiple above 0, range fraction 0–0.99.';
    }
    if (sp.trail.type === 'ema' && !(sp.trail.period >= 2 && sp.trail.period <= 200)) return 'Trail: EMA period must be between 2 and 200.';
    if (sp.trail.type === 'ema' && !(sp.trail.deepPct >= 0 && sp.trail.deepPct <= 10 && sp.trail.bufferPct >= 0 && sp.trail.bufferPct <= 10)) return 'Trail: percentages must be between 0% and 10%.';
    if (sp.trail.type === 'pct' && !(sp.trail.pct > 0 && sp.trail.pct < 50)) return 'Trail: percentage must be between 0 and 50.';
    if (sp.timeExit.on && !(sp.timeExit.days >= 2 && sp.timeExit.days <= 120 && sp.timeExit.minR >= 0)) return 'Time exit: days must be 2–120 and the R level not negative.';
    if (!sp.partial.on && sp.trail.type === 'none' && !sp.timeExit.on) return 'A strategy with no partial profit, no trail and no time exit has no way to exit except the hard stop. Turn one on.';
    return null;
  }

  /** Fill every field of a (possibly partial or older) rules strategy from B's defaults. */
  function normalise(raw) {
    const b = STRATEGY_B, r = raw || {}, a = r.add || {}, s = r.stopToCost, p = r.partial || {}, t = r.trail || {}, x = r.timeExit || {};
    return {
      id: String(r.id || ''), name: String(r.name || '').trim(), kind: 'rules', builtin: !!r.builtin,
      entryPct: num(r.entryPct, b.entryPct),
      add: { on: !!a.on, atR: num(a.atR, 1), pct: num(a.pct, 100), stopToR: num(a.stopToR, 0.5) },
      stopToCost: s ? { on: !!s.on, atR: num(s.atR, 2), trail: s.trail === undefined ? false : !!s.trail, emaPeriod: num(s.emaPeriod, 21), emaPct: num(s.emaPct, 2), holdMin: num(s.holdMin, 10) }
        : (r.partial ? { on: false, atR: 2, trail: false, emaPeriod: 21, emaPct: 2, holdMin: 10 } : { ...b.stopToCost }),   // older saved strategies had no such block
      partial: { on: r.partial ? !!p.on : b.partial.on, atR: num(p.atR, b.partial.atR), pct: num(p.pct, b.partial.pct),
        mode: p.mode === 'trail' ? 'trail' : (p.mode === 'sell' || r.partial ? 'sell' : b.partial.mode),
        stopAfter: p.stopAfter === 'cost' ? 'cost' : (p.stopAfter === 'none' ? 'none' : (r.partial ? 'cost' : b.partial.stopAfter)),
        holdMin: num(p.holdMin, b.partial.holdMin), largeAtr: num(p.largeAtr, b.partial.largeAtr), largeFrac: num(p.largeFrac, b.partial.largeFrac) },
      trail: { type: ['ema', 'pct', 'none'].includes(t.type) ? t.type : b.trail.type, period: num(t.period, b.trail.period),
        deepPct: num(t.deepPct, b.trail.deepPct), confirm: r.trail ? !!t.confirm : b.trail.confirm, bufferPct: num(t.bufferPct, b.trail.bufferPct),
        pct: num(t.pct, b.trail.pct), afterPartial: r.trail ? t.afterPartial !== false : true },
      timeExit: { on: r.timeExit ? !!x.on : b.timeExit.on, days: num(x.days, b.timeExit.days), minR: num(x.minR, b.timeExit.minR) },
      closeMinute: num(r.closeMinute, r.partial && r.closeMinute === undefined ? 0 : b.closeMinute),   // 0 = older spec: decide on the next morning
    };
  }

  /** All strategies: A, B (your saved edit of B, if any) and your custom ones. */
  function list(settings) {
    const saved = (settings && Array.isArray(settings.strategies)) ? settings.strategies : [];
    const out = [STRATEGY_A];
    const b = saved.find(x => x && x.id === 'B');
    out.push(b ? { ...normalise(b), id: 'B', builtin: true } : { ...normalise({}), id: 'B', name: STRATEGY_B.name, builtin: true });
    for (const c of saved) if (c && c.id && c.id !== 'A' && c.id !== 'B') out.push({ ...normalise(c), id: String(c.id) });
    return out;
  }
  const find = (id, settings) => list(settings).find(x => x.id === id) || null;
  const defaultId = settings => (settings && find(settings.defaultStrategy, settings)) ? settings.defaultStrategy : 'A';
  const isRules = state => !!(state && state.spec && state.spec.kind === 'rules');
  const strategyOf = state => (state && state.strategy) || 'A';

  /** Planning parameters for sizing: the first-entry share comes from the strategy. */
  function paramsFor(id, params, settings) {
    const sp = find(id || defaultId(settings), settings);
    return sp && sp.kind === 'rules' ? { ...params, firstEntryPct: sp.entryPct } : params;
  }

  /** One line per rule, for settings, the position panel and the guide. */
  function describe(sp, params) {
    if (!sp) return [];
    if (sp.kind === 'lifecycle') {
      const q = { ...R.DEFAULT_PARAMS, ...(params || {}) }, t = R.targetPlan(q), off = k => (t[k].on ? '' : ' (switched off)');
      return [
        `Entry: ${q.firstEntryPct}% of the planned size after price holds above the trigger for ${q.entryHoldMin} min.`,
        `${t.T1.r}R: add the same quantity again; stop up by ${q.stopRaiseAt1R}R${off('T1')}.`,
        `${t.T2.r}R: lock — stop = max(average cost, ${q.emaPeriod} EMA − ${q.emaBufferPct}%); from here the hard stop rises each morning to the ${q.emaPeriod} EMA − ${q.emaBufferPct}%${off('T2')}.`,
        `${t.T5.r}R: ${t.T5.pct}% of the open quantity trails under the previous day's low (low + ½ the move after a candle above ${q.largeCandleAtrMult} × ATR)${off('T5')}.`,
        `${t.T10.r}R: the earlier trail is dropped; ${t.T10.pct}% of the open quantity trails the same way${off('T10')}.`,
        `Trail exit: price below a trail for ${q.trailHoldMin} min, or ${q.trailDeepBreakPct}% below it at once, sells that part.`,
        'Hard stop always applies.',
      ];
    }
    sp = normalise(sp);
    const out = [`Entry: ${sp.entryPct}% of the planned size.`];
    out.push(sp.add.on ? `Add: ${sp.add.pct}% of the first quantity at ${sp.add.atR}R, stop to initial + ${sp.add.stopToR}R.` : 'No add.');
    if (sp.stopToCost.on) out.push(`Stop to cost: at ${sp.stopToCost.atR}R the hard stop moves to your average cost` + (sp.stopToCost.trail ? `, and a protective trail starts at max(cost, ${sp.stopToCost.emaPeriod} EMA − ${sp.stopToCost.emaPct}%), raised each morning; ${sp.stopToCost.holdMin} min below it sells everything.` : '.'));
    const p = sp.partial;
    if (!p.on) out.push('No partial profit.');
    else if (p.mode === 'trail') out.push(`Partial profit: at ${p.atR}R, ${p.pct}% becomes a tranche with its own stop = max(day low, hard stop); each morning max(yesterday's low, stop), or max(low + ${p.largeFrac} × range, stop) after a candle wider than ${p.largeAtr} × ATR; sold after ${p.holdMin} min below the stop.`);
    else out.push(`Partial profit: sell ${p.pct}% at ${p.atR}R${p.stopAfter === 'cost' ? ', then stop to cost' : ''}.`);
    const t = sp.trail, when = t.afterPartial && p.on ? ` (from ${p.atR}R)` : '';
    out.push(t.type === 'ema' ? (t.confirm
        ? `Trail${when}: a daily close below the ${t.period} EMA − ${t.deepPct}% exits; a close between that and the EMA marks a warning low, and a later close below it exits.`
        : `Trail${when}: exit on a daily close below the ${t.period} EMA less ${t.bufferPct}%.`)
      : t.type === 'pct' ? `Trail${when}: exit on a daily close ${t.pct}% below the highest close since entry.` : 'No trail.');
    out.push(sp.timeExit.on ? `Time exit: exit all if +${sp.timeExit.minR}R was not reached within ${sp.timeExit.days} trading days.` : 'No time exit.');
    if (sp.closeMinute) out.push(`Daily-close rules are decided at ${hm(sp.closeMinute)} IST, taking that price as the close; the sale goes out at once.`);
    out.push('Hard stop always applies.');
    return out;
  }

  const labelsFor = sp => ['Watching', 'Entered', sp.add.on ? `Added at ${sp.add.atR}R` : (sp.stopToCost.on ? `Stop at cost (${sp.stopToCost.atR}R)` : 'Entered'),
    sp.partial.on ? (sp.partial.mode === 'trail' ? `Tranche trailing (${sp.partial.atR}R)` : `Partial booked at ${sp.partial.atR}R`) : 'Entered', 'Trailing', 'Trailing'];

  /** New lifecycle state for a strategy. Strategy A returns exactly what the lifecycle engine always built. */
  function createState({ strategyId, entryPrice, firstQty, initialStop, params, settings, now }) {
    const sp = find(strategyId || defaultId(settings), settings) || STRATEGY_A;
    const s = E.createState({ entryPrice, firstQty, initialStop, params: paramsFor(sp.id, params, settings), now });
    if (!s || sp.kind === 'lifecycle') return s;
    delete s.plan; s.targets = {}; s.tranches = [];
    Object.assign(s, { strategy: sp.id, spec: clone(sp), stageLabels: labelsFor(sp), enteredAt: now || null, partialDone: false, costDone: false, warnLow: null });
    return s;
  }

  /** What an open trade has most likely already done, as a starting point for the switch checklist. */
  function detectDone(trade, strategyId, settings) {
    const sp = find(strategyId, settings);
    const first = (trade.entries || [])[0] || {};
    const qty = (trade.entries || []).concat(trade.pyramids || []).reduce((a, e) => a + (Number(e.qty) || 0), 0);
    const cost = qty ? (trade.entries || []).concat(trade.pyramids || []).reduce((a, e) => a + Number(e.qty) * (Number(e.price) || Number(first.price)), 0) / qty : Number(first.price);
    const stop = Number(trade.currentStop) || 0, sold = (trade.partialExits || []).length > 0;
    if (!sp || sp.kind === 'lifecycle') return { stage: (trade.pyramids || []).length ? (stop >= cost ? 3 : 2) : 1 };
    const n = normalise(sp);
    return { add: (trade.pyramids || []).length > 0, cost: stop >= cost, partial: sold, trancheSold: sold && n.partial.mode === 'trail' };
  }

  /**
   * Move an open trade to another strategy. `done` = what the user marked as already completed:
   *   lifecycle: { stage: 1..5 }   rules: { add, cost, partial, trancheSold, trancheQty, trancheStop }
   * Without `done`, it is detected from the trade (detectDone).
   */
  function switchState({ trade, strategyId, params, settings, now, done }) {
    const sp = find(strategyId, settings);
    const first = (trade.entries || [])[0];
    if (!sp || !first) return null;
    const d = done || detectDone(trade, strategyId, settings);
    const entered = Date.parse(`${first.date}T09:15:00+05:30`);
    const s = createState({ strategyId: sp.id, entryPrice: Number(first.price), firstQty: Number(first.qty), initialStop: Number(trade.initialStop), params, settings, now: Number.isFinite(entered) ? entered : now });
    if (!s) return null;
    s.hardStop = Math.max(s.hardStop, Number(trade.currentStop) || 0);
    if (sp.kind === 'lifecycle') {
      s.stage = Math.min(STAGES.R10, Math.max(STAGES.ENTERED, Number(d.stage) || STAGES.ENTERED));
      return s;
    }
    if (d.add) s.stage = Math.max(s.stage, STAGES.R1);
    if (d.cost) {
      s.costDone = true; s.stage = Math.max(s.stage, STAGES.R1);
      const lots = (trade.entries || []).concat(trade.pyramids || []), q = lots.reduce((x, e) => x + (Number(e.qty) || 0), 0);
      s.costPrice = I.roundTick(q ? lots.reduce((x, e) => x + Number(e.qty) * (Number(e.price) || Number(first.price)), 0) / q : Number(first.price));
      if (normalise(sp).stopToCost.trail) s.protStop = s.costPrice;     // raised to the EMA level at the next day start
    }
    if (d.partial) {
      s.partialDone = true; s.stage = Math.max(s.stage, STAGES.R2);
      if (normalise(sp).partial.mode === 'trail' && !d.trancheSold && Number(d.trancheQty) > 0 && Number(d.trancheStop) > 0)
        s.tranches = [{ id: 'P1', rule: RULES.PARTIAL_PROFIT, qty: Math.floor(Number(d.trancheQty)), trail: I.roundTick(Number(d.trancheStop)), status: 'active', openedAt: I.istDate(now || Date.now()), why: 'set when the strategy was switched' }];
    }
    return s;
  }

  const activeTranche = s => (s.tranches || []).find(t => t.status === 'active') || null;

  /** Protective trail level after the cost stop: max(cost, EMA − pct%) on the closed days. */
  function protLevel(s, sp, days, cost) {
    const c = sp.stopToCost, e = I.ema(days.map(x => x.close), c.emaPeriod);
    return { level: I.roundTick(Math.max(cost, e ? e * (1 - c.emaPct / 100) : 0)), ema: e };
  }

  /**
   * Daily-close decisions: trend exit of the trailed shares (two-level EMA, single EMA, or %), warning low, time exit.
   * `days` ends with the candle being decided (today at 15:25 with the 15:25 price as close, or yesterday as a fallback).
   */
  function closeDecisions(s, sp, days, openQty, px, when) {
    const actions = [], last = days[days.length - 1];
    s.lastCloseCheck = last.date;
    const tr = activeTranche(s);
    const trailQty = Math.max(0, openQty - (tr ? Math.min(tr.qty, openQty) : 0));
    const trailOn = sp.trail.type !== 'none' && (!sp.trail.afterPartial || !sp.partial.on || s.partialDone);
    if (trailOn && trailQty > 0) {
      const t = sp.trail; let exit = null, level = null;
      const close = `${when} close ${inr(last.close)}`;
      if (t.type === 'ema') {
        const e = I.ema(days.map(c => c.close), t.period);
        if (e) {
          if (t.confirm) {
            level = I.roundTick(e * (1 - t.deepPct / 100));
            if (last.close < level) exit = `${close} is below the ${t.period} EMA − ${t.deepPct}% (${inr(level)}) — trend broken, sell the trailed shares.`;
            else if (s.warnLow && last.close < s.warnLow) exit = `${close} is below the warning low ${inr(s.warnLow)} — weakness confirmed, sell the trailed shares.`;
            else if (last.close < e) s.warnLow = I.roundTick(last.low);
            else s.warnLow = null;
          } else {
            level = I.roundTick(e * (1 - t.bufferPct / 100));
            if (last.close < level) exit = `${close} is below the trail ${inr(level)} (${t.period} EMA less ${t.bufferPct}%) — trend broken, sell the trailed shares.`;
          }
        }
      } else if (t.type === 'pct') {
        const since = s.enteredAt ? I.istDate(s.enteredAt) : null;
        const hi = Math.max(...days.filter(c => !since || c.date >= since).map(c => c.close));
        if (Number.isFinite(hi)) {
          level = I.roundTick(hi * (1 - t.pct / 100));
          if (last.close < level) exit = `${close} is below the trail ${inr(level)} (highest close ${inr(hi)} less ${t.pct}%) — trend broken, sell the trailed shares.`;
        }
      }
      s.trendLevel = level;
      if (exit) {
        const all = trailQty >= openQty;
        actions.push({ rule: RULES.TREND_EXIT, kind: all ? 'EXIT_ALL' : 'SELL', qty: trailQty, price: px, fill: px, trail: level, why: exit });
        s.warnLow = null;
        if (all) { s.closed = true; return actions; }
      }
    }
    if (sp.timeExit.on && s.enteredAt && !actions.length) {
      const entryDate = I.istDate(s.enteredAt);
      const held = days.filter(c => c.date > entryDate);
      const high = Math.max(...days.filter(c => c.date >= entryDate).map(c => c.high));
      const need = s.entryPrice + sp.timeExit.minR * s.r;
      if (held.length >= sp.timeExit.days && !(high >= need)) {
        actions.push({ rule: RULES.TIME_EXIT, kind: 'EXIT_ALL', qty: openQty, price: px, fill: px,
          why: `${held.length} trading days since entry and +${sp.timeExit.minR}R (${inr(need)}) was never reached — the trade is stale, sell all.` });
        s.closed = true;
      }
    }
    return actions;
  }

  // ── Day start (rules strategies) ─────────────────────────────────────────
  function rulesDayStart({ state, position, market, now, params }) {
    const p = { ...R.DEFAULT_PARAMS, ...(params || {}) };
    const today = I.istDate(now);
    if (!state || state.lastDayStart === today) return { state, actions: [] };
    const s = clone(state), sp = normalise(s.spec);
    const days = I.closedDays((market && market.daily) || [], today);
    const last = days[days.length - 1];
    const px = (market && market.ltp) || (last && last.close) || s.entryPrice;
    s.lastDayStart = today;

    // 1. Fallback: yesterday's close decisions if the 15:25 check did not run (or the spec decides in the morning).
    if (last && s.lastCloseCheck !== last.date) {
      const actions = closeDecisions(s, sp, days, position.openQty, px, sp.closeMinute ? 'Yesterday\'s (missed at 15:25)' : 'Daily');
      if (s.closed) return { state: s, actions };
      if (actions.length) return { state: s, actions };   // the trailed shares go first; the brief follows tomorrow
    }

    // 2. Raise the tranche stop from yesterday's candle.
    const tr = activeTranche(s);
    if (tr && last) {
      const range = last.high - last.low, a = I.atr(days, p.atrPeriod);
      const large = a && range > sp.partial.largeAtr * a;
      const base = I.roundTick(large ? last.low + sp.partial.largeFrac * range : last.low);
      tr.trail = Math.max(tr.trail, base);
      tr.why = large ? `yesterday's range ${inr(range)} > ${sp.partial.largeAtr} × ATR ${inr(a)}: low ${inr(last.low)} + ${sp.partial.largeFrac} × range` : `yesterday's low ${inr(last.low)}`;
    }
    // 3. Raise the protective trail: max(cost, EMA − pct%), never down.
    if (s.costDone && sp.stopToCost.on && sp.stopToCost.trail && last) {
      const pl = protLevel(s, sp, days, s.costPrice || s.entryPrice);
      s.protStop = Math.max(s.protStop || 0, pl.level);
    }

    const parts = [`hard stop ${inr(s.hardStop)}`];
    if (s.protStop) parts.push(`protective trail ${inr(s.protStop)} (${sp.stopToCost.holdMin} min below sells all)`);
    if (tr) parts.push(`profit-booking stop ${inr(tr.trail)} for ${Math.min(tr.qty, position.openQty)} shares (${tr.why || 'from the 3R day'})`);
    if (s.trendLevel) parts.push(`trend exit if the ${sp.closeMinute ? hm(sp.closeMinute) : 'daily'} close is below ${inr(s.trendLevel)}${s.warnLow ? ` or the warning low ${inr(s.warnLow)}` : ''}`);
    const brief = { rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: position.openQty, stop: s.hardStop, why: 'Day start: ' + parts.join('; ') + '.' };
    if (tr) Object.assign(brief, { trail: tr.trail, trailQty: Math.min(tr.qty, position.openQty) });
    return { state: s, actions: [brief] };
  }

  // ── Intraday (rules strategies) ──────────────────────────────────────────
  function rulesEvaluate({ state, position, market, now, params }) {
    const p = { ...R.DEFAULT_PARAMS, ...(params || {}) };
    if (!state || !market || !(market.ltp > 0) || !(position.openQty > 0)) return { state, actions: [] };
    const s = clone(state), sp = normalise(s.spec), actions = [];
    const ltp = market.ltp, today = I.istDate(now), minute = I.istMinutes(now);
    let open = position.openQty, avg = position.avgEntry;
    const openMs = Date.parse(today + 'T00:00:00+05:30') + p.marketOpenMinute * 60000;
    const todays = (market.intraday || []).filter(c => c.time * 1000 >= openMs && c.time * 1000 <= now);
    const done = () => { s.lastEvalAt = now; return { state: s, actions }; };

    // Hard stop (the broker's GTT level): any price below it since the last evaluation, today.
    const since = Math.max(s.lastEvalAt || 0, openMs);
    const recent = (market.intraday || []).filter(c => (c.time + 60) * 1000 > since && c.time * 1000 <= now);
    const breach = recent.find(c => c.low < s.hardStop);
    if (breach || ltp < s.hardStop) {
      const fill = breach ? Math.min(breach.open, s.hardStop) : ltp;
      actions.push({ rule: RULES.HARD_EXIT, kind: 'EXIT_ALL', qty: open, price: ltp, fill: round2(fill), stop: s.hardStop });
      s.closed = true; return done();
    }
    // Protective trail after the cost stop: held below it → sell everything.
    if (s.protStop && I.holdBelow(market.intraday, s.protStop, sp.stopToCost.holdMin, ltp, now)) {
      actions.push({ rule: RULES.PROTECT_EXIT, kind: 'EXIT_ALL', qty: open, price: ltp, fill: ltp, trail: s.protStop,
        why: `Price held below the protective trail ${inr(s.protStop)} (max of cost and ${sp.stopToCost.emaPeriod} EMA − ${sp.stopToCost.emaPct}%) for ${sp.stopToCost.holdMin} min — sell everything.` });
      s.closed = true; return done();
    }
    // Profit-booking tranche: sold after it holds below its stop.
    const tr = activeTranche(s);
    if (tr && I.holdBelow(market.intraday, tr.trail, sp.partial.holdMin, ltp, now)) {
      const qty = Math.min(tr.qty, open);
      tr.status = 'sold';
      actions.push({ rule: RULES.TRANCHE_EXIT, kind: qty >= open ? 'EXIT_ALL' : 'SELL', qty, price: ltp, fill: ltp, trail: tr.trail, trancheId: tr.id,
        why: `Price held below the profit-booking stop ${inr(tr.trail)} for ${sp.partial.holdMin} min — sell the ${qty}-share tranche.` });
      open -= qty;
      if (open <= 0) { s.closed = true; return done(); }
    }

    const hold = level => I.holdAbove(market.intraday, level, p.targetHoldMin, ltp, now);
    if (sp.add.on && s.stage === STAGES.ENTERED) {
      const level = round2(s.entryPrice + sp.add.atR * s.r);
      if (hold(level)) {
        const qty = Math.max(1, Math.floor(s.firstQty * sp.add.pct / 100));
        s.stage = STAGES.R1;
        s.hardStop = Math.max(s.hardStop, I.roundTick(s.initialStop + sp.add.stopToR * s.r));
        avg = (avg * open + ltp * qty) / (open + qty); open += qty;
        actions.push({ rule: RULES.ADD_1R, kind: 'BUY', qty, price: ltp, fill: ltp, stop: s.hardStop, r: sp.add.atR,
          why: `Price held above ${sp.add.atR}R (${inr(level)}) for ${p.targetHoldMin} min — add ${qty} shares and raise the stop to ${inr(s.hardStop)}.` });
      }
    }
    if (sp.stopToCost.on && !s.costDone) {
      const level = round2(s.entryPrice + sp.stopToCost.atR * s.r);
      if (hold(level)) {
        s.costDone = true; s.costPrice = I.roundTick(avg);
        if (!sp.add.on) s.stage = Math.max(s.stage, STAGES.R1);
        const stop = s.costPrice;
        if (sp.stopToCost.trail) {
          const pl = protLevel(s, sp, I.closedDays(market.daily || [], today), stop);
          s.protStop = pl.level;
        }
        const extra = sp.stopToCost.trail ? `; protective trail ${inr(s.protStop)} = max(cost, ${sp.stopToCost.emaPeriod} EMA − ${sp.stopToCost.emaPct}%), ${sp.stopToCost.holdMin} min below it sells everything` : '';
        if (stop > s.hardStop) {
          s.hardStop = stop;
          actions.push({ rule: RULES.STOP_TO_COST, kind: 'STOP', price: ltp, stop, r: sp.stopToCost.atR,
            why: `Price held above ${sp.stopToCost.atR}R (${inr(level)}) for ${p.targetHoldMin} min — move the stop to your cost ${inr(stop)}${extra}.` });
        }
      }
    }
    if (sp.partial.on && !s.partialDone) {
      const level = round2(s.entryPrice + sp.partial.atR * s.r);
      if (hold(level)) {
        s.partialDone = true; s.stage = Math.max(s.stage, STAGES.R2);
        const qty = Math.floor(open * sp.partial.pct / 100);
        if (qty > 0 && qty < open) {
          if (sp.partial.mode === 'trail') {
            const dayLow = Math.min(ltp, ...todays.map(c => c.low));
            const trail = Math.max(I.roundTick(dayLow), s.hardStop);
            s.tranches.push({ id: 'P1', rule: RULES.PARTIAL_PROFIT, qty, trail, status: 'active', openedAt: today, why: `max(today's low ${inr(dayLow)}, hard stop ${inr(s.hardStop)})` });
            actions.push({ rule: RULES.PARTIAL_PROFIT, kind: 'TRAIL', qty, price: ltp, trail, trancheId: 'P1', r: sp.partial.atR,
              why: `Price held above ${sp.partial.atR}R (${inr(level)}) for ${p.targetHoldMin} min — no sale yet: ${qty} shares get a profit-booking stop ${inr(trail)} (max of today's low and the hard stop), raised each morning; the rest trails the ${sp.trail.period} EMA.` });
          } else {
            actions.push({ rule: RULES.PARTIAL_PROFIT, kind: 'SELL', qty, price: ltp, fill: ltp,
              why: `Price held above ${sp.partial.atR}R (${inr(level)}) for ${p.targetHoldMin} min — book ${sp.partial.pct}% (${qty} shares); the rest stays on the trail.` });
            open -= qty;
            if (sp.partial.stopAfter === 'cost') {
              const stop = I.roundTick(avg);
              if (stop > s.hardStop) {
                s.hardStop = stop; s.costDone = true;
                actions.push({ rule: RULES.STOP_TO_COST, kind: 'STOP', price: ltp, stop,
                  why: `After the partial, move the stop to your cost ${inr(stop)} so the rest cannot turn into a loss.` });
              }
            }
          }
        }
      }
    }

    // 15:25: daily-close decisions with the current price taken as today's close.
    if (sp.closeMinute && minute >= sp.closeMinute && s.lastCloseCheck !== today && todays.length && !actions.some(a => a.kind === 'EXIT_ALL')) {
      const days = [...I.closedDays(market.daily || [], today),
        { date: today, open: todays[0].open, high: Math.max(ltp, ...todays.map(c => c.high)), low: Math.min(ltp, ...todays.map(c => c.low)), close: ltp }];
      actions.push(...closeDecisions(s, sp, days, open, ltp, `${hm(minute)}`));
    }
    return done();
  }

  const dayStart = args => (isRules(args.state) ? rulesDayStart(args) : E.dayStart(args));
  const evaluate = args => (isRules(args.state) ? rulesEvaluate(args) : E.evaluate(args));

  const api = { STRATEGY_A, STRATEGY_B, list, find, defaultId, normalise, validate, describe, paramsFor, createState, detectDone, switchState, dayStart, evaluate, isRules, strategyOf, activeTranche };
  root.TLMStrategies = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
