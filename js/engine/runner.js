/**
 * engine/runner.js — runs the Trade Lifecycle engine every minute in the browser.
 *
 * Each cycle: load open real trades, open paper trades and monitoring watchlist
 * items → fetch candles once per symbol → day-start brief (LC-06/08/10) →
 * evaluate rules → paper actions booked, real actions alerted → save.
 * Runs 09:00–15:31 IST on trading days; `runCycle({ force: true })` runs any time.
 * Emits `window` event 'tlm:cycle' after every completed cycle.
 */
(function (root) {
  const I = root.TLMIndicators, E = root.TLMEngine, X = root.TLMExecutors, A = root.TLMAlerts;
  const { DEFAULT_PARAMS, RULES } = root.TLMRules;

  let _timer = null;
  let _running = false;
  let _lastRun = null;

  let _cachedParams = { ...DEFAULT_PARAMS };
  const paramsFrom = settings => (_cachedParams = { ...DEFAULT_PARAMS, ...(settings?.tlmParams || {}) });

  function isHoliday(todayIso, settings) {
    const [y, m, d] = todayIso.split('-');
    return (settings?.marketHolidays || '').includes(`${d}-${m}-${y}`);
  }

  /** Inside the engine's working window today (brief at 09:00, rules until close). */
  function inWindow(now, settings, p) {
    const wd = I.istWeekday(now);
    if (wd === 0 || wd === 6 || isHoliday(I.istDate(now), settings)) return false;
    const m = I.istMinutes(now);
    return m >= p.briefMinute && m <= p.marketCloseMinute + 1;
  }

  /** Default RPT from Settings → Risk Management (fixed or dynamic), same everywhere. */
  async function _defaultRpt(settings) {
    settings = settings || await db.getSettings();
    const [capital, closed] = await Promise.all([db.getCapital(), db.getClosedTrades()]);
    const equity = calc.getCurrentEquity(capital, calc.getTotalPnl(closed));
    return calc.getCurrentR(equity, settings);
  }

  /** Save one chart snapshot per entry / pyramid record not yet captured. */
  async function _snapshots(trade, mode, mk, today) {
    const s = trade.tlmState;
    if (!s || !mk?.daily?.length) return false;
    const taken = new Set(s.snapshotsTaken || []);
    const records = [...(trade.entries || []).map(r => ({ r, rule: RULES.ENTRY })), ...(trade.pyramids || []).map(r => ({ r, rule: RULES.ADD_1R }))];
    let added = false;
    for (const { r, rule } of records) {
      if (!r.id || taken.has(r.id)) continue;
      await db.saveSnapshot({
        trade_id: trade.id, mode, rule_id: rule, entry_ref: r.id, entry_date: r.date,
        daily: mk.daily.filter(c => c.date <= r.date).slice(-120),
        intraday: r.date === today ? mk.intraday : [],
        levels: { initialStop: s.initialStop, targets: s.targets, fill: r.price, qty: r.qty },
      });
      taken.add(r.id);
      added = true;
    }
    s.snapshotsTaken = [...taken];
    return added;
  }

  async function _handleTrade(trade, mode, ctx) {
    const { settings, p, now, today, minute, market } = ctx;
    const m = calc.getTradeMetrics(trade);
    if (m.openQty <= 0) return;
    const mk = market[trade.symbol];
    let state = trade.tlmState || E.stateFromTrade(trade, m.currentStop, p);
    if (!state) return;
    let dirty = !trade.tlmState;
    const position = { openQty: m.openQty, avgEntry: m.avgEntryPrice };
    const actions = [];

    if (mk?.daily?.length && (ctx.force || minute >= p.briefMinute)) {
      const r = E.dayStart({ state, position, market: mk, now, params: p });
      state = r.state; actions.push(...r.actions);
    }
    if (mk?.ltp && (ctx.force || minute >= p.marketOpenMinute)) {
      const r = E.evaluate({ state, position, market: mk, now, params: p });
      state = r.state; actions.push(...r.actions);
      dirty = true;   // lastEvalAt moved
    }
    if (mode === 'real') delete state.closed;   // a real trade closes only when the trader records the exit

    let updated = { ...trade, tlmState: state, cmp: mk?.ltp || trade.cmp };
    if (mode === 'paper' && actions.length) updated = X.applyPaper(updated, actions, { settings, date: today, openQty: m.openQty });
    if (await _snapshots(updated, mode, mk, today)) dirty = true;

    if (dirty || actions.length || updated.cmp !== trade.cmp) {
      await (mode === 'paper' ? db.savePaperTrade(updated) : db.saveTrade(updated));
    }
    for (const action of actions) {
      if (mode === 'paper' && action.kind === 'BRIEF' && !(action.stop > (trade.currentStop || 0))) continue; // quiet paper briefs
      await A.dispatch({ action, symbol: trade.symbol, mode, tradeId: trade.id, stage: state.stage, cmp: mk?.ltp,
        settings, params: p, alertsToday: ctx.alertsToday, now });
    }
  }

  async function _handleWatch(item, ctx) {
    const { settings, p, now, today, market } = ctx;
    const mk = market[item.symbol];
    const action = E.evaluateWatch({ item, market: mk, now, params: p });
    if (!action) return;
    const plan = E.planPosition({ trigger: Number(item.trigger_price), stop: Number(item.stop_loss), rpt: Number(item.rpt) || ctx.rpt, params: p });
    if (!plan) return;
    const mode = item.mode || 'both';

    if (mode === 'real' || mode === 'both') {
      await A.dispatch({ action: { ...action, qty: plan.firstQty }, symbol: item.symbol, mode: 'real', watchlistId: item.id,
        stage: 0, cmp: mk.ltp, settings, params: p, alertsToday: ctx.alertsToday, now });
    }
    if (mode === 'paper' || mode === 'both') {
      const state = E.createState({ entryPrice: action.price, firstQty: plan.firstQty, initialStop: action.stop, params: p, now });
      if (state) {
        const trade = X.createPaperTrade({ item, action, plan, state, settings, date: today });
        await _snapshots(trade, 'paper', mk, today);
        await db.savePaperTrade(trade);
        await A.dispatch({ action: { ...action, qty: plan.firstQty }, symbol: item.symbol, mode: 'paper', tradeId: trade.id,
          stage: state.stage, cmp: mk.ltp, settings, params: p, alertsToday: ctx.alertsToday, now });
      }
    }
    await db.saveWatchlistItem({ ...item, status: mode === 'paper' ? 'executed' : 'triggered', triggered_at: new Date(now).toISOString() });
  }

  /** One engine cycle. Returns false when skipped. */
  async function runCycle({ force = false } = {}) {
    if (_running) return false;
    _running = true;
    try {
      const settings = await db.getSettings();
      const p = paramsFrom(settings);
      const now = Date.now();
      if (!force && !inWindow(now, settings, p)) return false;

      const [real, paper, wl] = await Promise.all([db.getOpenTrades(), db.getOpenPaperTrades(), db.getWatchlist()]);
      const watch = (wl || []).filter(w => w.status === 'monitoring');
      if (!real.length && !paper.length && !watch.length) return false;

      const today = I.istDate(now);
      const minute = I.istMinutes(now);
      const market = await root.TLMMarketData.load([...real, ...paper, ...watch].map(x => ({ symbol: x.symbol, exchange: x.exchange })));
      const ctx = {
        settings, p, now, today, minute, market, force,
        rpt: await _defaultRpt(settings),
        alertsToday: await db.getAlerts({ since: new Date(Date.parse(today + 'T00:00:00+05:30')).toISOString() }),
      };

      const tradingMinute = minute >= p.marketOpenMinute && minute <= p.marketCloseMinute;
      for (const item of watch) if (tradingMinute || force) await _safe(() => _handleWatch(item, ctx), item.symbol);
      for (const t of real) await _safe(() => _handleTrade(t, 'real', ctx), t.symbol);
      for (const t of paper) await _safe(() => _handleTrade(t, 'paper', ctx), t.symbol);

      _lastRun = now;
      root.dispatchEvent?.(new CustomEvent('tlm:cycle', { detail: { at: now } }));
      return true;
    } finally {
      _running = false;
    }
  }

  async function _safe(fn, label) {
    try { await fn(); } catch (e) { console.error('TLM cycle error for', label, e); }
  }

  function start() {
    if (_timer) return;
    db.getSettings().then(paramsFrom).catch(() => {});   // warm the params cache for UI previews
    runCycle().catch(e => console.error('TLM cycle', e));
    _timer = setInterval(() => runCycle().catch(e => console.error('TLM cycle', e)), 60 * 1000);
  }

  function stop() { clearInterval(_timer); _timer = null; }

  const api = { start, stop, runCycle, paramsFrom, cachedParams: () => _cachedParams, defaultRpt: _defaultRpt, lastRun: () => _lastRun, isRunning: () => _running };
  root.TLMRunner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
