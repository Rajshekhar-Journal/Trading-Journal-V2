/**
 * alerts.js — Alert Engine v2.2 (Exit Strategy Overhaul)
 */
const alertEngine = (() => {

  const ALERT_TYPES = {
    DAY6_TIME_EXIT:    'Time-Based Stop (Day 6)',
    STOP_BREACH:       'Stop Loss Breach',
    CHECKPOINT_1R:     'Checkpoint: 1R Confirmation',
    EXT_4ATR:          'Extension: 4×ATR (20% Exit)',
    EXT_8ATR:          'Extension: 8×ATR (40% Exit)',
    EXT_12ATR:         'Extension: 12×ATR (70% Exit)',
    RUNNER_MODE:       'Runner Mode (EMA20 Trail)',
    SOFT_BREACH_WARN:  'Warning: EMA20 Soft Breach',
    WEAKNESS_EXIT:     'Weakness: EMA20 Confirmed Exit',
    GTT_TRANCHE_HIT:   'Exit Triggered: Tranche GTT Hit',
    GTT_CORE_HIT:      'Exit Triggered: Core GTT Hit'
  };

  const ALERT_STATUS = { PENDING: 'Pending', TRIGGERED: 'Triggered', COMPLETED: 'Completed', DISMISSED: 'Dismissed' };

  // ── NSE/BSE Tick Size ───────────────────────────────────────────────
  function _getTickSize(price) {
    if (price <= 250)   return 0.05;
    if (price <= 1000)  return 0.10;
    if (price <= 5000)  return 0.50;
    if (price <= 18000) return 1.00;
    return 5.00;
  }

  function _roundTick(price) {
    if (!price || price <= 0) return '0.00';
    const tick = _getTickSize(price);
    return (Math.round(price / tick) * tick).toFixed(tick < 1 ? 2 : 0);
  }

  // ── Technical Indicator Helpers ──────────────────────────────────────
  function calculateEMA(closes, period) {
    if (!closes || closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes[0];
    for (let i = 1; i < closes.length; i++) {
      ema = (closes[i] * k) + (ema * (1 - k));
    }
    return ema;
  }

  function calculateATR(candles, period = 14) {
    if (!candles || candles.length <= period) return null;
    let trs = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low  = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    let sum = 0;
    for (let i = 0; i < period; i++) sum += trs[i];
    let atr = sum / period;
    for (let i = period; i < trs.length; i++) {
      atr = ((atr * (period - 1)) + trs[i]) / period;
    }
    return atr;
  }

  // ── Cumulative Exit % Helper ─────────────────────────────────────────
  // Returns cumulative exit data based on actual partialExits, not alert status
  function _getCumulativeExitData(trade) {
    const PS = [...(trade.entries || []), ...(trade.pyramids || [])]
      .reduce((sum, e) => sum + Number(e.qty || 0), 0);
    const totalExited = (trade.partialExits || [])
      .reduce((sum, e) => sum + Number(e.qty || 0), 0);
    const openQty = PS - totalExited;
    return { PS, totalExited, openQty };
  }

  // Calculate exit qty for a given cumulative tier target
  function _calcTierExitQty(PS, totalExited, openQty, tierCumPct) {
    return Math.min(Math.max(0, Math.floor(PS * tierCumPct) - totalExited), openQty);
  }

  // ── Main Entry Point ────────────────────────────────────────────────
  async function checkAllAlerts(trades, customSettings = null, customOhlcMap = null, isEndOfDay = false, activeWatchlist = []) {
    if (!trades?.length && !activeWatchlist?.length) return false;
    const settings = customSettings || await db.getSettings();
    const alertConfig = settings?.alerts || {};
    const ohlcMap = customOhlcMap || {};
    const updated = [];
    const calc = window.calc || {};

    // ── 1. Monitor Watchlist ──────────────────────────────────────────
    if (activeWatchlist && activeWatchlist.length > 0) {
      await _monitorWatchlist(activeWatchlist, ohlcMap, settings);
    }

    for (const trade of trades) {
      // ── Legacy v2.0 Alert Cleanup ──
      const validTypes = Object.values(ALERT_TYPES);
      const originalLen = (trade.alerts || []).length;
      const alerts = (trade.alerts || []).filter(a => validTypes.includes(a.type));
      let m = { openQty: 0, avgEntryPrice: 0, currentStop: trade.initialStop };
      if (calc.getTradeMetrics) {
        m = calc.getTradeMetrics(trade);
      } else {
        // Fallback for background engine where window.calc is missing
        const _allIns = [...(trade.entries || []), ...(trade.pyramids || [])];
        let totalQty = 0, totalCost = 0;
        for (const e of _allIns) { totalQty += e.qty; totalCost += (e.price * e.qty); }
        m.avgEntryPrice = totalQty > 0 ? totalCost / totalQty : 0;
        const _allOuts = (trade.partialExits || []).reduce((s, e) => s + e.qty, 0);
        m.openQty = totalQty - _allOuts;
        const lastStopRev = (trade.stopRevisions || []).slice(-1)[0];
        m.currentStop = lastStopRev ? lastStopRev.newStop : trade.initialStop;
      }
      
      const tradeUpdates = {};
      const dirty = { changed: alerts.length !== originalLen };

      // ── Day-6 Time-Based Stop ──────────────────────────────────
      if (alertConfig.day5Exit?.enabled !== false) {
        const todayStr = new Date().toISOString().split('T')[0];
        const entryDate = trade.entries?.[0]?.date || todayStr;
        const holidays = settings.marketHolidays || '';
        let tradingDays = 0;
        if (calc.getTradingDays) {
          tradingDays = calc.getTradingDays(entryDate, todayStr, holidays);
        }

        // Suppress if ANY exit has occurred (discretionary, stop, or extension-triggered)
        const completedTypes = [ALERT_TYPES.CHECKPOINT_1R, ALERT_TYPES.EXT_4ATR, ALERT_TYPES.EXT_8ATR, ALERT_TYPES.EXT_12ATR, ALERT_TYPES.STOP_BREACH];
        const hasPriorExit = (trade.partialExits?.length > 0) || (trade.finalExit != null)
          || alerts.some(a => completedTypes.includes(a.type) && a.status === 'Completed');

        if (tradingDays >= 6 && !hasPriorExit) {
          const { openQty } = _getCumulativeExitData(trade);
          const exitQty = Math.ceil(openQty / 2);
          _upsertAlert(alerts, ALERT_TYPES.DAY6_TIME_EXIT,
            `Time-based stop: No exit triggered in ${tradingDays} trading days. Exit ${exitQty} Qty (50% of ${openQty} open) at market to reduce exposure.`,
            null, dirty, isEndOfDay);
        }
      }

      // ── Dynamic Alerts (Long Only) ────────────────────
      let activeDynamicAlert  = null;
      let dynamicAlertMessage = '';
      let dynamicGttPrices    = null;

      if (trade.direction === 'Long' && ohlcMap[trade.symbol]) {
        const candles = ohlcMap[trade.symbol];
        if (candles.length >= 20) {
          const closes   = candles.map(c => c.close);
          const ema20    = calculateEMA(closes, 20);
          const liveATR  = calculateATR(candles, 14);

          const prevCandle = candles[candles.length - 2];
          const currCandle = candles[candles.length - 1];
          const prevLow    = prevCandle?.low || 0;
          const currLow    = currCandle?.low || 0;
          const dailyMove  = currCandle.close - prevCandle.close;

          const cmp   = trade.cmp || closes[closes.length - 1];
          const entry = m.avgEntryPrice || 0;
          const risk  = Math.abs(entry - (trade.initialStop || 0));

          const { PS, totalExited, openQty } = _getCumulativeExitData(trade);

          const entryATR = trade.entryATR || liveATR;
          const swingLow = trade.swingLow || entry;

          if (risk > 0 && entryATR > 0 && openQty > 0) {
            // Extension Targets
            const target4ATR  = swingLow + (4  * entryATR);
            const target8ATR  = swingLow + (8  * entryATR);
            const target12ATR = swingLow + (12 * entryATR);
            const target1R    = entry + risk;

            const existingDyn = alerts.find(a =>
              [ALERT_TYPES.EXT_4ATR, ALERT_TYPES.EXT_8ATR, ALERT_TYPES.EXT_12ATR, ALERT_TYPES.RUNNER_MODE].includes(a.type));
            const prevHW = existingDyn?.gttHW || { core: 0, tranche: 0 };

            const _buildTrailMsg = (trancheQty, coreQty) => {
              const isStrongDay = liveATR > 0 && dailyMove > 2.5 * liveATR;
              
              const rawTranche = isStrongDay
                ? Math.max(currLow + (dailyMove / 2), prevLow)
                : prevLow;
              
              const rawCore = ema20;
              
              const finalTranche = Math.max(rawTranche, prevHW.tranche || 0);
              const finalCore    = Math.max(rawCore,    prevHW.core    || 0);
              
              const trLabel = isStrongDay
                ? `₹${_roundTick(finalTranche)} (Day Low + ½ move — strong day)`
                : `₹${_roundTick(finalTranche)} (Prev Day Low)`;
              
              return {
                trancheQty, coreQty,
                finalCore, finalTranche, trLabel,
                gtt: { core: parseFloat(_roundTick(finalCore)), tranche: parseFloat(_roundTick(finalTranche)) }
              };
            };

            const highestTierReached = (totalExited > 0 && (trade.alerts || []).some(a => [ALERT_TYPES.EXT_4ATR, ALERT_TYPES.EXT_8ATR, ALERT_TYPES.EXT_12ATR].includes(a.type) && a.status === 'Completed'));

            if (highestTierReached) {
              if (cmp < ema20) {
                const threshold = ema20 * 0.98;
                const lastClose = currCandle.close;
                
                if (trade.softBreachDate) {
                  const todayStr = new Date().toISOString().split('T')[0];
                  if (trade.softBreachDate !== todayStr) {
                    if (currCandle.open < prevCandle.close || cmp < ema20) {
                      activeDynamicAlert = ALERT_TYPES.WEAKNESS_EXIT;
                      dynamicAlertMessage = "EMA20 breach confirmed. Gap down or continued weakness.\nEXIT ALL remaining qty at market.";
                    }
                  }
                }

                if (!activeDynamicAlert) {
                  if (lastClose >= threshold) {
                    activeDynamicAlert = ALERT_TYPES.SOFT_BREACH_WARN;
                    dynamicAlertMessage = "EMA20 undercut but close within 2%. Monitoring next day.\nIf gap down below prev close or stays below EMA20 → EXIT.";
                    tradeUpdates.softBreachDate = new Date().toISOString().split('T')[0];
                  } else {
                    activeDynamicAlert = ALERT_TYPES.WEAKNESS_EXIT;
                    dynamicAlertMessage = "EMA20 breached more than 2%. EXIT ALL remaining qty at market.";
                  }
                }
              }

              if (cmp >= ema20 && trade.softBreachDate) {
                tradeUpdates.softBreachDate = null;
              }
            } else {
              // BEFORE 4×ATR: If cmp < ema20 AND trade was in profit zone (cmp > entry), trigger WEAKNESS_EXIT immediately
              // Trades below entry rely on stop loss, not EMA20 weakness
              if (cmp < ema20 && cmp > entry) {
                activeDynamicAlert = ALERT_TYPES.WEAKNESS_EXIT;
                dynamicAlertMessage = `Trend Broken — EMA20 ₹${_roundTick(ema20)} breached.\nExit remaining: Sell all ${openQty} Qty at market.`;
              }
            }

            if (!activeDynamicAlert) {
              if (totalExited >= Math.floor(PS * 0.70)) {
                activeDynamicAlert = ALERT_TYPES.RUNNER_MODE;
                const runnerCore = Math.max(ema20, prevHW.core || 0);
                dynamicAlertMessage = `Runner Mode active. All extensions completed.\n` +
                  `Remain: ${openQty} Qty trailing with EMA20.\n\n` +
                  `Set Sell GTT (Core): ${openQty} Qty at ₹${_roundTick(runnerCore)} (EMA20)\n` +
                  `When EMA20 breached (confirmed) → exit all remaining.`;
                dynamicGttPrices = { core: parseFloat(_roundTick(runnerCore)), tranche: 0 };
                tradeUpdates.activeGTT = {
                  tranche: { price: 0, qty: 0 },
                  core: { price: parseFloat(_roundTick(runnerCore)), qty: openQty },
                  setDate: new Date().toISOString().split('T')[0]
                };
              }
              else if (cmp >= target12ATR) {
                activeDynamicAlert = ALERT_TYPES.EXT_12ATR;
                const exitQty = _calcTierExitQty(PS, totalExited, openQty, 0.70);
                const remainQty = openQty - exitQty;
                const t12 = _buildTrailMsg(exitQty, remainQty);
                
                let trancheMsg = exitQty > 0 
                  ? `  1. Set Sell GTT (Tranche): ${exitQty} Qty at ${t12.trLabel}\n`
                  : `  1. Tranche exit already fulfilled (${totalExited} exited manually).\n`;
                  
                dynamicAlertMessage = `Extreme Extension (12×ATR) reached.\n` +
                  `CMP ₹${_roundTick(cmp)} ≥ SwingLow ₹${_roundTick(swingLow)} + 12×₹${_roundTick(entryATR)} = ₹${_roundTick(target12ATR)}\n` +
                  `Action:\n` +
                  trancheMsg +
                  `  2. Set Sell GTT (Core): ${remainQty} Qty at ₹${_roundTick(t12.finalCore)} (EMA20 — Runner Mode)`;
                dynamicGttPrices = { core: t12.gtt.core, tranche: exitQty > 0 ? t12.gtt.tranche : 0 };
                tradeUpdates.activeGTT = {
                  tranche: { price: exitQty > 0 ? t12.gtt.tranche : 0, qty: exitQty },
                  core: { price: t12.gtt.core, qty: remainQty },
                  setDate: new Date().toISOString().split('T')[0]
                };
              }
              else if (cmp >= target8ATR) {
                activeDynamicAlert = ALERT_TYPES.EXT_8ATR;
                const exitQty = _calcTierExitQty(PS, totalExited, openQty, 0.40);
                const remainQty = openQty - exitQty;
                const t8 = _buildTrailMsg(exitQty, remainQty);
                
                let trancheMsg = exitQty > 0 
                  ? `  1. Set Sell GTT (Tranche): ${exitQty} Qty at ${t8.trLabel}\n`
                  : `  1. Tranche exit already fulfilled (${totalExited} exited manually).\n`;
                  
                dynamicAlertMessage = `Great Extension (8×ATR) reached.\n` +
                  `CMP ₹${_roundTick(cmp)} ≥ SwingLow ₹${_roundTick(swingLow)} + 8×₹${_roundTick(entryATR)} = ₹${_roundTick(target8ATR)}\n` +
                  `Action:\n` +
                  trancheMsg +
                  `  2. Set Sell GTT (Core): ${remainQty} Qty at ₹${_roundTick(t8.finalCore)} (EMA20 trail)`;
                dynamicGttPrices = { core: t8.gtt.core, tranche: exitQty > 0 ? t8.gtt.tranche : 0 };
                tradeUpdates.activeGTT = {
                  tranche: { price: exitQty > 0 ? t8.gtt.tranche : 0, qty: exitQty },
                  core: { price: t8.gtt.core, qty: remainQty },
                  setDate: new Date().toISOString().split('T')[0]
                };
              }
              else if (cmp >= target4ATR) {
                activeDynamicAlert = ALERT_TYPES.EXT_4ATR;
                const exitQty = _calcTierExitQty(PS, totalExited, openQty, 0.20);
                const remainQty = openQty - exitQty;
                const t4 = _buildTrailMsg(exitQty, remainQty);
                // First extension: core floor at breakeven
                const finalCore4 = Math.max(entry, t4.finalCore);
                
                let trancheMsg = exitQty > 0 
                  ? `  1. Set Sell GTT (Tranche): ${exitQty} Qty at ${t4.trLabel}\n`
                  : `  1. Tranche exit already fulfilled (${totalExited} exited manually).\n`;
                  
                dynamicAlertMessage = `Normal Extension (4×ATR) reached.\n` +
                  `CMP ₹${_roundTick(cmp)} ≥ SwingLow ₹${_roundTick(swingLow)} + 4×₹${_roundTick(entryATR)} = ₹${_roundTick(target4ATR)}\n` +
                  `Action:\n` +
                  trancheMsg +
                  `  2. Set Sell GTT (Core): ${remainQty} Qty at ₹${_roundTick(finalCore4)} [MAX(BE ₹${_roundTick(entry)}, EMA20 ₹${_roundTick(ema20)})]\n` +
                  `  3. Move Stop Loss to Breakeven ₹${_roundTick(entry)}`;
                dynamicGttPrices = { core: parseFloat(_roundTick(finalCore4)), tranche: exitQty > 0 ? t4.gtt.tranche : 0 };
                tradeUpdates.activeGTT = {
                  tranche: { price: exitQty > 0 ? t4.gtt.tranche : 0, qty: exitQty },
                  core: { price: parseFloat(_roundTick(finalCore4)), qty: remainQty },
                  setDate: new Date().toISOString().split('T')[0]
                };
              }
              else if (cmp >= target1R && !(trade.pyramids?.length > 0)) {
                activeDynamicAlert = ALERT_TYPES.CHECKPOINT_1R;
                const suggestedStop = _roundTick((entry + (trade.initialStop || 0)) / 2);
                dynamicAlertMessage = 
                  `1R Checkpoint reached.\n` +
                  `CMP ₹${_roundTick(cmp)} ≥ Entry ₹${_roundTick(entry)} + R ₹${_roundTick(risk)} = ₹${_roundTick(target1R)}\n\n` +
                  `Action Required:\n` +
                  `  1. Add remaining 50% position at ₹${_roundTick(cmp)}\n` +
                  `  2. Tighten stop: ₹${_roundTick(trade.initialStop)} → ₹${suggestedStop} (midpoint)`;
              }
            }
          }
        }
      }

      // ── Intraday GTT Breach Detection (independent — fires alongside dynamic alerts) ─
      if (trade.activeGTT && trade.cmp && trade.direction === 'Long') {
        const gtt = trade.activeGTT;
        const todayStr = new Date().toISOString().split('T')[0];

        // Tranche GTT breach: CMP dropped to Prev Day Low
        if (gtt.tranche?.price > 0 && gtt.tranche.qty > 0 && trade.cmp <= gtt.tranche.price && gtt.trancheBreachedDate !== todayStr) {
          const wasNew = _upsertAlert(alerts, ALERT_TYPES.GTT_TRANCHE_HIT,
            `Tranche GTT Triggered!\nCMP ₹${_roundTick(trade.cmp)} ≤ Sell GTT ₹${_roundTick(gtt.tranche.price)} (Prev Day Low)\nExit: Sell ${gtt.tranche.qty} Qty now — tranche order should have executed on broker.`,
            null, dirty, isEndOfDay);
          if (wasNew) _sendTelegram(settings, trade.symbol, ALERT_TYPES.GTT_TRANCHE_HIT,
            `Tranche GTT Triggered! CMP ₹${_roundTick(trade.cmp)} ≤ GTT ₹${_roundTick(gtt.tranche.price)}. Sell ${gtt.tranche.qty} Qty.`);
          tradeUpdates.activeGTT = { ...(tradeUpdates.activeGTT || trade.activeGTT), trancheBreachedDate: todayStr };
        }

        // Core GTT breach: CMP dropped to EMA20 trail
        if (gtt.core?.price > 0 && gtt.core.qty > 0 && trade.cmp <= gtt.core.price && gtt.coreBreachedDate !== todayStr) {
          const wasNew = _upsertAlert(alerts, ALERT_TYPES.GTT_CORE_HIT,
            `Core GTT Triggered!\nCMP ₹${_roundTick(trade.cmp)} ≤ Sell GTT ₹${_roundTick(gtt.core.price)} (EMA20 trail)\nExit: Sell ${gtt.core.qty} Qty now — core trail order should have executed on broker.`,
            null, dirty, isEndOfDay);
          if (wasNew) _sendTelegram(settings, trade.symbol, ALERT_TYPES.GTT_CORE_HIT,
            `Core GTT Triggered! CMP ₹${_roundTick(trade.cmp)} ≤ GTT ₹${_roundTick(gtt.core.price)}. Sell ${gtt.core.qty} Qty.`);
          tradeUpdates.activeGTT = { ...(tradeUpdates.activeGTT || trade.activeGTT), coreBreachedDate: todayStr };
        }
      }

      // ── Stop Loss Breach (Priority 1 — overrides all) ─────────
      const currentStop = m.currentStop || trade.initialStop;
      const isStopBreached = alertConfig.stopLossBreach?.enabled !== false && trade.cmp && currentStop &&
        (trade.direction === 'Long' ? trade.cmp <= currentStop : trade.cmp >= currentStop);

      if (isStopBreached) {
        const { openQty } = _getCumulativeExitData(trade);
        const wasNew = _upsertAlert(alerts, ALERT_TYPES.STOP_BREACH,
          `CMP breached stop loss of ₹${_roundTick(currentStop)}. EXIT all ${openQty} Qty immediately.`,
          null, dirty, isEndOfDay);
        if (wasNew) _sendTelegram(settings, trade.symbol, ALERT_TYPES.STOP_BREACH,
          `CMP breached stop loss of ₹${_roundTick(currentStop)}. EXIT all ${openQty} Qty immediately.`);
        activeDynamicAlert = null; // suppress all dynamic alerts
      } else {
        const stopIdx = alerts.findIndex(a => a.type === ALERT_TYPES.STOP_BREACH);
        if (stopIdx !== -1) { alerts.splice(stopIdx, 1); dirty.changed = true; }
      }

      // ── Enforce mutual exclusivity for dynamic alerts ──────────────────
      const dynamicTypes = [
        ALERT_TYPES.CHECKPOINT_1R, ALERT_TYPES.EXT_4ATR, ALERT_TYPES.EXT_8ATR,
        ALERT_TYPES.EXT_12ATR, ALERT_TYPES.RUNNER_MODE,
        ALERT_TYPES.SOFT_BREACH_WARN, ALERT_TYPES.WEAKNESS_EXIT
      ];
      dynamicTypes.forEach(t => {
        if (t !== activeDynamicAlert) {
          const idx = alerts.findIndex(a => a.type === t && a.status !== 'Completed');
          if (idx !== -1) { alerts.splice(idx, 1); dirty.changed = true; }
        }
      });

      if (activeDynamicAlert) {
        const wasNew = _upsertAlert(alerts, activeDynamicAlert, dynamicAlertMessage, dynamicGttPrices, dirty, isEndOfDay);
        if (wasNew) _sendTelegram(settings, trade.symbol, activeDynamicAlert, dynamicAlertMessage);
      }

      let needsSave = dirty.changed;
      if (Object.keys(tradeUpdates).length > 0) {
        for (const k of Object.keys(tradeUpdates)) {
          if (trade[k] !== tradeUpdates[k]) {
            trade[k] = tradeUpdates[k];
            needsSave = true;
          }
        }
      }

      if (needsSave) {
        const updated_trade = { ...trade, alerts };
        updated.push(updated_trade);
        if (window.db && db.saveTrade) {
            await db.saveTrade(updated_trade);
        }
      }
    }
    // ── 3. Simulate Paper Trades (same exit rules applied automatically) ──
    await _simulatePaperTrades(ohlcMap, settings);

    return updated;
  }

  // ── Paper Trade Simulation (runs after main loop) ──────────────────
  async function _simulatePaperTrades(ohlcMap, settings) {
    if (!window.db || !db.getOpenPaperTrades) return;
    const paperTrades = await db.getOpenPaperTrades();
    if (!paperTrades || !paperTrades.length) return;

    const today = new Date().toISOString().split('T')[0];
    const calc  = window.calc || {};

    for (const trade of paperTrades) {
      const candles = ohlcMap[trade.symbol] || ohlcMap[trade.symbol + '.NS'];
      if (!candles || candles.length < 2) continue;

      let m;
      if (calc.getTradeMetrics) {
        m = calc.getTradeMetrics(trade);
      } else {
        const ins = [...(trade.entries || []), ...(trade.pyramids || [])];
        let tq = 0, tc = 0;
        for (const e of ins) { tq += e.qty; tc += (e.price * e.qty); }
        const outs = (trade.partialExits || []).reduce((s,e) => s + e.qty, 0);
        m = { openQty: tq - outs, avgEntryPrice: tq > 0 ? tc/tq : 0, currentStop: trade.currentStop || trade.initialStop };
      }

      if (m.openQty <= 0) continue;

      const entryPrice   = m.avgEntryPrice;
      const riskPerShare = Math.abs(entryPrice - trade.initialStop);
      const updated      = { ...trade };
      let changed        = false;

      // Check each new candle chronologically
      for (const candle of candles) {
        const { high, low, close, time } = candle;
        const candleDate = time ? new Date(time * 1000).toISOString().split('T')[0] : today;

        // a) Stop Loss hit
        if (low <= m.currentStop && updated.finalExit === null) {
          updated.finalExit = { id: db.generateId('pe'), date: candleDate, price: m.currentStop, qty: m.openQty, charges: 0, actionSource: 'Stop Loss Breached (Paper)' };
          changed = true; break;
        }

        // b) 1R Partial Exit (50% at +1R)
        const target1R = trade.direction === 'Short' ? entryPrice - riskPerShare : entryPrice + riskPerShare;
        const already1R = (updated.partialExits || []).some(e => e.actionSource && e.actionSource.includes('1R'));
        if (!already1R && (trade.direction === 'Short' ? low <= target1R : high >= target1R)) {
          const exitQty = Math.floor(m.openQty / 2);
          if (exitQty > 0) {
            updated.partialExits = [...(updated.partialExits || []), { id: db.generateId('pe'), date: candleDate, price: target1R, qty: exitQty, charges: 0, actionSource: '1R Partial Exit (Paper)' }];
            // Trail stop to breakeven after 1R
            updated.currentStop = entryPrice;
            updated.stopRevisions = [...(updated.stopRevisions || []), { id: db.generateId('sr'), date: candleDate, oldStop: m.currentStop, newStop: entryPrice, actionSource: '1R Breakeven Trail (Paper)', notes: '' }];
            changed = true;
          }
        }

        // c) ATR-based extension exits (4×, 8×, 12×)
        if (trade.entryATR && trade.swingLow) {
          const atr = trade.entryATR;
          const ext4  = trade.direction === 'Short' ? trade.swingLow - 4*atr : trade.swingLow + 4*atr;
          const ext8  = trade.direction === 'Short' ? trade.swingLow - 8*atr : trade.swingLow + 8*atr;
          const ext12 = trade.direction === 'Short' ? trade.swingLow - 12*atr : trade.swingLow + 12*atr;
          const remaining = m.openQty - (updated.partialExits || []).reduce((s,e) => s+e.qty, 0);

          [[ext4,'4×ATR Extension Exit (Paper)',0.5],[ext8,'8×ATR Extension Exit (Paper)',0.5],[ext12,'12×ATR Extension Exit (Paper)',1.0]].forEach(([target, src, fraction]) => {
            const alreadyDone = (updated.partialExits || []).some(e => e.actionSource && e.actionSource.includes(src.split(' ')[0]));
            if (!alreadyDone && remaining > 0) {
              const hit = trade.direction === 'Short' ? low <= target : high >= target;
              if (hit) {
                const qty = fraction >= 1 ? remaining : Math.floor(remaining * fraction);
                if (qty > 0) {
                  updated.partialExits = [...(updated.partialExits || []), { id: db.generateId('pe'), date: candleDate, price: target, qty, charges: 0, actionSource: src }];
                  changed = true;
                }
              }
            }
          });
        }
      }

      // d) Day-6 Time Stop
      const entryDate   = new Date(trade.entries?.[0]?.date || today);
      const holdingDays = Math.floor((new Date() - entryDate) / (1000*60*60*24));
      if (holdingDays >= 6 && updated.finalExit === null) {
        const lastClose = candles[candles.length-1]?.close || entryPrice;
        updated.finalExit = { id: db.generateId('pe'), date: today, price: lastClose, qty: m.openQty, charges: 0, actionSource: 'Day-6 Time Stop (Paper)' };
        changed = true;
      }

      if (changed) {
        try { await db.savePaperTrade(updated); } catch(e) { console.warn('Paper trade sim save failed:', e); }
      }
    }
  }

  // ── Watchlist Monitor ───────────────────────────────────────────────
  async function _monitorWatchlist(activeWatchlist, ohlcMap, settings) {
    for (const item of activeWatchlist) {
      const candles = ohlcMap[item.symbol];
      if (!candles || candles.length === 0) continue;
      
      const lastCandle = candles[candles.length - 1];
      const cmp = lastCandle.close; // Assuming live CMP is pushed to last candle close
      const trigger = Number(item.trigger_price) || 0;

      if (cmp >= trigger) {
        const message = `WATCHLIST TRIGGERED: ${item.symbol}\nCMP: ₹${cmp} >= Trigger: ₹${trigger}\nAction: Open App to Execute or Paper Trade`;
        
        // Update DB
        item.status = 'triggered';
        await db.saveWatchlistItem(item);

        // Telegram
        if (settings.telegramBotToken && settings.telegramChatId) {
           await _sendTelegram(settings, item.symbol, "WATCHLIST TRIGGER", message);
        }
      }
    }
  }

  // ── Upsert Alert (create or update) ──────────────────────────────────
  function _upsertAlert(alerts, type, message, gttPrices, dirty, isEndOfDay) {
    const existing = alerts.find(a => a.type === type);
    const today = new Date().toISOString().split('T')[0];

    // Rule 1: New Alert / New Phase - Fire immediately
    if (!existing) {
      const alertObj = {
        type,
        status: ALERT_STATUS.TRIGGERED,
        message,
        triggeredAt: new Date().toISOString(),
        lastNotifiedDate: today,
        lastEodDate: isEndOfDay ? today : null
      };
      if (gttPrices) alertObj.gttHW = { core: gttPrices.core || 0, tranche: gttPrices.tranche || 0 };
      alerts.push(alertObj);
      dirty.changed = true;
      return true;
    } 
    
    // Evaluate Notification Rules for Existing Alerts
    let shouldNotify = false;

    // Rule 2: First Sync of the Day
    if (existing.lastNotifiedDate !== today) {
      shouldNotify = true;
    }

    // Rule 3: Meaningful GTT Increase (>= 1%) from last notified HWM
    let newCore = 0, newTranche = 0;
    if (gttPrices) {
      const oldHW = existing.gttHW || { core: 0, tranche: 0 };
      newCore = Math.max(gttPrices.core || 0, oldHW.core || 0);
      newTranche = Math.max(gttPrices.tranche || 0, oldHW.tranche || 0);
      
      const coreIncreased = newCore >= (oldHW.core * 1.01);
      const trancheIncreased = newTranche >= (oldHW.tranche * 1.01);

      if (coreIncreased || trancheIncreased) {
        shouldNotify = true;
      }
    }

    // End of day final fetch rule
    if (isEndOfDay && existing.lastEodDate !== today) {
      shouldNotify = true;
      existing.lastEodDate = today;
    }

    // Always fire if the status is still pending (e.g. user reset it or it missed firing)
    if (existing.status === ALERT_STATUS.PENDING) {
      shouldNotify = true;
    }

    // UI Synchronization: We ONLY update the message string and HWM in the UI 
    // when Telegram is actually going to fire. This keeps them 100% synced.
    if (shouldNotify) {
      if (existing.message !== message) {
        existing.message = message;
      }
      if (gttPrices) {
        existing.gttHW = { core: newCore, tranche: newTranche };
      }
      
      existing.status = ALERT_STATUS.TRIGGERED;
      existing.triggeredAt = new Date().toISOString();
      existing.lastNotifiedDate = today;
      dirty.changed = true;
      return true;
    }

    return false;
  }

  // ── Telegram Notification ───────────────────────────────────────────
  async function _sendTelegram(settings, symbol, phase, instruction) {
    if (!settings.telegramBotToken || !settings.telegramChatId) return;
    try {
      const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
      const text = `🚨 *EXIT ALERT* 🚨\n\n*Symbol:* ${symbol}\n*Phase:* ${phase}\n\n*Action Required:*\n${instruction}`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: settings.telegramChatId,
          text: text,
          parse_mode: 'Markdown'
        })
      });
    } catch (e) {
      console.error('Failed to send Telegram alert', e);
    }
  }

  // ── Query Helpers ────────────────────────────────────────────────────
  function getActiveAlerts(trades) {
    const all = [];
    trades.forEach(trade => {
      (trade.alerts || []).forEach(alert => {
        if (alert.status === ALERT_STATUS.TRIGGERED) {
          all.push({ ...alert, tradeId: trade.id, symbol: trade.symbol, entryDate: trade.entries?.[0]?.date });
        }
      });
    });
    return all;
  }

  async function dismissAlert(tradeId, alertType) {
    if (typeof db === 'undefined') return;
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const alerts = (trade.alerts || []).map(a =>
      a.type === alertType ? { ...a, status: ALERT_STATUS.DISMISSED } : a
    );
    await db.saveTrade({ ...trade, alerts });
  }

  async function completeAlert(tradeId, alertType) {
    if (typeof db === 'undefined') return;
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const alerts = (trade.alerts || []).map(a =>
      a.type === alertType ? { ...a, status: ALERT_STATUS.COMPLETED, completedAt: new Date().toISOString() } : a
    );
    await db.saveTrade({ ...trade, alerts });
  }

  return {
    ALERT_TYPES, ALERT_STATUS,
    checkAllAlerts, getActiveAlerts, dismissAlert, completeAlert,
    calculateATR, calculateEMA
  };
})();
