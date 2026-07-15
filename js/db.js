/**
 * db.js — Trading Journal Data Layer (SSOT)
 * All modules MUST use only these functions to read/write data.
 * Never access localStorage directly from module files.
 */

const DB_KEYS = {
  TRADES: 'tj_trades',
  CAPITAL: 'tj_capital',
  PLAYBOOKS: 'tj_playbooks',
  SETTINGS: 'tj_settings',
  MARKET_HEALTH: 'tj_market_health',
  EQUITY_SNAPSHOTS: 'tj_equity_snapshots',
  SEEDED: 'tj_seeded'
};

const db = (() => {
  // ── Helpers ────────────────────────────────────────────────────────────────
  function _read(key, fallback = []) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.error('DB read error:', key, e);
      return fallback;
    }
  }

  function _write(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.error('DB write error:', key, e);
    }
  }

  function _generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  // ── Trades ─────────────────────────────────────────────────────────────────
  function getTrades() {
    return _read(DB_KEYS.TRADES, []);
  }

  function getOpenTrades() {
    return getTrades().filter(t => getTradeRemainingQty(t) > 0);
  }

  function getClosedTrades() {
    return getTrades().filter(t => getTradeRemainingQty(t) <= 0 && t.entries && t.entries.length > 0);
  }

  function getTradeById(id) {
    return getTrades().find(t => t.id === id) || null;
  }

  function saveTrade(trade) {
    const trades = getTrades();
    const idx = trades.findIndex(t => t.id === trade.id);
    if (idx >= 0) {
      trades[idx] = { ...trade, updatedAt: new Date().toISOString() };
    } else {
      trades.push({ ...trade, id: trade.id || _generateId('tr'), createdAt: trade.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    _write(DB_KEYS.TRADES, trades);
    _notifyChange('trades');
  }

  function deleteTrade(id) {
    const trades = getTrades().filter(t => t.id !== id);
    _write(DB_KEYS.TRADES, trades);
    _notifyChange('trades');
  }

  function getTradeRemainingQty(trade) {
    if (!trade || !trade.entries) return 0;
    const totalEntry = trade.entries.reduce((s, e) => s + (Number(e.qty) || 0), 0);
    const totalPyramid = (trade.pyramids || []).reduce((s, p) => s + (Number(p.qty) || 0), 0);
    const totalPartialExit = (trade.partialExits || []).reduce((s, p) => s + (Number(p.qty) || 0), 0);
    const finalExitQty = trade.finalExit ? (Number(trade.finalExit.qty) || 0) : 0;
    return (totalEntry + totalPyramid) - (totalPartialExit + finalExitQty);
  }

  // ── Capital ────────────────────────────────────────────────────────────────
  function getCapital() {
    return _read(DB_KEYS.CAPITAL, []);
  }

  function saveCapitalTransaction(txn) {
    const capital = getCapital();
    const idx = capital.findIndex(c => c.id === txn.id);
    if (idx >= 0) {
      capital[idx] = txn;
    } else {
      capital.push({ ...txn, id: txn.id || _generateId('cap') });
    }
    // Sort by date
    capital.sort((a, b) => new Date(a.date) - new Date(b.date));
    // Recalculate running balance
    let balance = 0;
    capital.forEach(c => {
      if (c.type === 'Deposit' || c.type === 'Adjustment') balance += Number(c.amount);
      else if (c.type === 'Withdrawal') balance -= Number(c.amount);
      c.runningBalance = balance;
    });
    _write(DB_KEYS.CAPITAL, capital);
    _notifyChange('capital');
  }

  function deleteCapitalTransaction(id) {
    let capital = getCapital().filter(c => c.id !== id);
    capital.sort((a, b) => new Date(a.date) - new Date(b.date));
    let balance = 0;
    capital.forEach(c => {
      if (c.type === 'Deposit' || c.type === 'Adjustment') balance += Number(c.amount);
      else if (c.type === 'Withdrawal') balance -= Number(c.amount);
      c.runningBalance = balance;
    });
    _write(DB_KEYS.CAPITAL, capital);
    _notifyChange('capital');
  }

  // ── Playbooks ──────────────────────────────────────────────────────────────
  function getPlaybooks() {
    return _read(DB_KEYS.PLAYBOOKS, []);
  }

  function getPlaybookById(id) {
    return getPlaybooks().find(p => p.id === id) || null;
  }

  function savePlaybook(pb) {
    const playbooks = getPlaybooks();
    const idx = playbooks.findIndex(p => p.id === pb.id);
    if (idx >= 0) {
      playbooks[idx] = { ...pb, updatedAt: new Date().toISOString() };
    } else {
      playbooks.push({ ...pb, id: pb.id || _generateId('pb'), createdAt: pb.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    _write(DB_KEYS.PLAYBOOKS, playbooks);
    _notifyChange('playbooks');
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function getSettings() {
    return _read(DB_KEYS.SETTINGS, getDefaultSettings());
  }

  function saveSettings(settings) {
    _write(DB_KEYS.SETTINGS, settings);
    _notifyChange('settings');
  }

  function getDefaultSettings() {
    return {
      general: {
        traderName: 'Trader',
        baseCurrency: 'INR',
        timezone: 'Asia/Kolkata',
        dateFormat: 'DD-MM-YYYY',
        financialYearStart: 'April',
        defaultStartupModule: 'dashboard',
        defaultDateRange: 'YTD'
      },
      tradingDefaults: {
        defaultTradeType: 'Equity',
        defaultDirection: 'Long',
        defaultRPT: 10000,
        maxOpenPositions: 10,
        defaultReviewStatus: 'Pending',
        autoOpenAfterSave: true
      },
      riskManagement: {
        maxPortfolioHeat: 4,
        warningPortfolioHeat: 3.5,
        maxRPT: 15000,
        riskColorThresholds: { safe: 2, warning: 3, danger: 4 }
      },
      charges: {
        broker: 'Zerodha',
        equity: {
          brokerage: 0,
          stt: 0.001,          // 0.1% both sides
          exchangeCharge: 0.0000335,
          sebiCharge: 0.000001,  // ₹10/crore = 0.000001
          gst: 0.18,
          stampDuty: 0.00015     // 0.015% on buy
        },
        intraday: {
          brokerage: 20,         // ₹20 flat or 0.03% lower
          brokeragePercent: 0.0003,
          stt: 0.00025,          // 0.025% on sell
          exchangeCharge: 0.0000335,
          sebiCharge: 0.000001,
          gst: 0.18,
          stampDuty: 0.00003     // 0.003% on buy
        },
        futures: {
          brokerage: 20,
          brokeragePercent: 0.0003,
          stt: 0.0002,           // 0.02% on sell
          exchangeCharge: 0.00002,
          sebiCharge: 0.000001,
          gst: 0.18,
          stampDuty: 0.00002     // 0.002% on buy
        }
      },
      alerts: {
        portfolioHeat: { enabled: true, severity: 'Warning', dashboard: true, popup: true },
        positionRisk: { enabled: true, severity: 'Warning', dashboard: true, popup: false },
        stopLossBreach: { enabled: true, severity: 'Critical', dashboard: true, popup: true },
        day5Exit: { enabled: true, severity: 'Info', dashboard: true, popup: false },
        ruleBreak: { enabled: true, severity: 'Warning', dashboard: true, popup: false },
        revengeTrade: { enabled: true, severity: 'Warning', dashboard: true, popup: false },
        ema20Exit: { enabled: true, severity: 'Warning', dashboard: true, popup: false },
        atrExtension: { enabled: true, severity: 'Warning', dashboard: true, popup: false }
      },
      marketHealth: {
        trend: 'Uptrend',
        breadthValue: 1.82,
        breadthClassification: 'Strong',
        guidance: 'Breakouts Favoured',
        lastUpdated: new Date().toISOString().split('T')[0]
      }
    };
  }

  // ── Market Health ──────────────────────────────────────────────────────────
  function getMarketHealth() {
    const settings = getSettings();
    return settings.marketHealth || {};
  }

  function saveMarketHealth(data) {
    const settings = getSettings();
    settings.marketHealth = { ...data, lastUpdated: new Date().toISOString().split('T')[0] };
    saveSettings(settings);
  }

  // ── Equity Snapshots ───────────────────────────────────────────────────────
  function getEquitySnapshots() {
    return _read(DB_KEYS.EQUITY_SNAPSHOTS, []);
  }

  function saveEquitySnapshot(snapshot) {
    const snapshots = getEquitySnapshots();
    const idx = snapshots.findIndex(s => s.date === snapshot.date);
    if (idx >= 0) snapshots[idx] = snapshot;
    else snapshots.push(snapshot);
    snapshots.sort((a, b) => new Date(a.date) - new Date(b.date));
    _write(DB_KEYS.EQUITY_SNAPSHOTS, snapshots);
  }

  // ── Seeding ────────────────────────────────────────────────────────────────
  function isSeeded() {
    return localStorage.getItem(DB_KEYS.SEEDED) === 'true';
  }

  function markSeeded() {
    localStorage.setItem(DB_KEYS.SEEDED, 'true');
  }

  function clearAll() {
    Object.values(DB_KEYS).forEach(k => localStorage.removeItem(k));
  }

  // ── Change notifications ───────────────────────────────────────────────────
  const _listeners = {};

  function _notifyChange(type) {
    if (_listeners[type]) {
      _listeners[type].forEach(fn => { try { fn(); } catch(e) {} });
    }
    if (_listeners['any']) {
      _listeners['any'].forEach(fn => { try { fn(type); } catch(e) {} });
    }
  }

  function on(type, fn) {
    if (!_listeners[type]) _listeners[type] = [];
    _listeners[type].push(fn);
  }

  function off(type, fn) {
    if (_listeners[type]) _listeners[type] = _listeners[type].filter(f => f !== fn);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function generateId(prefix = 'id') {
    return _generateId(prefix);
  }

  return {
    getTrades, getOpenTrades, getClosedTrades, getTradeById,
    saveTrade, deleteTrade, getTradeRemainingQty,
    getCapital, saveCapitalTransaction, deleteCapitalTransaction,
    getPlaybooks, getPlaybookById, savePlaybook,
    getSettings, saveSettings, getDefaultSettings,
    getMarketHealth, saveMarketHealth,
    getEquitySnapshots, saveEquitySnapshot,
    isSeeded, markSeeded, clearAll,
    on, off, generateId
  };
})();
