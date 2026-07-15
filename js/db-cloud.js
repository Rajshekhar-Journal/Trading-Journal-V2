/**
 * js/db-cloud.js — Cloud Data Layer (Phase 2)
 * Async replacement for db.js using Supabase.
 * Same public API as db.js — all modules work without changes
 * except that every call must be awaited.
 *
 * Pattern: db.getTrades() → await db.getTrades()
 */

const db = (() => {
  // ── Helpers ──────────────────────────────────────────────────────────────
  function _sb() { return auth.getClient(); }
  function _uid() { return auth.getUser()?.id; }

  function _generateId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  // ── Change notification system (compatibility with Phase 1) ───────────────
  const _listeners = {};
  function _notifyChange(type) {
    (_listeners[type] || []).forEach(fn => { try { fn(); } catch(e) {} });
    (_listeners['any'] || []).forEach(fn => { try { fn(type); } catch(e) {} });
  }
  function on(type, fn) {
    if (!_listeners[type]) _listeners[type] = [];
    _listeners[type].push(fn);
  }
  function off(type, fn) {
    if (_listeners[type]) _listeners[type] = _listeners[type].filter(f => f !== fn);
  }

  // ════════════════════════════════════════════════════════════════════════
  // TRADES
  // ════════════════════════════════════════════════════════════════════════

  async function getTrades() {
    const { data, error } = await _sb().from('trades').select('*').eq('user_id', _uid()).order('created_at', { ascending: false });
    if (error) { console.error('getTrades:', error); return []; }
    return (data || []).map(_rowToTrade);
  }

  async function getOpenTrades() {
    const all = await getTrades();
    return all.filter(t => getTradeRemainingQty(t) > 0);
  }

  async function getClosedTrades() {
    const all = await getTrades();
    return all.filter(t => getTradeRemainingQty(t) <= 0 && t.entries && t.entries.length > 0);
  }

  async function getTradeById(id) {
    const { data, error } = await _sb().from('trades').select('*').eq('id', id).eq('user_id', _uid()).single();
    if (error || !data) return null;
    return _rowToTrade(data);
  }

  async function saveTrade(trade) {
    const uid = _uid();
    const row = _tradeToRow(trade, uid);
    const { error } = await _sb().from('trades').upsert(row, { onConflict: 'id' });
    if (error) { console.error('saveTrade:', error); return; }
    _notifyChange('trades');
  }

  async function deleteTrade(id) {
    const { error } = await _sb().from('trades').delete().eq('id', id).eq('user_id', _uid());
    if (error) { console.error('deleteTrade:', error); return; }
    _notifyChange('trades');
  }

  // ── Trade shape converters ────────────────────────────────────────────────
  function _rowToTrade(row) {
    return {
      id:             row.id,
      symbol:         row.symbol,
      direction:      row.direction,
      tradeType:      row.trade_type,
      playbookId:     row.playbook_id,
      initialStop:    row.initial_stop,
      cmp:            row.cmp,
      entries:        row.entries        || [],
      pyramids:       row.pyramids       || [],
      partialExits:   row.partial_exits  || [],
      finalExit:      row.final_exit     || null,
      stopRevisions:  row.stop_revisions || [],
      alerts:         row.alerts         || [],
      notes:          row.notes          || [],
      ruleFollowed:   row.rule_followed,
      ruleBreakNote:  row.rule_break_note,
      reviewStatus:   row.review_status,
      rating:         row.rating,
      tags:           row.tags           || [],
      createdAt:      row.created_at,
      updatedAt:      row.updated_at,
    };
  }

  function _tradeToRow(trade, uid) {
    return {
      id:             trade.id || _generateId('tr'),
      user_id:        uid,
      symbol:         trade.symbol,
      direction:      trade.direction,
      trade_type:     trade.tradeType || trade.trade_type || 'Equity',
      playbook_id:    trade.playbookId || trade.playbook_id || null,
      initial_stop:   trade.initialStop || trade.initial_stop || null,
      cmp:            trade.cmp || null,
      entries:        trade.entries        || [],
      pyramids:       trade.pyramids       || [],
      partial_exits:  trade.partialExits   || trade.partial_exits  || [],
      final_exit:     trade.finalExit      || trade.final_exit     || null,
      stop_revisions: trade.stopRevisions  || trade.stop_revisions || [],
      alerts:         trade.alerts         || [],
      notes:          trade.notes          || [],
      rule_followed:  trade.ruleFollowed   ?? trade.rule_followed  ?? true,
      rule_break_note:trade.ruleBreakNote  || trade.rule_break_note || null,
      review_status:  trade.reviewStatus   || trade.review_status  || 'Pending',
      rating:         trade.rating         || 0,
      tags:           trade.tags           || [],
      updated_at:     new Date().toISOString(),
    };
  }

  // ── Remaining Qty (synchronous — pure calculation, no DB needed) ──────────
  function getTradeRemainingQty(trade) {
    if (!trade || !trade.entries) return 0;
    const totalEntry    = trade.entries.reduce((s, e) => s + (Number(e.qty) || 0), 0);
    const totalPyramid  = (trade.pyramids || []).reduce((s, p) => s + (Number(p.qty) || 0), 0);
    const totalPartial  = (trade.partialExits || []).reduce((s, p) => s + (Number(p.qty) || 0), 0);
    const finalQty      = trade.finalExit ? (Number(trade.finalExit.qty) || 0) : 0;
    return (totalEntry + totalPyramid) - (totalPartial + finalQty);
  }

  // ════════════════════════════════════════════════════════════════════════
  // CAPITAL
  // ════════════════════════════════════════════════════════════════════════

  async function getCapital() {
    const { data, error } = await _sb().from('capital').select('*').eq('user_id', _uid()).order('date', { ascending: true });
    if (error) { console.error('getCapital:', error); return []; }
    return (data || []).map(r => ({
      id:             r.id,
      date:           r.date,
      type:           r.type,
      amount:         r.amount,
      note:           r.note,
      remarks:        r.note, // map to remarks for UI
      runningBalance: r.running_balance,
    }));
  }

  async function saveCapitalTransaction(txn) {
    const uid = _uid();
    // Calculate running balance
    const existing = await getCapital();
    const isExisting = txn.id && existing.some(c => c.id === txn.id);
    const newTxn = { id: _generateId('cap'), ...txn };
    const allTxns = isExisting
      ? existing.map(c => c.id === txn.id ? { ...c, ...txn } : c)
      : [...existing, newTxn];
      
    allTxns.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    let balance = 0;
    allTxns.forEach(c => {
      if (c.type === 'Deposit' || c.type === 'Adjustment') balance += Number(c.amount);
      else if (c.type === 'Withdrawal') balance -= Number(c.amount);
      c.runningBalance = balance;
    });
    
    // Upsert the target txn (with updated running balance)
    const target = allTxns.find(c => c.id === (txn.id || newTxn.id));
    if (!target) return;
    
    const { error } = await _sb().from('capital').upsert({
      id:              target.id,
      user_id:         uid,
      date:            target.date,
      type:            target.type,
      amount:          target.amount,
      note:            target.remarks || target.note || null,
      running_balance: target.runningBalance,
    }, { onConflict: 'id' });
    
    if (error) { console.error('saveCapitalTransaction:', error); return; }
    // Recalculate all running balances and update in bulk
    await _recalcCapitalBalances();
    _notifyChange('capital');
  }

  async function deleteCapitalTransaction(id) {
    const { error } = await _sb().from('capital').delete().eq('id', id).eq('user_id', _uid());
    if (error) { console.error('deleteCapitalTransaction:', error); return; }
    await _recalcCapitalBalances();
    _notifyChange('capital');
  }

  async function _recalcCapitalBalances() {
    const all = await getCapital();
    all.sort((a, b) => new Date(a.date) - new Date(b.date));
    let balance = 0;
    const updates = all.map(c => {
      if (c.type === 'Deposit' || c.type === 'Adjustment') balance += Number(c.amount);
      else if (c.type === 'Withdrawal') balance -= Number(c.amount);
      return { id: c.id, user_id: _uid(), date: c.date, type: c.type, amount: c.amount, note: c.remarks || c.note, running_balance: balance };
    });
    if (updates.length > 0) {
      await _sb().from('capital').upsert(updates, { onConflict: 'id' });
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PLAYBOOKS
  // ════════════════════════════════════════════════════════════════════════

  async function getPlaybooks() {
    const { data, error } = await _sb().from('playbooks').select('*').eq('user_id', _uid()).order('created_at', { ascending: true });
    if (error) { console.error('getPlaybooks:', error); return []; }
    return (data || []).map(r => ({
      id:             r.id,
      name:           r.name,
      version:        r.version,
      status:         r.status,
      category:       r.category,
      description:    r.description,
      entryRules:     r.entry_rules     || [],
      exitRules:      r.exit_rules      || [],
      riskRules:      r.risk_rules      || [],
      checklist:      r.checklist       || [],
      versionHistory: r.version_history || [],
      createdAt:      r.created_at,
      updatedAt:      r.updated_at,
    }));
  }

  async function getPlaybookById(id) {
    if (!id) return null;
    const { data, error } = await _sb().from('playbooks').select('*').eq('id', id).eq('user_id', _uid()).single();
    if (error || !data) return null;
    return {
      id:             data.id,
      name:           data.name,
      version:        data.version,
      status:         data.status,
      category:       data.category,
      description:    data.description,
      entryRules:     data.entry_rules     || [],
      exitRules:      data.exit_rules      || [],
      riskRules:      data.risk_rules      || [],
      checklist:      data.checklist       || [],
      versionHistory: data.version_history || [],
      createdAt:      data.created_at,
      updatedAt:      data.updated_at,
    };
  }

  async function savePlaybook(pb) {
    const uid = _uid();
    const { error } = await _sb().from('playbooks').upsert({
      id:                  pb.id || _generateId('pb'),
      user_id:             uid,
      name:                pb.name,
      version:             pb.version || '1.0',
      status:              pb.status  || 'Draft',
      category:            pb.category            || null,
      description:         pb.description         || null,
      objective:           pb.objective           || null,
      market_type:         pb.marketType          || null,
      suitable_trend:      pb.suitableTrend       || null,
      risk_category:       pb.riskCategory        || null,
      ideal_holding_period: pb.idealHoldingPeriod || null,
      entry_rules:         pb.entryRules     || pb.entry_rules     || [],
      exit_rules:          pb.exitRules      || pb.exit_rules      || [],
      risk_rules:          pb.riskRules      || pb.risk_rules      || [],
      checklist:           pb.checklist      || [],
      version_history:     pb.versionHistory || pb.version_history || [],
      updated_at:          new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) { console.error('savePlaybook:', error); return; }
    _notifyChange('playbooks');
  }

  // ════════════════════════════════════════════════════════════════════════
  // SETTINGS
  // ════════════════════════════════════════════════════════════════════════

  async function getSettings() {
    const uid = _uid();
    const { data, error } = await _sb().from('settings').select('data').eq('user_id', uid).single();
    if (error || !data) return getDefaultSettings();
    return { ...getDefaultSettings(), ...data.data };
  }

  async function saveSettings(settings) {
    const uid = _uid();
    const { error } = await _sb().from('settings').upsert(
      { user_id: uid, data: settings, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
    if (error) { console.error('saveSettings:', error); return; }
    _notifyChange('settings');
  }

  // ── Market Health (stored inside settings) ────────────────────────────────
  async function getMarketHealth() {
    const s = await getSettings();
    return s.marketHealth || {};
  }

  async function saveMarketHealth(data) {
    const s = await getSettings();
    s.marketHealth = { ...data, lastUpdated: new Date().toISOString().split('T')[0] };
    await saveSettings(s);
  }

  // ════════════════════════════════════════════════════════════════════════
  // EQUITY SNAPSHOTS
  // ════════════════════════════════════════════════════════════════════════

  async function getEquitySnapshots() {
    const { data, error } = await _sb().from('equity_snapshots').select('*').eq('user_id', _uid()).order('date', { ascending: true });
    if (error) { console.error('getEquitySnapshots:', error); return []; }
    return (data || []).map(r => ({ date: r.date, equity: r.equity }));
  }

  async function saveEquitySnapshot(snapshot) {
    const { error } = await _sb().from('equity_snapshots').upsert({
      user_id: _uid(),
      date:    snapshot.date,
      equity:  snapshot.equity,
    }, { onConflict: 'user_id,date' });
    if (error) console.error('saveEquitySnapshot:', error);
  }

  // ════════════════════════════════════════════════════════════════════════
  // SEEDING — Not needed in Phase 2 (cloud data persists)
  // ════════════════════════════════════════════════════════════════════════
  function isSeeded()  { return true; } // Always true in cloud mode
  function markSeeded() {}
  function clearAll()  {} // legacy no-op

  // ── Full account data reset (used by Settings → Reset All Data) ───────────
  // Deletes every row owned by the current user from all Supabase tables.
  async function resetAllData() {
    const uid = _uid();
    if (!uid) throw new Error('Not authenticated');
    const sb = _sb();
    const tables = ['trades', 'capital', 'playbooks', 'settings', 'equity_snapshots'];
    const errors = [];
    for (const table of tables) {
      const { error } = await sb.from(table).delete().eq('user_id', uid);
      if (error) {
        console.warn(`resetAllData: could not clear ${table}:`, error.message);
        errors.push(table);
      }
    }
    return errors; // empty array = full success
  }

  // ── Default Settings ──────────────────────────────────────────────────────
  function getDefaultSettings() {
    return {
      general: {
        traderName: 'Trader', baseCurrency: 'INR',
        timezone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY',
        financialYearStart: 'April', defaultStartupModule: 'dashboard',
        defaultDateRange: 'YTD'
      },
      tradingDefaults: {
        defaultTradeType: 'Equity', defaultDirection: 'Long',
        defaultRPT: 10000, maxOpenPositions: 10,
        defaultReviewStatus: 'Pending', autoOpenAfterSave: true
      },
      riskManagement: {
        maxPortfolioHeat: 4, warningPortfolioHeat: 3.5,
        maxRPT: 15000, riskMode: 'Dynamic', riskPercent: 1,
        fixedRiskAmount: 10000,
        riskColorThresholds: { safe: 2, warning: 3, danger: 4 }
      },
      charges: {
        broker: 'Zerodha',
        equity: { brokerage: 0, stt: 0.001, exchangeCharge: 0.0000335, sebiCharge: 0.000001, gst: 0.18, stampDuty: 0.00015 },
        intraday: { brokerage: 20, brokeragePercent: 0.0003, stt: 0.00025, exchangeCharge: 0.0000335, sebiCharge: 0.000001, gst: 0.18, stampDuty: 0.00003 },
        futures: { brokerage: 20, brokeragePercent: 0.0003, stt: 0.0002, exchangeCharge: 0.00002, sebiCharge: 0.000001, gst: 0.18, stampDuty: 0.00002 }
      },
      alerts: {
        portfolioHeat:  { enabled: true,  severity: 'Warning',  dashboard: true,  popup: true  },
        positionRisk:   { enabled: true,  severity: 'Warning',  dashboard: true,  popup: false },
        stopLossBreach: { enabled: true,  severity: 'Critical', dashboard: true,  popup: true  },
        day5Exit:       { enabled: true,  severity: 'Info',     dashboard: true,  popup: false },
        ruleBreak:      { enabled: true,  severity: 'Warning',  dashboard: true,  popup: false },
        revengeTrade:   { enabled: true,  severity: 'Warning',  dashboard: true,  popup: false },
        ema20Exit:      { enabled: true,  severity: 'Warning',  dashboard: true,  popup: false },
        atrExtension:   { enabled: true,  severity: 'Warning',  dashboard: true,  popup: false }
      },
      marketHealth: {
        trend: 'Uptrend', breadthValue: 0, breadthClassification: 'Neutral',
        guidance: 'Observe', lastUpdated: new Date().toISOString().split('T')[0]
      }
    };
  }

  // ── Utility ───────────────────────────────────────────────────────────────
  function generateId(prefix = 'id') { return _generateId(prefix); }

  return {
    // Trades
    getTrades, getOpenTrades, getClosedTrades, getTradeById, saveTrade, deleteTrade, getTradeRemainingQty,
    // Capital
    getCapital, saveCapitalTransaction, deleteCapitalTransaction,
    // Playbooks
    getPlaybooks, getPlaybookById, savePlaybook,
    // Settings
    getSettings, saveSettings, getDefaultSettings,
    // Market Health
    getMarketHealth, saveMarketHealth,
    // Equity Snapshots
    getEquitySnapshots, saveEquitySnapshot,
    // Compatibility
    isSeeded, markSeeded, clearAll, resetAllData, on, off, generateId,
  };
})();
