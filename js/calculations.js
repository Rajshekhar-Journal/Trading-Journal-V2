/**
 * calculations.js — All Business Formula Computations
 * Pure functions. No side effects. No localStorage access.
 */

const calc = (() => {

  // ── Trade Metrics (SSOT) ───────────────────────────────────────────────────
  function getTradeMetrics(trade, settings = null) {
    if (!trade || !trade.entries || trade.entries.length === 0) return _emptyMetrics();

    const entries = trade.entries || [];
    const pyramids = trade.pyramids || [];
    const partialExits = trade.partialExits || [];
    const finalExit = trade.finalExit || null;

    // Quantities
    const entryQty = entries.reduce((s, e) => s + Number(e.qty || 0), 0);
    const pyramidQty = pyramids.reduce((s, p) => s + Number(p.qty || 0), 0);
    const totalBuyQty = entryQty + pyramidQty;

    const partialExitQty = partialExits.reduce((s, p) => s + Number(p.qty || 0), 0);
    const finalExitQty = finalExit ? Number(finalExit.qty || 0) : 0;
    const totalSellQty = partialExitQty + finalExitQty;
    const openQty = totalBuyQty - totalSellQty;
    const remainingQty = openQty; // alias

    // Average Entry Price (weighted)
    const totalBuyCost = entries.reduce((s, e) => s + (Number(e.qty || 0) * Number(e.price || 0)), 0)
      + pyramids.reduce((s, p) => s + (Number(p.qty || 0) * Number(p.price || 0)), 0);
    const avgEntryPrice = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;

    // Average Exit Price (weighted)
    const totalSellRevenue = partialExits.reduce((s, p) => s + (Number(p.qty || 0) * Number(p.price || 0)), 0)
      + (finalExit ? Number(finalExit.qty || 0) * Number(finalExit.price || 0) : 0);
    const avgExitPrice = totalSellQty > 0 ? totalSellRevenue / totalSellQty : 0;

    // Charges
    const totalBuyCharges = entries.reduce((s, e) => s + Number(e.charges || 0), 0)
      + pyramids.reduce((s, p) => s + Number(p.charges || 0), 0);
    const totalSellCharges = partialExits.reduce((s, p) => s + Number(p.charges || 0), 0)
      + (finalExit ? Number(finalExit.charges || 0) : 0);
    const totalCharges = totalBuyCharges + totalSellCharges;

    // Current Stop
    const currentStop = trade.currentStop !== undefined ? Number(trade.currentStop)
      : (trade.stopRevisions && trade.stopRevisions.length > 0
        ? Number(trade.stopRevisions[trade.stopRevisions.length - 1].newStop)
        : Number(trade.initialStop || 0));

    // RPT — dynamic high-water mark: replay entire lifecycle, track max risk ever.
    // MAX(Initial Risk, risk after each pyramid, risk after each stop revision)
    // RPT never decreases.
    const initialRPT = computeRPT(trade) || 10000;

    // Current Exposure
    const exposure = avgEntryPrice * openQty;

    // Position Size (max capital ever deployed — doesn't decrease)
    const maxExposureEver = Number(trade.positionSizeMax || exposure);
    const positionSize = Math.max(maxExposureEver, exposure);

    // Current Position Risk (signed: negative = loss if stop is hit)
    let currentRisk = 0;
    if (openQty > 0 && currentStop > 0) {
      if (trade.direction === 'Long') {
        currentRisk = (currentStop - avgEntryPrice) * openQty;
      } else {
        currentRisk = (avgEntryPrice - currentStop) * openQty;
      }
    }

    // Open Risk R = Current Position Risk / RPT
    const rptToUse = initialRPT;
    const currentRiskR = rptToUse !== 0 ? currentRisk / rptToUse : 0;

    // Net Realized P&L = (AvgExit − AvgEntry) × SoldQty − TotalCharges
    // TotalCharges always deducted (buy charges are a cost even before any exit)
    let realizedPnl = 0;
    if (trade.direction === 'Long') {
      realizedPnl = (avgExitPrice - avgEntryPrice) * totalSellQty;
    } else {
      realizedPnl = (avgEntryPrice - avgExitPrice) * totalSellQty;
    }
    realizedPnl -= totalCharges;

    // Unrealized P&L (needs CMP — passed separately)
    // We compute it outside when CMP is known

    // Profit R (realized)
    const profitR = rptToUse !== 0 ? realizedPnl / rptToUse : 0;

    // Return %
    const profitPct = positionSize > 0 ? (realizedPnl / positionSize) * 100 : 0;

    // Holding Days
    const entryDateStr = entries.length > 0 ? entries[0].date : new Date().toISOString().split('T')[0];
    const exitDateStr = finalExit ? finalExit.date : new Date().toISOString().split('T')[0];
    const entryDate = new Date(entryDateStr);
    const exitDate = new Date(exitDateStr);
    const holdingDays = Math.ceil((exitDate - entryDate) / (1000 * 60 * 60 * 24));
    
    // Trading Days
    const holidays = settings ? settings.marketHolidays : '';
    const tradingDays = getTradingDays(entryDateStr, exitDateStr, holidays);

    return {
      entryQty, pyramidQty, totalBuyQty,
      partialExitQty, finalExitQty, totalSellQty,
      openQty, remainingQty,
      avgEntryPrice, avgExitPrice,
      totalCharges,
      currentStop, initialRPT, rptCurrent: rptToUse,
      exposure, positionSize,
      currentRisk, currentRiskR,
      realizedPnl, profitR, profitPct,
      holdingDays, tradingDays,
      isOpen: openQty > 0
    };
  }

  function _emptyMetrics() {
    return {
      entryQty: 0, pyramidQty: 0, totalBuyQty: 0,
      partialExitQty: 0, finalExitQty: 0, totalSellQty: 0,
      openQty: 0, remainingQty: 0,
      avgEntryPrice: 0, avgExitPrice: 0,
      totalCharges: 0,
      currentStop: 0, initialRPT: 0, rptCurrent: 0,
      exposure: 0, positionSize: 0,
      currentRisk: 0, currentRiskR: 0,
      realizedPnl: 0, profitR: 0, profitPct: 0,
      holdingDays: 0, tradingDays: 0, isOpen: false
    };
  }

  // ── RPT Lifecycle Computation ─────────────────────────────────────────────────
  // Replays the full trade lifecycle chronologically:
  //   Entry → Pyramids → Stop Revisions → Partial Exits
  // At every event it recomputes position risk and keeps the MAX (high-water mark).
  // RPT = MAX(Initial Risk, risk after each pyramid, risk after each stop revision)
  // RPT NEVER decreases.
  function computeRPT(trade) {
    const entries      = trade.entries      || [];
    const pyramids     = trade.pyramids     || [];
    const partialExits = trade.partialExits || [];
    const stopRevisions= trade.stopRevisions|| [];
    const direction    = trade.direction    || 'Long';

    if (!entries.length) return 0;

    // Build a single chronological event list
    const events = [];
    entries.forEach(e => events.push({
      date: e.date || '', type: 'buy',
      price: Number(e.price || 0), qty: Number(e.qty || 0)
    }));
    pyramids.forEach(p => events.push({
      date: p.date || '', type: 'buy',
      price: Number(p.price || 0), qty: Number(p.qty || 0)
    }));
    partialExits.forEach(p => events.push({
      date: p.date || '', type: 'sell', qty: Number(p.qty || 0)
    }));
    stopRevisions.forEach(s => {
      if (s.newStop) events.push({
        date: s.date || '', type: 'stop', newStop: Number(s.newStop)
      });
    });

    // Sort chronologically (YYYY-MM-DD strings sort correctly lexicographically)
    events.sort((a, b) => a.date.localeCompare(b.date));

    let totalCost   = 0;
    let totalQty    = 0;
    let curStop     = Number(trade.initialStop || 0);
    let maxRPT      = 0;

    for (const ev of events) {
      if (ev.type === 'buy') {
        totalCost += ev.price * ev.qty;
        totalQty  += ev.qty;
      } else if (ev.type === 'sell') {
        const avgE = totalQty > 0 ? totalCost / totalQty : 0;
        totalQty   = Math.max(0, totalQty - ev.qty);
        totalCost  = totalQty * avgE;        // keep same avg entry
      } else if (ev.type === 'stop') {
        curStop = ev.newStop;
      }

      if (totalQty > 0 && curStop > 0) {
        const avgE   = totalCost / totalQty;
        // Absolute position risk at this moment in the lifecycle
        const posRisk = direction === 'Long'
          ? Math.max(0, (avgE - curStop) * totalQty)
          : Math.max(0, (curStop - avgE) * totalQty);
        maxRPT = Math.max(maxRPT, posRisk);
      }
    }

    return maxRPT;
  }

  // ── Unrealized P&L ─────────────────────────────────────────────────────────
  function getUnrealizedPnl(trade, cmp) {
    const m = getTradeMetrics(trade);
    if (m.openQty <= 0 || !cmp) return 0;
    if (trade.direction === 'Long') {
      return (cmp - m.avgEntryPrice) * m.openQty;
    } else {
      return (m.avgEntryPrice - cmp) * m.openQty;
    }
  }

  // ── Portfolio Heat ─────────────────────────────────────────────────────
  // Portfolio Heat % = Total Open Risk in ₹ / Account Equity × 100
  // This gives the true capital-at-risk percentage regardless of individual RPT sizes.
  function getPortfolioHeat(openTrades, equity) {
    if (!openTrades || openTrades.length === 0 || !equity) return 0;
    const totalRiskRs = getPortfolioHeatRs(openTrades);
    return (totalRiskRs / equity) * 100;  // returns a %
  }

  // Returns total open risk in absolute ₹ (sum of |currentRisk| across all positions)
  function getPortfolioHeatRs(openTrades) {
    if (!openTrades || openTrades.length === 0) return 0;
    return openTrades.reduce((sum, trade) => {
      const m = getTradeMetrics(trade);
      return sum + Math.max(0, Math.abs(m.currentRisk));
    }, 0);
  }

  // ── Capital ────────────────────────────────────────────────────────────────
  function getCurrentEquity(capitalTxns, realizedPnl = 0) {
    const netDeposits = capitalTxns.reduce((sum, txn) => {
      if (txn.type === 'Deposit' || txn.type === 'Adjustment') return sum + Number(txn.amount || 0);
      if (txn.type === 'Withdrawal') return sum - Number(txn.amount || 0);
      return sum;
    }, 0);
    return netDeposits + realizedPnl;
  }

  function getNetDeposits(capitalTxns) {
    return capitalTxns.reduce((sum, txn) => {
      if (txn.type === 'Deposit' || txn.type === 'Adjustment') return sum + Number(txn.amount || 0);
      if (txn.type === 'Withdrawal') return sum - Number(txn.amount || 0);
      return sum;
    }, 0);
  }

  function getCurrentR(equity, settings) {
    const rm = settings?.riskManagement || {};
    const riskMode = rm.riskMode || 'Dynamic';
    if (riskMode === 'Fixed') {
      // Fixed mode: use fixedRiskAmount from Risk Management settings
      return Number(rm.fixedRiskAmount || 10000);
    }
    // Dynamic mode: % of current equity
    const riskPercent = Number(rm.riskPercent || 1) / 100;
    return equity * riskPercent;
  }

  function getAvailableCash(equity, openTrades) {
    const totalExposure = openTrades.reduce((sum, t) => {
      const m = getTradeMetrics(t);
      return sum + m.exposure;
    }, 0);
    return equity - totalExposure;
  }

  // ── Performance Metrics ────────────────────────────────────────────────────
  function getWinRate(closedTrades) {
    if (!closedTrades || closedTrades.length === 0) return 0;
    const winners = closedTrades.filter(t => {
      const m = getTradeMetrics(t);
      return m.realizedPnl > 0;
    });
    return (winners.length / closedTrades.length) * 100;
  }

  function getAvgWinLoss(closedTrades) {
    if (!closedTrades || closedTrades.length === 0) return { avgWin: 0, avgLoss: 0, avgWinR: 0, avgLossR: 0 };
    const metrics = closedTrades.map(t => getTradeMetrics(t));
    const winners = metrics.filter(m => m.realizedPnl > 0);
    const losers = metrics.filter(m => m.realizedPnl < 0);
    const avgWin = winners.length > 0 ? winners.reduce((s, m) => s + m.realizedPnl, 0) / winners.length : 0;
    const avgLoss = losers.length > 0 ? losers.reduce((s, m) => s + m.realizedPnl, 0) / losers.length : 0;
    const avgWinR = winners.length > 0 ? winners.reduce((s, m) => s + m.profitR, 0) / winners.length : 0;
    const avgLossR = losers.length > 0 ? losers.reduce((s, m) => s + m.profitR, 0) / losers.length : 0;
    return { avgWin, avgLoss, avgWinR, avgLossR, winCount: winners.length, lossCount: losers.length };
  }

  function getExpectancy(closedTrades) {
    if (!closedTrades || closedTrades.length === 0) return 0;
    const wr = getWinRate(closedTrades) / 100;
    const lr = 1 - wr;
    const { avgWinR, avgLossR } = getAvgWinLoss(closedTrades);
    return (wr * avgWinR) + (lr * avgLossR);
  }

  function getMaxDrawdown(closedTrades) {
    if (!closedTrades || closedTrades.length === 0) return 0;
    const sorted = [...closedTrades].sort((a, b) => {
      const da = a.entries?.[0]?.date || '';
      const db2 = b.entries?.[0]?.date || '';
      return da.localeCompare(db2);
    });
    let peak = 0, maxDD = 0, cumR = 0;
    sorted.forEach(t => {
      const m = getTradeMetrics(t);
      cumR += m.profitR;
      if (cumR > peak) peak = cumR;
      const dd = cumR - peak;
      if (dd < maxDD) maxDD = dd;
    });
    return maxDD;
  }

  function getTotalPnl(trades) {
    return trades.reduce((s, t) => s + getTradeMetrics(t).realizedPnl, 0);
  }

  function getTotalR(trades) {
    return trades.reduce((s, t) => s + getTradeMetrics(t).profitR, 0);
  }

  // ── Daily P&L Data (for charts) ────────────────────────────────────────────
  function getDailyPnl(closedTrades) {
    if (!closedTrades || closedTrades.length === 0) return [];

    // Group by exit date
    const byDate = {};
    closedTrades.forEach(t => {
      const m = getTradeMetrics(t);
      const date = t.finalExit?.date || t.entries?.[0]?.date || '';
      if (!date) return;
      const d = date.split('T')[0];
      if (!byDate[d]) byDate[d] = 0;
      byDate[d] += m.realizedPnl;
    });

    const dates = Object.keys(byDate).sort();
    let cumPnl = 0;
    return dates.map(date => {
      cumPnl += byDate[date];
      return { date, pnl: byDate[date], cumPnl };
    });
  }

  function getMonthlyPnl(closedTrades) {
    const byMonth = {};
    closedTrades.forEach(t => {
      const m = getTradeMetrics(t);
      const date = t.finalExit?.date || t.entries?.[0]?.date || '';
      if (!date) return;
      const key = date.substring(0, 7); // YYYY-MM
      if (!byMonth[key]) byMonth[key] = { pnl: 0, trades: 0 };
      byMonth[key].pnl += m.realizedPnl;
      byMonth[key].trades++;
    });
    return byMonth;
  }

  // ── Date Filtering ─────────────────────────────────────────────────────────
  function filterByDateRange(trades, range, customStart, customEnd) {
    if (range === 'Last 20') {
      const sorted = trades.slice().sort((a,b) => {
        const da = a.finalExit?.date || a.entries?.[0]?.date || '';
        const db = b.finalExit?.date || b.entries?.[0]?.date || '';
        return da.localeCompare(db);
      });
      return sorted.slice(-20);
    }

    const now = new Date();
    let startDate;
    let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    switch (range) {
      case 'Weekly':
        startDate = new Date(now); startDate.setDate(now.getDate() - 7); break;
      case 'Monthly':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1); break;
      case 'Quarterly':
        const qMonth = Math.floor(now.getMonth() / 3) * 3;
        startDate = new Date(now.getFullYear(), qMonth, 1); break;
      case 'Yearly':
        startDate = new Date(now.getFullYear(), 0, 1); break;
      case 'YTD':
        startDate = new Date(now.getFullYear(), 3, 1); // April (Indian FY)
        if (now < startDate) startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      case 'Custom':
        startDate = customStart ? new Date(customStart) : new Date(0);
        endDate = customEnd ? new Date(customEnd) : endDate;
        break;
      default: // 'All'
        return trades;
    }

    return trades.filter(t => {
      const exitDate = t.finalExit?.date || t.entries?.[0]?.date;
      if (!exitDate) return false;
      const d = new Date(exitDate);
      return d >= startDate && d <= endDate;
    });
  }

  // ── Zerodha Charge Calculator ──────────────────────────────────────────────
  function getZerodhaCharges(tradeType, buyTurnover, sellTurnover, settings, exchange = 'NSE') {
    const cfg = settings?.charges || {};
    let brokerage = 0, stt = 0, exchangeCharge = 0, sebiCharge = 0, gst = 0, stampDuty = 0;
    const totalTurnover = buyTurnover + sellTurnover;

    // BSE standard transaction charge for equity segments
    const bseRate = 0.0000375;

    if (tradeType === 'Equity') {
      const c = cfg.equity || {};
      brokerage = Number(c.brokerage ?? 0);
      stt = totalTurnover * Number(c.stt ?? 0.001);
      const exRate = exchange === 'BSE' ? bseRate : Number(c.exchangeCharge ?? 0.0000335);
      exchangeCharge = totalTurnover * exRate;
      sebiCharge = totalTurnover * Number(c.sebiCharge ?? 0.000001);
      gst = (brokerage + exchangeCharge + sebiCharge) * Number(c.gst ?? 0.18);
      stampDuty = buyTurnover * Number(c.stampDuty ?? 0.00015);
    } else if (tradeType === 'Intraday') {
      const c = cfg.intraday || {};
      const brokerageFlat = Number(c.brokerage ?? 20);
      const brokeragePct = totalTurnover * Number(c.brokeragePercent ?? 0.0003);
      brokerage = Math.min(brokerageFlat, brokeragePct);
      stt = sellTurnover * Number(c.stt ?? 0.00025);
      const exRate = exchange === 'BSE' ? bseRate : Number(c.exchangeCharge ?? 0.0000335);
      exchangeCharge = totalTurnover * exRate;
      sebiCharge = totalTurnover * Number(c.sebiCharge ?? 0.000001);
      gst = (brokerage + exchangeCharge + sebiCharge) * Number(c.gst ?? 0.18);
      stampDuty = buyTurnover * Number(c.stampDuty ?? 0.00003);
    } else if (tradeType === 'Futures') {
      const c = cfg.futures || {};
      const brokerageFlat = Number(c.brokerage ?? 20);
      const brokeragePct = totalTurnover * Number(c.brokeragePercent ?? 0.0003);
      brokerage = Math.min(brokerageFlat, brokeragePct);
      stt = sellTurnover * Number(c.stt ?? 0.0002);
      const exRate = exchange === 'BSE' ? 0 : Number(c.exchangeCharge ?? 0.00002);
      exchangeCharge = totalTurnover * exRate;
      sebiCharge = totalTurnover * Number(c.sebiCharge ?? 0.000001);
      gst = (brokerage + exchangeCharge + sebiCharge) * Number(c.gst ?? 0.18);
      stampDuty = buyTurnover * Number(c.stampDuty ?? 0.00002);
    }

    const total = brokerage + stt + exchangeCharge + sebiCharge + gst + stampDuty;
    return { brokerage, stt, exchangeCharge, sebi: sebiCharge, gst, stampDuty, total };
  }

  // ── Utility ────────────────────────────────────────────────────────────────
  function isBreakEven(profitR) {
    return Math.abs(profitR) <= 0.3;
  }

  function getTradeResult(trade) {
    const m = getTradeMetrics(trade);
    if (m.realizedPnl > 0 && !isBreakEven(m.profitR)) return 'Win';
    if (m.realizedPnl < 0 && !isBreakEven(m.profitR)) return 'Loss';
    return 'Break-even';
  }

  function formatCurrency(amount, decimals = 0) {
    if (isNaN(amount)) return '₹0';
    const abs = Math.abs(amount);
    const sign = amount < 0 ? '-' : '';
    if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)}Cr`;
    if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)}L`;
    if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}K`;
    return `${sign}₹${abs.toFixed(decimals)}`;
  }

  function formatR(r, decimals = 2) {
    if (isNaN(r)) return '0R';
    const sign = r >= 0 ? '+' : '';
    return `${sign}${r.toFixed(decimals)}R`;
  }

  function formatDate(dateStr, format = 'DD-MM-YYYY') {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    if (format === 'DD-MM-YYYY') return `${day}-${month}-${year}`;
    if (format === 'MM-DD-YYYY') return `${month}-${day}-${year}`;
    return `${year}-${month}-${day}`;
  }

  function formatNumber(n, dec = 2) {
    if (isNaN(n)) return '0';
    return Number(n).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function getHoldingDays(trade) {
    const m = getTradeMetrics(trade);
    return m.holdingDays;
  }

  function getCAGR(startEquity, endEquity, years) {
    if (startEquity <= 0 || years <= 0) return 0;
    return (Math.pow(endEquity / startEquity, 1 / years) - 1) * 100;
  }

  function getDrawdownCurve(closedTrades) {
    const dailyData = getDailyPnl(closedTrades);
    let peak = 0, cumR = 0;
    return dailyData.map(d => {
      if (d.cumPnl > peak) peak = d.cumPnl;
      const dd = peak > 0 ? ((d.cumPnl - peak) / peak) * 100 : 0;
      return { date: d.date, drawdown: dd };
    });
  }

  function getTradingDays(startDateStr, endDateStr, holidaysStr = '') {
    if (!startDateStr || !endDateStr) return 0;
    
    const holidays = new Set();
    if (holidaysStr) {
      holidaysStr.split(',').forEach(d => {
        const parts = d.trim().split('-');
        if (parts.length === 3) {
          // Expecting DD-MM-YYYY, convert to YYYY-MM-DD
          holidays.add(`${parts[2]}-${parts[1]}-${parts[0]}`);
        }
      });
    }

    const start = new Date(startDateStr);
    start.setHours(0,0,0,0);
    const end = new Date(endDateStr);
    end.setHours(0,0,0,0);

    let count = 0;
    const cur = new Date(start);
    while (cur < end) {
      cur.setDate(cur.getDate() + 1);
      const dayOfWeek = cur.getDay(); // 0 is Sunday, 6 is Saturday
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
        if (!holidays.has(dateStr)) {
          count++;
        }
      }
    }
    return count;
  }

  return {
    getTradeMetrics, getUnrealizedPnl,
    getPortfolioHeat, getPortfolioHeatRs,
    getCurrentEquity, getNetDeposits, getCurrentR, getAvailableCash,
    getWinRate, getAvgWinLoss, getExpectancy, getMaxDrawdown,
    getTotalPnl, getTotalR,
    getDailyPnl, getMonthlyPnl, getDrawdownCurve,
    filterByDateRange,
    getZerodhaCharges,
    isBreakEven, getTradeResult,
    formatCurrency, formatR, formatDate, formatNumber,
    getHoldingDays, getTradingDays, getCAGR,
    computeRPT
  };
})();
