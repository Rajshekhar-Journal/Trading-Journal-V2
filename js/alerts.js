/**
 * alerts.js — Alert Engine v2.3 (Smart Alert Throttling)
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

  // ════════════════════════════════════════════════════════════════════════
  // Smart Alert Throttle State (in-memory, resets on page load)
  // ════════════════════════════════════════════════════════════════════════
  const _alertState = {
    lastDailyBriefingDate:  null,   // 'YYYY-MM-DD' — morning briefing already done today?
    lastAlertedGTT:         {},     // { tradeId: { tranche: price, core: price, dynamic: price } }
    lastAlertedDynamicType: {},     // { tradeId: alertType } — last dynamic type sent to Telegram
    triggeredWatchlist:     new Set() // item IDs already Telegram-alerted today
  };

  // Is today a weekday (Mon–Fri)?
  function _isWeekday() {
    return new Date().getDay() >= 1 && new Date().getDay() <= 5;
  }

  // Has 8:45 AM IST passed and morning briefing not yet sent today?
  function _isMorningBriefing() {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    if (_alertState.lastDailyBriefingDate === todayStr) return false; // already done
    // IST = UTC + 5h30m = UTC + 330 min
    const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const istMin = (utcMin + 330) % 1440;
    return istMin >= 525; // 8*60+45 = 525 min = 8:45 AM IST
  }

  // Has the GTT price at a given level changed by >1% since last Telegram?
  function _gttChangedSignificantly(tradeId, level, newPrice) {
    const last = _alertState.lastAlertedGTT[tradeId]?.[level];
    if (last == null || last === 0) return true; // never alerted
    return Math.abs(newPrice - last) / last > 0.01;
  }

  // Record the GTT price that was just alerted
  function _recordGTT(tradeId, level, price) {
    if (!_alertState.lastAlertedGTT[tradeId]) _alertState.lastAlertedGTT[tradeId] = {};
    _alertState.lastAlertedGTT[tradeId][level] = price;
  }

  // Has the dynamic alert type changed, OR has the dynamic GTT price changed >1%?
  function _dynamicAlertChanged(tradeId, newType, newGttPrices) {
    const lastType = _alertState.lastAlertedDynamicType[tradeId];
    if (lastType !== newType) return true; // type changed
    // Same type — check if GTT prices shifted >1%
    if (newGttPrices) {
      if (newGttPrices.core   > 0 && _gttChangedSignificantly(tradeId, 'dynamicCore',    newGttPrices.core))   return true;
      if (newGttPrices.tranche > 0 && _gttChangedSignificantly(tradeId, 'dynamicTranche', newGttPrices.tranche)) return true;
    }
    return false;
  }

  // Send the morning GTT briefing for all open trades
  async function _sendMorningBriefing(trades, settings) {
    if (!_isWeekday()) return;
    const todayStr = new Date().toISOString().split('T')[0];
    for (const trade of trades) {
      if (!trade.activeGTT) continue;
      const gtt = trade.activeGTT;
      const lines = [];
      if (gtt.tranche?.price > 0)
        lines.push(`• Tranche GTT: ₹${gtt.tranche.price} × ${gtt.tranche.qty} Qty`);
      if (gtt.core?.price > 0)
        lines.push(`• Core GTT:    ₹${gtt.core.price} × ${gtt.core.qty} Qty`);
      if (!lines.length) continue;
      const msg = `Morning GTT Levels — ${todayStr}\n${lines.join('\n')}\nVerify these are set in your broker app.`;
      await _sendTelegram(settings, trade.symbol, 'MORNING GTT BRIEFING', msg);
      // Record these as "last alerted" so intraday won't re-fire unless >1% change
      if (gtt.tranche?.price > 0) _recordGTT(trade.id, 'tranche', gtt.tranche.price);
      if (gtt.core?.price    > 0) _recordGTT(trade.id, 'core',    gtt.core.price);
    }
    _alertState.lastDailyBriefingDate = todayStr;
  }

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
  function _getCumulativeExitData(trade) {
    const PS = [...(trade.entries || []), ...(trade.pyramids || [])]
      .reduce((sum, e) => sum + Number(e.qty || 0), 0);
    const totalExited = (trade.partialExits || [])
      .reduce((sum, e) => sum + Number(e.qty || 0), 0);
    const openQty = PS - totalExited;
    return { PS, totalExited, openQty };
  }

  function _calcTierExitQty(PS, totalExited, openQty, tierCumPct) {
    return Math.min(Math.max(0, Math.floor(PS * tierCumPct) - totalExited), openQty);
  }

  // ── Main Entry Point ────────────────────────────────────────────────
  async function checkAllAlerts(trades, customSettings = null, customOhlcMap = null, isEndOfDay = false, activeWatchlist = []) {
    const openPaperCount = (window.db && db.getOpenPaperTrades) ? (await db.getOpenPaperTrades()).length : 0;
    if (!trades?.length && !activeWatchlist?.length && openPaperCount === 0) return false;
    
    const _canTelegram = _isWeekday();
    const settings = customSettings || await db.getSettings();
    const alertConfig = settings?.alerts || {};
    const ohlcMap = customOhlcMap || {};
    const updated = [];
    const calc = window.calc || {};

    if (_canTelegram && _isMorningBriefing() && trades?.length) {
      await _sendMorningBriefing(trades, settings);
    }

    if (activeWatchlist && activeWatchlist.length > 0) {
      await _monitorWatchlist(activeWatchlist, ohlcMap, settings, _canTelegram);
    }

    for (const trade of trades) {
      const validTypes = Object.values(ALERT_TYPES);
      const originalLen = (trade.alerts || []).length;
      const alerts = (trade.alerts || []).filter(a => validTypes.includes(a.type));
      let m = { openQty: 0, avgEntryPrice: 0, currentStop: trade.initialStop };
      if (calc.getTradeMetrics) {
        m = calc.getTradeMetrics(trade);
      } else {
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

      if (alertConfig.day5Exit?.enabled !== false) {
        const todayStr = new Date().toISOString().split('T')[0];
        const entryDate = trade.entries?.[0]?.date || todayStr;
        const holidays = settings.marketHolidays || '';
        let tradingDays = 0;
        if (calc.getTradingDays) {
          tradingDays = calc.getTradingDays(entryDate, todayStr, holidays);
        }
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
            const target4ATR  = swingLow + (4  * entryATR);
            const target8ATR  = swingLow + (8  * entryATR);
            const target12ATR = swingLow + (12 * entryATR);
            const target1R    = entry + risk;
            const existingDyn = alerts.find(a => [ALERT_TYPES.EXT_4ATR, ALERT_TYPES.EXT_8ATR, ALERT_TYPES.EXT_12ATR, ALERT_TYPES.RUNNER_MODE].includes(a.type));
            const prevHW = existingDyn?.gttHW || { core: 0, tranche: 0 };
            const _buildTrailMsg = (trancheQty, coreQty) => {
              const isStrongDay = liveATR > 0 && dailyMove > 2.5 * liveATR;
              const rawTranche = isStrongDay ? Math.max(currLow + (dailyMove / 2), prevLow) : prevLow;
              const rawCore = ema20;
              const finalTranche = Math.max(rawTranche, prevHW.tranche || 0);
              const finalCore    = Math.max(rawCore,    prevHW.core    || 0);
              const trLabel = isStrongDay ? `₹${_roundTick(finalTranche)} (Day Low + ½ move — strong day)` : `₹${_roundTick(finalTranche)} (Prev Day Low)`;
              return { trancheQty, coreQty, finalCore, finalTranche, trLabel, gtt: { core: parseFloat(_roundTick(finalCore)), tranche: parseFloat(_roundTick(finalTranche)) } };
            };

            const highestTierReached = (totalExited > 0 && (trade.alerts || []).some(a => [ALERT_TYPES.EXT_4ATR, ALERT_TYPES.EXT_8ATR, ALERT_TYPES.EXT_12ATR].includes(a.type) && a.status === 'Completed'));
            if (highestTierReached) {
              if (cmp < ema20) {
                const threshold = ema20 * 0.98;
                if (trade.softBreachDate) {
                  const todayStr = new Date().toISOString().split('T')[0];
                  if (trade.softBreachDate !== todayStr && (currCandle.open < prevCandle.close || cmp < ema20)) {
                    activeDynamicAlert = ALERT_TYPES.WEAKNESS_EXIT;
                    dynamicAlertMessage = "EMA20 breach confirmed. Gap down or continued weakness.\nEXIT ALL remaining qty at market.";
                  }
                }
                if (!activeDynamicAlert) {
                  if (currCandle.close >= threshold) {
                    activeDynamicAlert = ALERT_TYPES.SOFT_BREACH_WARN;
                    dynamicAlertMessage = "EMA20 undercut but close within 2%. Monitoring next day.\nIf gap down below prev close or stays below EMA20 → EXIT.";
                    tradeUpdates.softBreachDate = new Date().toISOString().split('T')[0];
                  } else {
                    activeDynamicAlert = ALERT_TYPES.WEAKNESS_EXIT;
                    dynamicAlertMessage = "EMA20 breached more than 2%. EXIT ALL remaining qty at market.";
                  }
                }
              }
              if (cmp >= ema20 && trade.softBreachDate) tradeUpdates.softBreachDate = null;
            } else if (cmp < ema20 && cmp > entry) {
              activeDynamicAlert = ALERT_TYPES.WEAKNESS_EXIT;
              dynamicAlertMessage = `Trend Broken — EMA20 ₹${_roundTick(ema20)} breached.\nExit remaining: Sell all ${openQty} Qty at market.`;
            }

            if (!activeDynamicAlert) {
              if (totalExited >= Math.floor(PS * 0.70)) {
                activeDynamicAlert = ALERT_TYPES.RUNNER_MODE;
                const runnerCore = Math.max(ema20, prevHW.core || 0);
                dynamicAlertMessage = `Runner Mode active. All extensions completed.\nRemain: ${openQty} Qty trailing with EMA20.\n\nSet Sell GTT (Core): ${openQty} Qty at ₹${_roundTick(runnerCore)} (EMA20)`;
                dynamicGttPrices = { core: parseFloat(_roundTick(runnerCore)), tranche: 0 };
                tradeUpdates.activeGTT = { tranche: { price: 0, qty: 0 }, core: { price: parseFloat(_roundTick(runnerCore)), qty: openQty }, setDate: new Date().toISOString().split('T')[0] };
              } else if (cmp >= target12ATR) {
                activeDynamicAlert = ALERT_TYPES.EXT_12ATR;
                const exitQty = _calcTierExitQty(PS, totalExited, openQty, 0.70);
                const remainQty = openQty - exitQty;
                const t12 = _buildTrailMsg(exitQty, remainQty);
                dynamicAlertMessage = `Extreme Extension (12×ATR) reached.\nCMP ₹${_roundTick(cmp)} ≥ 12×ATR = ₹${_roundTick(target12ATR)}\nAction:\n${exitQty > 0 ? `  1. Set Sell GTT (Tranche): ${exitQty} Qty at ${t12.trLabel}\n` : `  1. Tranche exit fulfilled.\n`}  2. Set Sell GTT (Core): ${remainQty} Qty at ₹${_roundTick(t12.finalCore)} (EMA20)`;
                dynamicGttPrices = { core: t12.gtt.core, tranche: exitQty > 0 ? t12.gtt.tranche : 0 };
                tradeUpdates.activeGTT = { tranche: { price: exitQty > 0 ? t12.gtt.tranche : 0, qty: exitQty }, core: { price: t12.gtt.core, qty: remainQty }, setDate: new Date().toISOString().split('T')[0] };
              } else if (cmp >= target8ATR) {
                activeDynamicAlert = ALERT_TYPES.EXT_8ATR;
                const exitQty = _calcTierExitQty(PS, totalExited, openQty, 0.40);
                const remainQty = openQty - exitQty;
                const t8 = _buildTrailMsg(exitQty, remainQty);
                dynamicAlertMessage = `Great Extension (8×ATR) reached.\nCMP ₹${_roundTick(cmp)} ≥ 8×ATR = ₹${_roundTick(target8ATR)}\nAction:\n${exitQty > 0 ? `  1. Set Sell GTT (Tranche): ${exitQty} Qty at ${t8.trLabel}\n` : `  1. Tranche exit fulfilled.\n`}  2. Set Sell GTT (Core): ${remainQty} Qty at ₹${_roundTick(t8.finalCore)} (EMA20)`;
                dynamicGttPrices = { core: t8.gtt.core, tranche: exitQty > 0 ? t8.gtt.tranche : 0 };
                tradeUpdates.activeGTT = { tranche: { price: exitQty > 0 ? t8.gtt.tranche : 0, qty: exitQty }, core: { price: t8.gtt.core, qty: remainQty }, setDate: new Date().toISOString().split('T')[0] };
              } else if (cmp >= target4ATR) {
                activeDynamicAlert = ALERT_TYPES.EXT_4ATR;
                const exitQty = _calcTierExitQty(PS, totalExited, openQty, 0.20);
                const remainQty = openQty - exitQty;
                const t4 = _buildTrailMsg(exitQty, remainQty);
                const finalCore4 = Math.max(entry, t4.finalCore);
                dynamicAlertMessage = `Normal Extension (4×ATR) reached.\nCMP ₹${_roundTick(cmp)} ≥ 4×ATR = ₹${_roundTick(target4ATR)}\nAction:\n${exitQty > 0 ? `  1. Set Sell GTT (Tranche): ${exitQty} Qty at ${t4.trLabel}\n` : `  1. Tranche exit fulfilled.\n`}  2. Set Sell GTT (Core): ${remainQty} Qty at ₹${_roundTick(finalCore4)} (BE or EMA20)\n  3. Move Stop Loss to BE ₹${_roundTick(entry)}`;
                dynamicGttPrices = { core: parseFloat(_roundTick(finalCore4)), tranche: exitQty > 0 ? t4.gtt.tranche : 0 };
                tradeUpdates.activeGTT = { tranche: { price: exitQty > 0 ? t4.gtt.tranche : 0, qty: exitQty }, core: { price: parseFloat(_roundTick(finalCore4)), qty: remainQty }, setDate: new Date().toISOString().split('T')[0] };
              } else if (cmp >= target1R && !(trade.pyramids?.length > 0)) {
                activeDynamicAlert = ALERT_TYPES.CHECKPOINT_1R;
                dynamicAlertMessage = `1R Checkpoint reached. Add 50% pos at ₹${_roundTick(cmp)}. Tighten stop to ₹${_roundTick((entry + (trade.initialStop || 0)) / 2)}.`;
              }
            }
          }
        }
      }

      if (trade.activeGTT && trade.cmp && trade.direction === 'Long') {
        const gtt = trade.activeGTT;
        const todayStr = new Date().toISOString().split('T')[0];
        if (gtt.tranche?.price > 0 && gtt.tranche.qty > 0 && trade.cmp <= gtt.tranche.price && gtt.trancheBreachedDate !== todayStr) {
          const wasNew = _upsertAlert(alerts, ALERT_TYPES.GTT_TRANCHE_HIT, `Tranche GTT Triggered! CMP ₹${_roundTick(trade.cmp)} <= ₹${_roundTick(gtt.tranche.price)}.`, null, dirty, isEndOfDay);
          if (wasNew && _canTelegram && _gttChangedSignificantly(trade.id, 'tranche', gtt.tranche.price)) {
            _sendTelegram(settings, trade.symbol, ALERT_TYPES.GTT_TRANCHE_HIT, `Tranche GTT Hit! Sell ${gtt.tranche.qty} Qty.`);
            _recordGTT(trade.id, 'tranche', gtt.tranche.price);
          }
          tradeUpdates.activeGTT = { ...(tradeUpdates.activeGTT || trade.activeGTT), trancheBreachedDate: todayStr };
        }
        if (gtt.core?.price > 0 && gtt.core.qty > 0 && trade.cmp <= gtt.core.price && gtt.coreBreachedDate !== todayStr) {
          const wasNew = _upsertAlert(alerts, ALERT_TYPES.GTT_CORE_HIT, `Core GTT Triggered! CMP ₹${_roundTick(trade.cmp)} <= ₹${_roundTick(gtt.core.price)}.`, null, dirty, isEndOfDay);
          if (wasNew && _canTelegram && _gttChangedSignificantly(trade.id, 'core', gtt.core.price)) {
            _sendTelegram(settings, trade.symbol, ALERT_TYPES.GTT_CORE_HIT, `Core GTT Hit! Sell ${gtt.core.qty} Qty.`);
            _recordGTT(trade.id, 'core', gtt.core.price);
          }
          tradeUpdates.activeGTT = { ...(tradeUpdates.activeGTT || trade.activeGTT), coreBreachedDate: todayStr };
        }
      }

      const currentStop = m.currentStop || trade.initialStop;
      const isStopBreached = alertConfig.stopLossBreach?.enabled !== false && trade.cmp && currentStop && (trade.direction === 'Long' ? trade.cmp <= currentStop : trade.cmp >= currentStop);

      if (isStopBreached) {
        const { openQty } = _getCumulativeExitData(trade);
        const wasNew = _upsertAlert(alerts, ALERT_TYPES.STOP_BREACH, `CMP breached stop loss of ₹${_roundTick(currentStop)}. EXIT all ${openQty} Qty.`, null, dirty, isEndOfDay);
        if (wasNew && _canTelegram) _sendTelegram(settings, trade.symbol, ALERT_TYPES.STOP_BREACH, `CMP breached stop loss ₹${_roundTick(currentStop)}.`);
        activeDynamicAlert = null;
      } else {
        const stopIdx = alerts.findIndex(a => a.type === ALERT_TYPES.STOP_BREACH);
        if (stopIdx !== -1) { alerts.splice(stopIdx, 1); dirty.changed = true; }
      }

      const dynamicTypes = [ALERT_TYPES.CHECKPOINT_1R, ALERT_TYPES.EXT_4ATR, ALERT_TYPES.EXT_8ATR, ALERT_TYPES.EXT_12ATR, ALERT_TYPES.RUNNER_MODE, ALERT_TYPES.SOFT_BREACH_WARN, ALERT_TYPES.WEAKNESS_EXIT];
      dynamicTypes.forEach(t => { if (t !== activeDynamicAlert) { const idx = alerts.findIndex(a => a.type === t && a.status !== 'Completed'); if (idx !== -1) { alerts.splice(idx, 1); dirty.changed = true; } } });

      if (activeDynamicAlert) {
        const wasNew = _upsertAlert(alerts, activeDynamicAlert, dynamicAlertMessage, dynamicGttPrices, dirty, isEndOfDay);
        if (_canTelegram && _dynamicAlertChanged(trade.id, activeDynamicAlert, dynamicGttPrices)) {
          _sendTelegram(settings, trade.symbol, activeDynamicAlert, dynamicAlertMessage);
          _alertState.lastAlertedDynamicType[trade.id] = activeDynamicAlert;
          if (dynamicGttPrices?.core    > 0) _recordGTT(trade.id, 'dynamicCore',    dynamicGttPrices.core);
          if (dynamicGttPrices?.tranche > 0) _recordGTT(trade.id, 'dynamicTranche', dynamicGttPrices.tranche);
        }
      }

      let needsSave = dirty.changed;
      if (Object.keys(tradeUpdates).length > 0) {
        for (const k of Object.keys(tradeUpdates)) { if (trade[k] !== tradeUpdates[k]) { trade[k] = tradeUpdates[k]; needsSave = true; } }
      }
      if (needsSave) {
        const updated_trade = { ...trade, alerts };
        updated.push(updated_trade);
        if (window.db && db.saveTrade) await db.saveTrade(updated_trade);
      }
    }
    await _simulatePaperTrades(ohlcMap, settings);
    return updated;
  }

  // ── CMP Fetch for Paper Trade Simulation ──────────────────────────────
  const _PT_SB_URL = 'https://zopskuwqlbteyiypwnid.supabase.co';
  const _PT_SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvcHNrdXdxbGJ0ZXlpeXB3bmlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMTI3NTksImV4cCI6MjA5OTY4ODc1OX0.gG0TU9Uf3ODJOqUu4SqZs-Uk1CKlUb47DrfULVg6vHY';

  async function _fetchPaperCmp(symbol) {
    try {
      const ticker = symbol.includes('.') ? encodeURIComponent(symbol) : `${encodeURIComponent(symbol)}.NS`;
      const resp = await fetch(
        `${_PT_SB_URL}/functions/v1/yahoo-finance?ticker=${ticker}`,
        { headers: { 'Authorization': `Bearer ${_PT_SB_KEY}` } }
      );
      const data = await resp.json();
      return data?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
    } catch { return null; }
  }

  // ── Paper Trade Simulation (intraday-aware, mirrors positions engine) ──
  async function _simulatePaperTrades(ohlcMap, settings) {
    if (!window.db || !db.getOpenPaperTrades) return;
    const paperTrades = await db.getOpenPaperTrades();
    if (!paperTrades || !paperTrades.length) return;

    const today   = new Date().toISOString().split('T')[0];
    const calc    = window.calc || {};

    // Fetch live CMP for all paper trade symbols in parallel (intraday check)
    const symbols  = [...new Set(paperTrades.map(t => t.symbol))];
    const cmpCache = {};
    await Promise.all(symbols.map(async sym => {
      cmpCache[sym] = await _fetchPaperCmp(sym);
    }));

    for (const trade of paperTrades) {
      // ── Compute metrics ────────────────────────────────────────────────
      let m;
      if (calc.getTradeMetrics) {
        m = calc.getTradeMetrics(trade);
      } else {
        const ins = [...(trade.entries || []), ...(trade.pyramids || [])];
        let tq = 0, tc = 0;
        for (const e of ins) { tq += e.qty; tc += (e.price * e.qty); }
        const outs = (trade.partialExits || []).reduce((s, e) => s + e.qty, 0);
        m = { openQty: tq - outs, avgEntryPrice: tq > 0 ? tc / tq : 0, currentStop: trade.currentStop || trade.initialStop };
      }
      if (m.openQty <= 0) continue;

      const entryPrice   = m.avgEntryPrice;
      const currentStop  = m.currentStop || trade.initialStop;
      const riskPerShare = Math.abs(entryPrice - trade.initialStop);
      const isShort      = trade.direction === 'Short';
      const updated      = { ...trade };
      let   changed      = false;

      // ── ATR extension targets (same as real trade engine) ──────────────
      const atr      = trade.entryATR || 0;
      const swingLow = trade.swingLow || entryPrice;
      const target4  = isShort ? swingLow - 4  * atr : swingLow + 4  * atr;
      const target8  = isShort ? swingLow - 8  * atr : swingLow + 8  * atr;
      const target12 = isShort ? swingLow - 12 * atr : swingLow + 12 * atr;
      const target1R = isShort ? entryPrice - riskPerShare : entryPrice + riskPerShare;

      // Helper: has this exit already been recorded?
      const hasExit = (src) => (updated.partialExits || []).some(e => e.actionSource?.includes(src));

      // ── PASS 1: Historical candles — fill in any missed past exits ─────
      const histCandles = ohlcMap[trade.symbol] || ohlcMap[trade.symbol + '.NS'] || [];
      for (const candle of histCandles) {
        if (updated.finalExit) break;
        const { high, low, time } = candle;
        const candleDate = time ? new Date(time * 1000).toISOString().split('T')[0] : today;
        if (candleDate >= today) continue; // today handled by live CMP below

        // Stop loss
        if (isShort ? high >= currentStop : low <= currentStop) {
          updated.finalExit = { id: db.generateId('pe'), date: candleDate, price: currentStop, qty: m.openQty, charges: 0, actionSource: 'Stop Loss Breached (Paper)' };
          changed = true; break;
        }
        // 1R partial exit
        if (!hasExit('1R') && (isShort ? low <= target1R : high >= target1R)) {
          const exitQty = Math.floor(m.openQty / 2);
          if (exitQty > 0) {
            updated.partialExits = [...(updated.partialExits || []), { id: db.generateId('pe'), date: candleDate, price: target1R, qty: exitQty, charges: 0, actionSource: '1R Partial Exit (Paper)' }];
            updated.currentStop  = entryPrice; // trail to BE
            m.openQty -= exitQty;
            changed = true;
          }
        }
        // ATR extension exits
        if (atr > 0) {
          const remaining = m.openQty;
          const extChecks = [
            { target: target4,  src: '4×ATR',  fraction: 0.20, label: '4×ATR Extension Exit (Paper)' },
            { target: target8,  src: '8×ATR',  fraction: 0.40, label: '8×ATR Extension Exit (Paper)' },
            { target: target12, src: '12×ATR', fraction: 1.00, label: '12×ATR Extension Exit (Paper)' },
          ];
          for (const ext of extChecks) {
            if (!hasExit(ext.src) && remaining > 0 && (isShort ? low <= ext.target : high >= ext.target)) {
              const qty = ext.fraction >= 1 ? remaining : Math.floor(remaining * ext.fraction);
              if (qty > 0) {
                updated.partialExits = [...(updated.partialExits || []), { id: db.generateId('pe'), date: candleDate, price: ext.target, qty, charges: 0, actionSource: ext.label }];
                m.openQty -= qty;
                changed = true;
              }
            }
          }
        }
      }

      // ── PASS 2: Live intraday CMP — check TODAY's moves ───────────────
      if (!updated.finalExit) {
        const cmp = cmpCache[trade.symbol];
        if (cmp) {
          // Update cmp on trade object so UI shows current price
          if (Math.abs(cmp - (updated.cmp || 0)) > 0.01) {
            updated.cmp = cmp;
            changed = true;
          }
          // Stop loss hit intraday
          if (isShort ? cmp >= currentStop : cmp <= currentStop) {
            updated.finalExit = { id: db.generateId('pe'), date: today, price: currentStop, qty: m.openQty, charges: 0, actionSource: 'Stop Loss Breached (Paper — Intraday)' };
            changed = true;
          }
          // 1R hit intraday
          if (!updated.finalExit && !hasExit('1R') && (isShort ? cmp <= target1R : cmp >= target1R)) {
            const exitQty = Math.floor(m.openQty / 2);
            if (exitQty > 0) {
              updated.partialExits = [...(updated.partialExits || []), { id: db.generateId('pe'), date: today, price: target1R, qty: exitQty, charges: 0, actionSource: '1R Partial Exit (Paper — Intraday)' }];
              updated.currentStop  = entryPrice;
              m.openQty -= exitQty;
              changed = true;
            }
          }
          // ATR extension hits intraday
          if (!updated.finalExit && atr > 0) {
            const extChecks = [
              { target: target4,  src: '4×ATR',  fraction: 0.20, label: '4×ATR Exit (Paper — Intraday)' },
              { target: target8,  src: '8×ATR',  fraction: 0.40, label: '8×ATR Exit (Paper — Intraday)' },
              { target: target12, src: '12×ATR', fraction: 1.00, label: '12×ATR Exit (Paper — Intraday)' },
            ];
            for (const ext of extChecks) {
              if (!hasExit(ext.src) && m.openQty > 0 && (isShort ? cmp <= ext.target : cmp >= ext.target)) {
                const qty = ext.fraction >= 1 ? m.openQty : Math.floor(m.openQty * ext.fraction);
                if (qty > 0) {
                  updated.partialExits = [...(updated.partialExits || []), { id: db.generateId('pe'), date: today, price: ext.target, qty, charges: 0, actionSource: ext.label }];
                  m.openQty -= qty;
                  changed = true;
                }
              }
            }
          }
        }
      }

      // ── Day-6 Time Stop ───────────────────────────────────────────────
      if (!updated.finalExit && m.openQty > 0) {
        const entryDate   = trade.entries?.[0]?.date || today;
        const tradingDays = calc.getTradingDays
          ? calc.getTradingDays(entryDate, today, settings?.marketHolidays || '')
          : Math.floor((new Date() - new Date(entryDate)) / (1000 * 60 * 60 * 24));
        if (tradingDays >= 6) {
          const lastClose = (histCandles[histCandles.length - 1]?.close) || cmpCache[trade.symbol] || entryPrice;
          updated.finalExit = { id: db.generateId('pe'), date: today, price: lastClose, qty: m.openQty, charges: 0, actionSource: 'Day-6 Time Stop (Paper)' };
          changed = true;
        }
      }

      if (changed) try { await db.savePaperTrade(updated); } catch(e) { console.warn('Paper sim save failed:', e); }
    }
  }

  async function _monitorWatchlist(activeWatchlist, ohlcMap, settings, canTelegram = true) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (_alertState._watchlistDate !== todayStr) {
      _alertState.triggeredWatchlist.clear();
      _alertState._watchlistDate = todayStr;
    }
    for (const item of activeWatchlist) {
      if (item.status !== 'monitoring') continue;
      const candles = ohlcMap[item.symbol];
      if (!candles || candles.length === 0) continue;
      const cmp = candles[candles.length - 1].close;
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

      // Choose header based on alert type
      const isWatchlist = (phase || '').toUpperCase().includes('WATCHLIST');
      const emoji  = isWatchlist ? '📋' : '🚨';
      const header = isWatchlist ? 'WATCHLIST ALERT' : 'EXIT ALERT';

      const text = `${emoji} *${header}* ${emoji}\n\n*Symbol:* ${symbol}\n*Phase:* ${phase}\n\n*Action Required:*\n${instruction}`;
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
