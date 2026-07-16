/**
 * alerts.js — Alert Engine (Phase 2 — async)
 * Evaluates alert conditions for all open trades.
 */
const alertEngine = (() => {

  const ALERT_TYPES = {
    DAY5_EXIT:       'Day-5 Exit Due',
    STOP_BREACH:     'Stop Loss Breach',
    PHASE1:          'Dynamic Exit: Phase 1 (2R)',
    PHASE2:          'Dynamic Exit: Phase 2 (3 ATR)',
    PHASE3:          'Dynamic Exit: Phase 3 (5 ATR)',
    TREND_BROKEN:    'Dynamic Exit: Trend Broken'
  };

  const ALERT_STATUS = { PENDING: 'Pending', TRIGGERED: 'Triggered', COMPLETED: 'Completed', DISMISSED: 'Dismissed' };

  // ── Technical Indicator Math ───────────────────────────────────────────────
  
  function calculateEMA(closes, period) {
    if (!closes || closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes[0]; // simple seed
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
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    
    let sum = 0;
    for (let i = 0; i < period; i++) sum += trs[i];
    let atr = sum / period; // SMA for first ATR
    
    for (let i = period; i < trs.length; i++) {
      atr = ((atr * (period - 1)) + trs[i]) / period; // Wilder's smoothing
    }
    return atr;
  }

  // Phase 2: async — receives openTrades array, settings, and historical ohlc map
  async function checkAllAlerts(openTrades, settings, ohlcMap = {}) {
    if (!settings) settings = await db.getSettings();
    const alertConfig = settings.alerts || {};
    const updated = [];

    for (const trade of openTrades) {
      const alerts = [...(trade.alerts || [])];
      const m = calc.getTradeMetrics(trade);
      const dirty = { changed: false };

      // ── Standard Alerts ──────────────────────────────────────────────────
      if (alertConfig.day5Exit?.enabled !== false) {
        const todayStr = new Date().toISOString().split('T')[0];
        const entryDate = trade.entries?.[0]?.date || todayStr;
        const holidays = settings.marketHolidays || '';
        const tradingDays = calc.getTradingDays(entryDate, todayStr, holidays);
        if (tradingDays >= 5) _upsertAlert(alerts, ALERT_TYPES.DAY5_EXIT, 'Trade has been held for 5+ days without hitting target.', dirty);
      }

      // ── Dynamic Trailing Exit Alerts (Long Only for now) ─────────────────
      let activeDynamicAlert = null;
      let dynamicAlertMessage = '';

      if (trade.direction === 'Long' && ohlcMap[trade.symbol]) {
        const candles = ohlcMap[trade.symbol];
        if (candles.length >= 20) {
          const closes = candles.map(c => c.close);
          const ema10 = calculateEMA(closes, 10);
          const ema20 = calculateEMA(closes, 20);
          const atr14 = calculateATR(candles, 14);
          
          const prevCandle = candles[candles.length - 2];
          const currCandle = candles[candles.length - 1];
          const prevLow = prevCandle?.low || 0;
          const dailyMove = currCandle.close - prevCandle.close;
          
          const cmp = trade.cmp || closes[closes.length - 1];
          const entry = m.avgEntryPrice;
          const risk = Math.abs(entry - trade.initialStop);
          
          const initialSize = (trade.entries || []).reduce((sum, e) => sum + Number(e.qty || 0), 0);
          const exitedSize = (trade.partialExits || []).reduce((sum, e) => sum + Number(e.qty || 0), 0);
          const openQty = initialSize - exitedSize;
          
          if (risk > 0 && atr14 > 0 && openQty > 0) {
            const target2R = entry + (2 * risk);
            const target3ATR = entry + (3 * atr14);
            const target5ATR = entry + (5 * atr14);
            
            // Priority 2.0: Trend Broken (Exit Runner)
            if (ema10 && cmp < ema10 && cmp >= target3ATR) {
               activeDynamicAlert = ALERT_TYPES.TREND_BROKEN;
               dynamicAlertMessage = `CMP < EMA10 (₹${ema10.toFixed(2)}). Sell remaining runner position (${openQty} Qty).`;
            }
            // Priority 2.1: Phase 3 (5x ATR)
            else if (cmp >= target5ATR) {
               activeDynamicAlert = ALERT_TYPES.PHASE3;
               const coreQty = Math.floor(initialSize * 0.40);
               const trancheQty = openQty - coreQty;
               
               const trancheGtt = Math.max(prevLow, ema10); // bound by core stop
               let instruction = `Cancel old GTT. Create GTT: Trail ${coreQty} Qty at ₹${ema10.toFixed(2)} (EMA10). Trail ${trancheQty} Qty aggressively at Prev Low (₹${trancheGtt.toFixed(2)})`;
               if (dailyMove > atr14) instruction += ` or jump trailing stop up by ATR/2 (₹${(atr14/2).toFixed(2)})`;
               dynamicAlertMessage = instruction;
            } 
            // Priority 2.2: Phase 2 (3x ATR)
            else if (cmp >= target3ATR) {
               activeDynamicAlert = ALERT_TYPES.PHASE2;
               const coreQty = Math.floor(initialSize * 0.60);
               const trancheQty = openQty - coreQty;
               
               const trancheGtt = Math.max(prevLow, ema10); // bound by core stop
               let instruction = `Cancel old GTT. Create GTT: Trail ${coreQty} Qty at ₹${ema10.toFixed(2)} (EMA10). Trail ${trancheQty} Qty at Prev Low (₹${trancheGtt.toFixed(2)})`;
               if (dailyMove > atr14) instruction += ` or jump trailing stop up by ATR/2 (₹${(atr14/2).toFixed(2)})`;
               dynamicAlertMessage = instruction;
            }
            // Priority 2.3: Phase 1 (2R)
            else if (cmp >= target2R) {
               activeDynamicAlert = ALERT_TYPES.PHASE1;
               const coreQty = Math.floor(initialSize * 0.80);
               const trancheQty = openQty - coreQty;
               
               const coreGtt = Math.max(entry, ema20);
               const trancheGtt = Math.max(target2R * 0.98, prevLow, coreGtt); // bound by core stop
               let instruction = `Cancel old GTT. Create GTT: Trail ${coreQty} Qty at ₹${coreGtt.toFixed(2)} [MAX(Breakeven, EMA20)]. Trail ${trancheQty} Qty at ₹${trancheGtt.toFixed(2)} [MAX(2R-2%, PrevLow)].`;
               dynamicAlertMessage = instruction;
            }
          }
        }
      }

      // ── Resolve Priorities & Cleanup ──────────────────────────────────────
      const isStopBreached = alertConfig.stopLossBreach?.enabled !== false && trade.cmp && 
         (trade.direction === 'Long' ? trade.cmp <= m.currentStop : trade.cmp >= m.currentStop);

      // Priority 1: Stop Loss Breach overrides EVERYTHING
      if (isStopBreached) {
         const wasNew = _upsertAlert(alerts, ALERT_TYPES.STOP_BREACH, `CMP breached stop loss of ₹${m.currentStop}.`, dirty);
         if (wasNew) _sendTelegram(settings, trade.symbol, ALERT_TYPES.STOP_BREACH, `CMP breached stop loss of ₹${m.currentStop}.`);
         activeDynamicAlert = null; // Suppress all dynamic exit phases
      } else {
         const stopIdx = alerts.findIndex(a => a.type === ALERT_TYPES.STOP_BREACH);
         if (stopIdx !== -1) { alerts.splice(stopIdx, 1); dirty.changed = true; }
      }

      // Enforce mutual exclusivity for dynamic alerts
      const dynamicTypes = [ALERT_TYPES.PHASE1, ALERT_TYPES.PHASE2, ALERT_TYPES.PHASE3, ALERT_TYPES.TREND_BROKEN];
      dynamicTypes.forEach(t => {
         if (t !== activeDynamicAlert) {
            const idx = alerts.findIndex(a => a.type === t);
            if (idx !== -1) { alerts.splice(idx, 1); dirty.changed = true; }
         }
      });

      // Upsert the single winning dynamic alert (if any)
      if (activeDynamicAlert) {
         const wasNew = _upsertAlert(alerts, activeDynamicAlert, dynamicAlertMessage, dirty);
         if (wasNew) _sendTelegram(settings, trade.symbol, activeDynamicAlert, dynamicAlertMessage);
      }

      if (dirty.changed) {
        const updated_trade = { ...trade, alerts };
        updated.push(updated_trade);
        await db.saveTrade(updated_trade);
      }
    }

    return updated;
  }

  function _upsertAlert(alerts, type, message, dirty) {
    const existing = alerts.find(a => a.type === type);
    const today = new Date().toISOString().split('T')[0];

    if (!existing) {
      alerts.push({ 
        type, 
        status: ALERT_STATUS.TRIGGERED, 
        message, 
        triggeredAt: new Date().toISOString(),
        lastNotifiedDate: today
      });
      dirty.changed = true;
      return true;
    } else if (existing.status === ALERT_STATUS.PENDING || existing.message !== message) {
      
      const oldMsg = existing.message || '';
      existing.message = message;
      dirty.changed = true;
      
      let shouldNotify = false;
      
      // Rule B: End of day update (Calendar day changed)
      if (existing.lastNotifiedDate !== today) {
         shouldNotify = true;
      } else {
         // Rule C: Intraday 1% move on any price mentioned in the alert
         const oldPrices = (oldMsg.match(/₹[\d.]+/g) || []).map(s => parseFloat(s.replace('₹','')));
         const newPrices = (message.match(/₹[\d.]+/g) || []).map(s => parseFloat(s.replace('₹','')));
         
         for (let i=0; i < Math.min(oldPrices.length, newPrices.length); i++) {
            if (oldPrices[i] > 0) {
               const pctMove = (newPrices[i] - oldPrices[i]) / oldPrices[i];
               if (pctMove >= 0.01) { // 1% upward move
                  shouldNotify = true;
                  break;
               }
            }
         }
      }
      
      if (shouldNotify || existing.status === ALERT_STATUS.PENDING) {
         existing.status = ALERT_STATUS.TRIGGERED;
         existing.triggeredAt = new Date().toISOString();
         existing.lastNotifiedDate = today;
         return true; // Send telegram
      }
    }
    return false;
  }

  async function _sendTelegram(settings, symbol, phase, instruction) {
     if (!settings.telegramBotToken || !settings.telegramChatId) return;
     try {
       const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
       const text = `🚨 *DYNAMIC EXIT ALERT* 🚨\n\n*Symbol:* ${symbol}\n*Phase:* ${phase}\n\n*Action Required:*\n${instruction}`;
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
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const alerts = (trade.alerts || []).map(a =>
      a.type === alertType ? { ...a, status: ALERT_STATUS.DISMISSED } : a
    );
    await db.saveTrade({ ...trade, alerts });
  }

  async function completeAlert(tradeId, alertType) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const alerts = (trade.alerts || []).map(a =>
      a.type === alertType ? { ...a, status: ALERT_STATUS.COMPLETED } : a
    );
    await db.saveTrade({ ...trade, alerts });
  }

  return { ALERT_TYPES, ALERT_STATUS, checkAllAlerts, getActiveAlerts, dismissAlert, completeAlert };
})();
