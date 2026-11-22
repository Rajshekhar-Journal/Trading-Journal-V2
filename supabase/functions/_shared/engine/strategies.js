/**
 * engine/strategies.js — trade-management strategies. A position follows exactly one.
 *
 *   A       the lifecycle already built (LC-01…LC-10, js/engine/tlm-engine.js). Untouched.
 *   B       one full-size entry · book 50% at 3R · trail the rest: exit on a daily close below the 21 EMA less a buffer ·
 *           time exit: not at +1R after N trading days.
 *   custom  any number of strategies you build from the same blocks (settings.strategies).
 *
 * A strategy of kind 'rules' is a plain data object; the one interpreter below runs all of them.
 * The strategy chosen is frozen into the trade's lifecycle state (state.spec), so editing a strategy later never changes an open trade.
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
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);

  const STRATEGY_A = Object.freeze({ id: 'A', name: 'Strategy A — Lifecycle (LC-01 … LC-10)', kind: 'lifecycle', builtin: true });
  const STRATEGY_B = Object.freeze({
    id: 'B', name: 'Strategy B — 3R partial + 21 EMA trail', kind: 'rules', builtin: true,
    entryPct: 100,                                                         // % of the planned full size bought at entry
    add:      { on: false, atR: 1, pct: 100, stopToR: 0.5 },               // add `pct`% of the first quantity at atR; stop to initial + stopToR·R
    partial:  { on: true, atR: 3, pct: 50, stopAfter: 'cost' },            // sell pct% of the open quantity at atR; stop then to 'cost' | 'none'
    trail:    { type: 'ema', period: 21, bufferPct: 1, pct: 8, afterPartial: true },   // type: ema | pct | none
    timeExit: { on: true, days: 10, minR: 1 },                             // exit all if +minR was not reached within `days` trading days
  });

  /** Error text for a rules strategy, or null. */
  function validate(sp) {
    if (!sp || sp.kind === 'lifecycle') return null;
    if (!String(sp.name || '').trim()) return 'Give the strategy a name.';
    if (!(sp.entryPct >= 10 && sp.entryPct <= 100)) return 'Entry size must be between 10% and 100% of the planned size.';
    if (sp.add.on && !(sp.add.atR > 0 && sp.add.pct > 0 && sp.add.pct <= 200 && sp.add.stopToR >= 0)) return 'Add: R level and size must be positive.';
    if (sp.partial.on) {
      if (!(sp.partial.atR > 0)) return 'Partial profit: the R level must be positive.';
      if (!(sp.partial.pct >= 1 && sp.partial.pct <= 99)) return 'Partial profit: the percentage sold must be between 1 and 99.';
      if (sp.add.on && !(sp.add.atR < sp.partial.atR)) return 'The add level must be below the partial-profit level.';
    }
    if (sp.trail.type === 'ema' && !(sp.trail.period >= 2 && sp.trail.period <= 200)) return 'Trail: EMA period must be between 2 and 200.';
    if (sp.trail.type === 'pct' && !(sp.trail.pct > 0 && sp.trail.pct < 50)) return 'Trail: percentage must be between 0 and 50.';
    if (!(sp.trail.bufferPct >= 0 && sp.trail.bufferPct <= 10)) return 'Trail: buffer must be between 0% and 10%.';
    if (sp.timeExit.on && !(sp.timeExit.days >= 2 && sp.timeExit.days <= 120 && sp.timeExit.minR >= 0)) return 'Time exit: days must be 2–120 and the R level not negative.';
    if (!sp.partial.on && sp.trail.type === 'none' && !sp.timeExit.on) return 'A strategy with no partial profit, no trail and no time exit has no way to exit except the hard stop. Turn one on.';
    return null;
  }

  /** Fill every field of a (possibly partial) rules strategy from B's defaults. */
  function normalise(raw) {
    const b = STRATEGY_B, r = raw || {};
    return {
      id: String(r.id || ''), name: String(r.name || '').trim(), kind: 'rules', builtin: !!r.builtin,
      entryPct: num(r.entryPct, b.entryPct),
      add: { on: !!(r.add && r.add.on), atR: num(r.add && r.add.atR, 1), pct: num(r.add && r.add.pct, 100), stopToR: num(r.add && r.add.stopToR, 0.5) },
      partial: { on: r.partial ? !!r.partial.on : b.partial.on, atR: num(r.partial && r.partial.atR, b.partial.atR), pct: num(r.partial && r.partial.pct, b.partial.pct),
        stopAfter: r.partial && r.partial.stopAfter === 'none' ? 'none' : 'cost' },
      trail: { type: ['ema', 'pct', 'none'].includes(r.trail && r.trail.type) ? r.trail.type : b.trail.type, period: num(r.trail && r.trail.period, b.trail.period),
        bufferPct: num(r.trail && r.trail.bufferPct, b.trail.bufferPct), pct: num(r.trail && r.trail.pct, b.trail.pct), afterPartial: r.trail ? r.trail.afterPartial !== false : true },
      timeExit: { on: r.timeExit ? !!r.timeExit.on : b.timeExit.on, days: num(r.timeExit && r.timeExit.days, b.timeExit.days), minR: num(r.timeExit && r.timeExit.minR, b.timeExit.minR) },
    };
  }

  /** All strategies: A, B (your saved edit of B, if any) and your custom ones. */
  function list(settings) {
    const saved = (settings && Array.isArray(settings.strategies)) ? settings.strategies : [];
    const out = [STRATEGY_A];
    const b = saved.find(x => x && x.id === 'B');
    out.push(b ? { ...normalise(b), id: 'B', builtin: true } : normalise(STRATEGY_B));
    for (const c of saved) if (c && c.id && c.id !== 'A' && c.id !== 'B') out.push({ ...normalise(c), id: String(c.id) });
    return out;
  }
  const find = (id, settings) => list(settings).find(x => x.id === id) || null;
  /** The strategy used when a watchlist item or trade names none. */
  const defaultId = settings => (settings && find(settings.defaultStrategy, settings)) ? settings.defaultStrategy : 'A';
  const isRules = state => !!(state && state.spec && state.spec.kind === 'rules');
  const strategyOf = state => (state && state.strategy) || 'A';

  /** Planning parameters for sizing: the first-entry share comes from the strategy. */
  function paramsFor(id, params, settings) {
    const sp = find(id || defaultId(settings), settings);
    return sp && sp.kind === 'rules' ? { ...params, firstEntryPct: sp.entryPct } : params;
  }

  /** One line per rule, for settings, the position panel and the alert dashboard. */
  function describe(sp) {
    if (!sp) return [];
    if (sp.kind === 'lifecycle') return ['Strategy A: the lifecycle rules LC-01 … LC-10 (adds, stop locks, tranche trails) as set in Settings → Lifecycle.'];
    const out = [`Entry: ${sp.entryPct}% of the planned size.`];
    out.push(sp.add.on ? `Add: ${sp.add.pct}% of the first quantity at ${sp.add.atR}R, stop to initial + ${sp.add.stopToR}R.` : 'No add.');
    out.push(sp.partial.on ? `Partial profit: sell ${sp.partial.pct}% at ${sp.partial.atR}R${sp.partial.stopAfter === 'cost' ? ', then stop to cost' : ''}.` : 'No partial profit.');
    const t = sp.trail, when = t.afterPartial ? ' (after the partial)' : '';
    out.push(t.type === 'ema' ? `Trail: exit the rest on a daily close below the ${t.period} EMA less ${t.bufferPct}%${when}.`
      : t.type === 'pct' ? `Trail: exit the rest on a daily close ${t.pct}% below the highest close since entry${when}.` : 'No trail.');
    out.push(sp.timeExit.on ? `Time exit: exit all if +${sp.timeExit.minR}R was not reached within ${sp.timeExit.days} trading days.` : 'No time exit.');
    out.push('Hard stop always applies.');
    return out;
  }

  const labelsFor = sp => ['Watching', 'Entered', sp.add.on ? `Added at ${sp.add.atR}R` : 'Entered', sp.partial.on ? `Partial booked at ${sp.partial.atR}R` : 'Entered',
    sp.trail.type !== 'none' ? 'Trailing' : 'Entered', 'Trailing'];

  /** New lifecycle state for a strategy. Strategy A returns exactly what the lifecycle engine always built. */
  function createState({ strategyId, entryPrice, firstQty, initialStop, params, settings, now }) {
    const sp = find(strategyId || defaultId(settings), settings) || STRATEGY_A;
    const s = E.createState({ entryPrice, firstQty, initialStop, params: paramsFor(sp.id, params, settings), now });
    if (!s || sp.kind === 'lifecycle') return s;
    delete s.plan; s.targets = {}; s.tranches = [];
    Object.assign(s, { strategy: sp.id, spec: clone(sp), stageLabels: labelsFor(sp), enteredAt: now || null, partialDone: false });
    return s;
  }

  /** Move an open trade to another strategy. Stage flags follow what already happened (adds, partial exits). */
  function switchState({ trade, strategyId, params, settings, now }) {
    const sp = find(strategyId, settings);
    const first = (trade.entries || [])[0];
    if (!sp || !first) return null;
    const entered = Date.parse(`${first.date}T09:15:00+05:30`);
    const s = createState({ strategyId: sp.id, entryPrice: Number(first.price), firstQty: Number(first.qty), initialStop: Number(trade.initialStop), params, settings, now: Number.isFinite(entered) ? entered : now });
    if (!s) return null;
    s.hardStop = Math.max(s.hardStop, Number(trade.currentStop) || 0);
    if ((trade.pyramids || []).length) s.stage = Math.max(s.stage, STAGES.R1);
    if (sp.kind === 'rules' && (trade.partialExits || []).length) { s.partialDone = true; s.stage = Math.max(s.stage, STAGES.R2); }
    return s;
  }

  // ── Day start (rules strategies) ─────────────────────────────────────────
  function trailLevel(s, days) {
    const t = s.spec.trail;
    if (t.type === 'none' || !days.length) return null;
    if (t.type === 'ema') {
      const e = I.ema(days.map(c => c.close), t.period);
      return e ? { level: I.roundTick(e * (1 - t.bufferPct / 100)), basis: `${t.period} EMA ${inr(e)}${t.bufferPct ? ` less ${t.bufferPct}%` : ''}` } : null;
    }
    const since = s.enteredAt ? I.istDate(s.enteredAt) : null;
    const hi = Math.max(...days.filter(c => !since || c.date >= since).map(c => c.close));
    return Number.isFinite(hi) ? { level: I.roundTick(hi * (1 - t.pct / 100)), basis: `highest close ${inr(hi)} less ${t.pct}%` } : null;
  }

  function rulesDayStart({ state, position, market, now }) {
    const today = I.istDate(now);
    if (!state || state.lastDayStart === today) return { state, actions: [] };
    const s = clone(state), sp = s.spec, actions = [];
    const days = I.closedDays((market && market.daily) || [], today);
    const last = days[days.length - 1];
    const px = (market && market.ltp) || (last && last.close) || s.entryPrice;
    const trailOn = sp.trail.type !== 'none' && (!sp.trail.afterPartial || s.partialDone);
    const tl = trailOn ? trailLevel(s, days) : null;

    if (tl && last && last.close < tl.level) {
      actions.push({ rule: RULES.TREND_EXIT, kind: 'EXIT_ALL', qty: position.openQty, price: px, fill: px, trail: tl.level,
        why: `Daily close ${inr(last.close)} is below the trail ${inr(tl.level)} (${tl.basis}) — trend broken, exit the remaining position.` });
      s.closed = true; s.lastDayStart = today;
      return { state: s, actions };
    }
    if (sp.timeExit.on && s.enteredAt && days.length) {
      const entryDate = I.istDate(s.enteredAt);
      const held = days.filter(c => c.date > entryDate);
      const high = Math.max(...days.filter(c => c.date >= entryDate).map(c => c.high));
      const need = s.entryPrice + sp.timeExit.minR * s.r;
      if (held.length >= sp.timeExit.days && !(high >= need)) {
        actions.push({ rule: RULES.TIME_EXIT, kind: 'EXIT_ALL', qty: position.openQty, price: px, fill: px,
          why: `${held.length} trading days since entry and +${sp.timeExit.minR}R (${inr(need)}) was never reached — the trade is stale, exit all.` });
        s.closed = true; s.lastDayStart = today;
        return { state: s, actions };
      }
    }
    s.lastDayStart = today;
    const brief = { rule: RULES.DAY_BRIEF, kind: 'BRIEF', qty: position.openQty, stop: s.hardStop,
      why: `Day start: hard stop ${inr(s.hardStop)}` + (tl ? `; trail exit level ${inr(tl.level)} (${tl.basis}) — acts only on a daily close below it.` : '.') };
    if (tl) Object.assign(brief, { trail: tl.level, trailQty: position.openQty });
    actions.push(brief);
    return { state: s, actions };
  }

  // ── Intraday (rules strategies) ──────────────────────────────────────────
  function rulesEvaluate({ state, position, market, now, params }) {
    const p = { ...R.DEFAULT_PARAMS, ...(params || {}) };
    if (!state || !market || !(market.ltp > 0) || !(position.openQty > 0)) return { state, actions: [] };
    const s = clone(state), sp = s.spec, actions = [];
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
    if (sp.partial.on && !s.partialDone) {
      const level = round2(s.entryPrice + sp.partial.atR * s.r);
      if (hold(level)) {
        s.partialDone = true; s.stage = Math.max(s.stage, STAGES.R2);
        const qty = Math.floor(open * sp.partial.pct / 100);
        if (qty > 0 && qty < open) {
          actions.push({ rule: RULES.PARTIAL_PROFIT, kind: 'SELL', qty, price: ltp, fill: ltp,
            why: `Price held above ${sp.partial.atR}R (${inr(level)}) for ${p.targetHoldMin} min — book ${sp.partial.pct}% (${qty} shares); the rest stays on the trail.` });
          open -= qty;
          if (sp.partial.stopAfter === 'cost') {
            const stop = I.roundTick(avg);
            if (stop > s.hardStop) {
              s.hardStop = stop;
              actions.push({ rule: RULES.STOP_TO_COST, kind: 'STOP', price: ltp, stop,
                why: `After the partial, move the stop to your cost ${inr(stop)} so the rest cannot turn into a loss.` });
            }
          }
        }
      }
    }
    s.lastEvalAt = now;
    return { state: s, actions };
  }

  // ── Dispatch: the runner calls these instead of TLMEngine's ──────────────
  const dayStart = args => (isRules(args.state) ? rulesDayStart(args) : E.dayStart(args));
  const evaluate = args => (isRules(args.state) ? rulesEvaluate(args) : E.evaluate(args));

  const api = { STRATEGY_A, STRATEGY_B, list, find, defaultId, normalise, validate, describe, paramsFor, createState, switchState, dayStart, evaluate, isRules, strategyOf };
  root.TLMStrategies = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
