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
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : d);

  const STRATEGY_A = Object.freeze({ id: 'A', name: 'Strategy A — Lifecycle (LC-01 … LC-10)', kind: 'lifecycle', builtin: true });
  const STRATEGY_B = Object.freeze({
    id: 'B', name: 'Strategy B — 3R trailed partial + 21 EMA', kind: 'rules', builtin: true,
    entryPct: 100,                                                           // % of the planned full size bought at entry
    add:        { on: false, atR: 1, pct: 100, stopToR: 0.5 },               // add pct% of the first qty at atR; stop to initial + stopToR·R
    stopToCost: { on: true, atR: 2 },                                        // move the hard stop to the average cost at this R
    partial:    { on: true, atR: 3, pct: 50, mode: 'trail', stopAfter: 'none',   // mode: 'sell' at once | 'trail' a tranche with its own stop
                  holdMin: 5, largeAtr: 3, largeFrac: 0.25 },                //   trail: sold after holdMin below its stop; large candle = range > largeAtr × ATR14
    trail:      { type: 'ema', period: 21, deepPct: 2, confirm: true, bufferPct: 1, pct: 8, afterPartial: true },
    //            ema + confirm: close < EMA − deepPct% exits; close between that and the EMA sets a warning low; a later close below it exits
    //            ema without confirm: close < EMA − bufferPct% exits · pct: close pct% below the highest close since entry exits
    timeExit:   { on: true, days: 10, minR: 1 },
  });

  /** Error text for a rules strategy, or null. */
  function validate(sp) {
    if (!sp || sp.kind === 'lifecycle') return null;
    if (!String(sp.name || '').trim()) return 'Give the strategy a name.';
    if (!(sp.entryPct >= 10 && sp.entryPct <= 100)) return 'Entry size must be between 10% and 100% of the planned size.';
    if (sp.add.on && !(sp.add.atR > 0 && sp.add.pct > 0 && sp.add.pct <= 200 && sp.add.stopToR >= 0)) return 'Add: R level and size must be positive.';
    if (sp.stopToCost.on && !(sp.stopToCost.atR > 0)) return 'Stop to cost: the R level must be positive.';
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
      stopToCost: s ? { on: !!s.on, atR: num(s.atR, 2) } : (r.partial ? { on: false, atR: 2 } : { ...b.stopToCost }),   // older saved strategies had no such block
      partial: { on: r.partial ? !!p.on : b.partial.on, atR: num(p.atR, b.partial.atR), pct: num(p.pct, b.partial.pct),
        mode: p.mode === 'trail' ? 'trail' : (p.mode === 'sell' || r.partial ? 'sell' : b.partial.mode),
        stopAfter: p.stopAfter === 'cost' ? 'cost' : (p.stopAfter === 'none' ? 'none' : (r.partial ? 'cost' : b.partial.stopAfter)),
        holdMin: num(p.holdMin, b.partial.holdMin), largeAtr: num(p.largeAtr, b.partial.largeAtr), largeFrac: num(p.largeFrac, b.partial.largeFrac) },
      trail: { type: ['ema', 'pct', 'none'].includes(t.type) ? t.type : b.trail.type, period: num(t.period, b.trail.period),
        deepPct: num(t.deepPct, b.trail.deepPct), confirm: r.trail ? !!t.confirm : b.trail.confirm, bufferPct: num(t.bufferPct, b.trail.bufferPct),
        pct: num(t.pct, b.trail.pct), afterPartial: r.trail ? t.afterPartial !== false : true },
      timeExit: { on: r.timeExit ? !!x.on : b.timeExit.on, days: num(x.days, b.timeExit.days), minR: num(x.minR, b.timeExit.minR) },
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
  function describe(sp) {
    if (!sp) return [];
    if (sp.kind === 'lifecycle') return ['Strategy A: the lifecycle rules LC-01 … LC-10 (adds, stop locks, tranche trails) as set in Lifecycle settings.'];
    sp = normalise(sp);
    const out = [`Entry: ${sp.entryPct}% of the planned size.`];
    out.push(sp.add.on ? `Add: ${sp.add.pct}% of the first quantity at ${sp.add.atR}R, stop to initial + ${sp.add.stopToR}R.` : 'No add.');
    if (sp.stopToCost.on) out.push(`Stop to cost: at ${sp.stopToCost.atR}R the hard stop moves to your average cost.`);
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

  /** Move an open trade to another strategy. Flags follow what already happened (adds, partial exits, stop at/above cost). */
  function switchState({ trade, strategyId, params, settings, now }) {
    const sp = find(strategyId, settings);
    const first = (trade.entries || [])[0];
    if (!sp || !first) return null;
    const entered = Date.parse(`${first.date}T09:15:00+05:30`);
    const s = createState({ strategyId: sp.id, entryPrice: Number(first.price), firstQty: Number(first.qty), initialStop: Number(trade.initialStop), params, settings, now: Number.isFinite(entered) ? entered : now });
    if (!s) return null;
    s.hardStop = Math.max(s.hardStop, Number(trade.currentStop) || 0);
    if ((trade.pyramids || []).length) s.stage = Math.max(s.stage, STAGES.R1);
    if (sp.kind === 'rules') {
      if (s.hardStop >= s.entryPrice) s.costDone = true;
      if ((trade.partialExits || []).length) { s.partialDone = true; s.stage = Math.max(s.stage, STAGES.R2); }
    }
    return s;
  }

  const activeTranche = s => (s.tranches || []).find(t => t.status === 'active') || null;

  // ── Day start (rules strategies) ─────────────────────────────────────────
  function rulesDayStart({ state, position, market, now, params }) {
    const p = { ...R.DEFAULT_PARAMS, ...(params || {}) };
    const today = I.istDate(now);
    if (!state || state.lastDayStart === today) return { state, actions: [] };
    const s = clone(state), sp = normalise(s.spec), actions = [];   // normalise: trades frozen with an older version of the spec keep their rules
    const days = I.closedDays((market && market.daily) || [], today);
    const last = days[days.length - 1];
    const px = (market && market.ltp) || (last && last.close) || s.entryPrice;
    const tr = activeTranche(s);
    const trailQty = Math.max(0, position.openQty - (tr ? Math.min(tr.qty, position.openQty) : 0));
    const trailOn = sp.trail.type !== 'none' && (!sp.trail.afterPartial || !sp.partial.on || s.partialDone);
    s.lastDayStart = today;

    // 1. Trend exit of the trailed shares (the shares outside an active tranche).
    let level = null, basis = '';
    if (trailOn && last && trailQty > 0) {
      const t = sp.trail;
      let exit = null;
      if (t.type === 'ema') {
        const e = I.ema(days.map(c => c.close), t.period);
        if (e) {
          if (t.confirm) {
            const deep = I.roundTick(e * (1 - t.deepPct / 100));
            level = deep; basis = `${t.period} EMA ${inr(e)} − ${t.deepPct}%`;
            if (last.close < deep) exit = `Daily close ${inr(last.close)} is below the ${t.period} EMA − ${t.deepPct}% (${inr(deep)}) — trend broken, exit the trailed shares.`;
            else if (s.warnLow && last.close < s.warnLow) exit = `Daily close ${inr(last.close)} is below the warning low ${inr(s.warnLow)} — weakness confirmed, exit the trailed shares.`;
            else if (last.close < e) s.warnLow = I.roundTick(last.low);
            else s.warnLow = null;
          } else {
            level = I.roundTick(e * (1 - t.bufferPct / 100)); basis = `${t.period} EMA ${inr(e)} less ${t.bufferPct}%`;
            if (last.close < level) exit = `Daily close ${inr(last.close)} is below the trail ${inr(level)} (${basis}) — trend broken, exit the trailed shares.`;
          }
        }
      } else if (t.type === 'pct') {
        const since = s.enteredAt ? I.istDate(s.enteredAt) : null;
        const hi = Math.max(...days.filter(c => !since || c.date >= since).map(c => c.close));
        if (Number.isFinite(hi)) {
          level = I.roundTick(hi * (1 - t.pct / 100)); basis = `highest close ${inr(hi)} less ${t.pct}%`;
          if (last.close < level) exit = `Daily close ${inr(last.close)} is below the trail ${inr(level)} (${basis}) — trend broken, exit the trailed shares.`;
        }
      }
      if (exit) {
        const all = trailQty >= position.openQty;
        actions.push({ rule: RULES.TREND_EXIT, kind: all ? 'EXIT_ALL' : 'SELL', qty: trailQty, price: px, fill: px, trail: level, why: exit });
        s.warnLow = null;
        if (all) { s.closed = true; return { state: s, actions }; }
      }
    }

    // 2. Time exit: going nowhere.
    if (sp.timeExit.on && s.enteredAt && days.length && !actions.length) {
      const entryDate = I.istDate(s.enteredAt);
      const held = days.filter(c => c.date > entryDate);
      const high = Math.max(...days.filter(c => c.date >= entryDate).map(c => c.high));
      const need = s.entryPrice + sp.timeExit.minR * s.r;
      if (held.length >= sp.timeExit.days && !(high >= need)) {
        actions.push({ rule: RULES.TIME_EXIT, kind: 'EXIT_ALL', qty: position.openQty, price: px, fill: px,
          why: `${held.length} trading days since entry and +${sp.timeExit.minR}R (${inr(need)}) was never reached — the trade is stale, exit all.` });
        s.closed = true;
        return { state: s, actions };
      }
    }

    // 3. Raise the tranche stop from yesterday's candle.
    if (tr && last) {
      const range = last.high - last.low, a = I.atr(days, p.atrPeriod);
      const large = a && range > sp.partial.largeAtr * a;
      const base = I.roundTick(large ? last.low + sp.partial.largeFrac * range : last.low);
      const before = tr.trail;
      tr.trail = Math.max(tr.trail, base);
      tr.why = large ? `yesterday's range ${inr(range)} > ${sp.partial.largeAtr} × ATR ${inr(a)}: low ${inr(last.low)} + ${sp.partial.largeFrac} × range` : `yesterday's low ${inr(last.low)}`;
      if (tr.trail > before) tr.raisedAt = today;
    }

    const parts = [`hard stop ${inr(s.hardStop)}`];
    if (tr) parts.push(`profit-booking stop ${inr(tr.trail)} for ${Math.min(tr.qty, position.openQty)} shares (${tr.why || 'from the 3R day'})`);
    if (level && trailQty > 0 && trailOn) parts.push(`trend exit below ${inr(level)} on a daily close${s.warnLow ? `, warning low ${inr(s.warnLow)}` : ''}`);
    const brief = { rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: position.openQty, stop: s.hardStop, why: 'Day start: ' + parts.join('; ') + '.' };
    if (tr) Object.assign(brief, { trail: tr.trail, trailQty: Math.min(tr.qty, position.openQty) });
    actions.push(brief);
    return { state: s, actions };
  }

  // ── Intraday (rules strategies) ──────────────────────────────────────────
  function rulesEvaluate({ state, position, market, now, params }) {
    const p = { ...R.DEFAULT_PARAMS, ...(params || {}) };
    if (!state || !market || !(market.ltp > 0) || !(position.openQty > 0)) return { state, actions: [] };
    const s = clone(state), sp = normalise(s.spec), actions = [];   // normalise: trades frozen with an older version of the spec keep their rules
    const ltp = market.ltp, today = I.istDate(now);
    let open = position.openQty, avg = position.avgEntry;

    // Hard stop: any price below it since the last evaluation, today.
    const openMs = Date.parse(today + 'T00:00:00+05:30') + p.marketOpenMinute * 60000;
    const since = Math.max(s.lastEvalAt || 0, openMs);
    const recent = (market.intraday || []).filter(c => (c.time + 60) * 1000 > since && c.time * 1000 <= now);
    const breach = recent.find(c => c.low < s.hardStop);
    if (breach || ltp < s.hardStop) {
      const fill = breach ? Math.min(breach.open, s.hardStop) : ltp;
      actions.push({ rule: RULES.HARD_EXIT, kind: 'EXIT_ALL', qty: open, price: ltp, fill: round2(fill), stop: s.hardStop });
      s.lastEvalAt = now; s.closed = true;
      return { state: s, actions };
    }

    // Profit-booking tranche: sold after it holds below its stop.
    const tr = activeTranche(s);
    if (tr && I.holdBelow(market.intraday, tr.trail, sp.partial.holdMin, ltp, now)) {
      const qty = Math.min(tr.qty, open);
      tr.status = 'sold';
      actions.push({ rule: RULES.TRANCHE_EXIT, kind: qty >= open ? 'EXIT_ALL' : 'SELL', qty, price: ltp, fill: ltp, trail: tr.trail, trancheId: tr.id,
        why: `Price held below the profit-booking stop ${inr(tr.trail)} for ${sp.partial.holdMin} min — sell the ${qty}-share tranche.` });
      open -= qty;
      if (open <= 0) { s.closed = true; s.lastEvalAt = now; return { state: s, actions }; }
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
        s.costDone = true;
        if (!sp.add.on) s.stage = Math.max(s.stage, STAGES.R1);
        const stop = I.roundTick(avg);
        if (stop > s.hardStop) {
          s.hardStop = stop;
          actions.push({ rule: RULES.STOP_TO_COST, kind: 'STOP', price: ltp, stop, r: sp.stopToCost.atR,
            why: `Price held above ${sp.stopToCost.atR}R (${inr(level)}) for ${p.targetHoldMin} min — move the stop to your cost ${inr(stop)}; the trade can no longer lose.` });
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
            const dayLow = Math.min(ltp, ...(market.intraday || []).filter(c => c.time * 1000 >= openMs && c.time * 1000 <= now).map(c => c.low));
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
    s.lastEvalAt = now;
    return { state: s, actions };
  }

  const dayStart = args => (isRules(args.state) ? rulesDayStart(args) : E.dayStart(args));
  const evaluate = args => (isRules(args.state) ? rulesEvaluate(args) : E.evaluate(args));

  const api = { STRATEGY_A, STRATEGY_B, list, find, defaultId, normalise, validate, describe, paramsFor, createState, switchState, dayStart, evaluate, isRules, strategyOf, activeTranche };
  root.TLMStrategies = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
