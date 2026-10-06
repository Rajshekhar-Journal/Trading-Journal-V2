/**
 * engine/runner.js — one Trade Lifecycle engine cycle; the same file runs in two hosts.
 *
 * Server (primary): the `tlm-runner` Edge Function calls runCycle() every minute from pg_cron,
 *   with its own `db` (service role, one user at a time), market-data source and Telegram notifier.
 * Browser (viewer + fallback): start() checks the server heartbeat each minute. While the server
 *   runner is alive the browser only displays; a manual sync asks the server to run now. If the
 *   heartbeat is older than 3 minutes the browser runs the cycle itself (dashboard alerts only).
 * Browser and server share one lock (runner_status), so a cycle never runs twice at once.
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
  const isServer = () => root.TLM_HOST === 'server';
  const SERVER_FRESH_MS = 3 * 60 * 1000;
  let _host = isServer() ? 'server' : 'browser';   // who ran the latest cycle, as far as this page knows
  let _serverStatus = null;

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

  /**
   * Save or finalise trade charts for the Chartbook (engine/chartbook.js): entry, 1R add and exit charts,
   * real and paper trades. Normal runs cover open trades and trades closed in the last 10 days;
   * `backfill` covers every trade (Chartbook → Build missing charts). At most `limit` charts per call.
   * @returns { saved, failed, remaining } — remaining = charts still to take
   */
  async function captureCharts({ backfill = false, limit = 10, now = Date.now(), settings } = {}) {
    const C = root.TLMChartbook, MD = root.TLMMarketData;
    const empty = { saved: 0, failed: 0, remaining: 0 };
    if (!C || !db.getSnapshotIndex) return empty;
    const rows = await db.getSnapshotIndex();
    if (!rows) return empty;                                   // migration 007 not applied yet
    settings = settings || await db.getSettings();
    const p = paramsFrom(settings);
    const today = I.istDate(now);
    const afterClose = I.istMinutes(now) >= p.marketCloseMinute + 3;
    const [real, paper] = await Promise.all([db.getTrades(), db.getPaperTrades()]);
    const index = C.indexOf(rows);
    const recent = C.addDays(today, -10);

    const work = [];
    for (const [mode, list] of [['real', real], ['paper', paper]]) {
      for (const t of list || []) {
        if (!(t.entries || []).length) continue;
        const x = C.exitDate(t);
        if (!backfill && x && x < recent) continue;
        for (const ev of C.pending(t, index, { today, afterClose, provisional: !backfill })) work.push({ t, mode, ev });
      }
    }
    const batch = work.slice(0, limit);

    // One history fetch per symbol (from the earliest date any chart needs), one 1-min fetch per symbol/day.
    const from = {};
    for (const { t, ev } of batch) {
      const f = C.historyFrom(t, ev);
      if (!from[t.symbol] || f < from[t.symbol].from) from[t.symbol] = { from: f, exchange: t.exchange };
    }
    const hist = {}, intra = {};
    let saved = 0, failed = 0;
    for (const { t, mode, ev } of batch) {
      try {
        if (!hist[t.symbol]) hist[t.symbol] = await MD.history(t.symbol, t.exchange, from[t.symbol].from);
        const k = t.symbol + '|' + ev.date;
        if (!(k in intra)) intra[k] = await MD.intradayOn(t.symbol, t.exchange, ev.date).catch(() => []);
        let result = null;
        if (ev.kind === C.KINDS.EXIT && typeof calc !== 'undefined') {
          const m = calc.getTradeMetrics(t);
          result = { r: m.profitR, pnl: m.realizedPnl, holdingDays: m.holdingDays };
        }
        const snap = C.build({ trade: t, mode, ev, daily: hist[t.symbol], intraday: intra[k], final: ev.final, now, result });
        if (!snap.daily.length) throw new Error('no daily candles');
        await db.saveChartSnapshot(snap);
        saved++;
      } catch (e) {
        failed++;
        _errors.push({ symbol: t.symbol, error: 'chart: ' + String(e?.message || e) });
      }
    }
    return { saved, failed, remaining: work.length - batch.length };
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
        await db.savePaperTrade(trade);
        await A.dispatch({ action: { ...action, qty: plan.firstQty }, symbol: item.symbol, mode: 'paper', tradeId: trade.id,
          stage: state.stage, cmp: mk.ltp, settings, params: p, alertsToday: ctx.alertsToday, now });
      }
    }
    await db.saveWatchlistItem({ ...item, status: mode === 'paper' ? 'executed' : 'triggered', triggered_at: new Date(now).toISOString() });
  }

  /** Browser: is the backend runner alive (heartbeat within 3 minutes)? */
  async function serverActive() {
    if (isServer() || !db.getRunnerStatus) return false;
    _serverStatus = await db.getRunnerStatus().catch(() => null);
    const at = Date.parse(_serverStatus?.last_finished_at || '');
    return Number.isFinite(at) && Date.now() - at < SERVER_FRESH_MS;
  }

  /** Browser: ask the backend runner to run a cycle for this user now. */
  async function _runOnServer() {
    const r = await fetch(`${APP_CONFIG.SUPABASE_URL}/functions/v1/tlm-runner`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run' }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `server runner ${r.status}`);
    _lastRun = Date.now();
    root.dispatchEvent?.(new CustomEvent('tlm:cycle', { detail: { at: _lastRun, host: 'server' } }));
    return out.ran !== false;
  }

  /**
   * One engine cycle. Returns false when skipped.
   * In the browser: hands over to the server when it is alive (force → run there now), else runs locally.
   */
  async function runCycle({ force = false } = {}) {
    if (!isServer() && await serverActive()) {
      _host = 'server';
      root.dispatchEvent?.(new CustomEvent('tlm:host', { detail: { host: 'server', status: _serverStatus } }));
      return force ? _runOnServer() : false;
    }
    if (!isServer()) {
      _host = 'browser';
      root.dispatchEvent?.(new CustomEvent('tlm:host', { detail: { host: 'browser', status: _serverStatus } }));
    }
    return _localCycle({ force });
  }

  async function _localCycle({ force }) {
    if (_running) return false;
    _running = true;
    // \`auth\` is a script-level const in the browser (not a window property); the lock must name this user.
    const uid = typeof auth !== 'undefined' ? auth.getUser?.()?.id : root.auth?.getUser?.()?.id;
    const holder = isServer() ? null : 'browser:' + (uid || 'anon');
    let locked = false;
    try {
      if (holder) {                                   // the server runner takes its lock in the Edge Function
        locked = await db.tryRunnerLock(holder, 90);
        if (!locked) return false;                    // the server is running a cycle right now
      }
      _errors = [];
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

      if (!isServer()) await captureCharts({ limit: 5, now, settings }).catch(() => {});   // the server does this every minute itself
      _lastRun = now;
      root.dispatchEvent?.(new CustomEvent('tlm:cycle', { detail: { at: now, host: isServer() ? 'server' : 'browser' } }));
      return true;
    } finally {
      _running = false;
      if (locked) await db.releaseRunnerLock(holder).catch(() => {});
    }
  }

  let _errors = [];   // per-symbol failures of the latest cycle (reported by the server runner)
  async function _safe(fn, label) {
    try { await fn(); } catch (e) { console.error('TLM cycle error for', label, e); _errors.push({ symbol: label, error: String(e?.message || e) }); }
  }

  function start() {
    if (_timer) return;
    db.getSettings().then(paramsFrom).catch(() => {});   // warm the params cache for UI previews
    runCycle().catch(e => console.error('TLM cycle', e));
    _timer = setInterval(() => runCycle().catch(e => console.error('TLM cycle', e)), 60 * 1000);
  }

  function stop() { clearInterval(_timer); _timer = null; }

  const api = { start, stop, runCycle, captureCharts, paramsFrom, cachedParams: () => _cachedParams, defaultRpt: _defaultRpt,
    lastRun: () => _lastRun, isRunning: () => _running, lastErrors: () => _errors, host: () => _host, serverStatus: () => _serverStatus, serverActive };
  root.TLMRunner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
