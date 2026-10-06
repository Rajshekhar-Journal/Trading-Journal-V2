/**
 * positions.js — Module 02: Positions
 * Open position monitoring, risk management, and trade entry.
 * Fixes: edit/delete lifecycle, unrealized P&L with R, realized P&L,
 *        CMP update (manual + Yahoo Finance), fullscreen panel,
 *        wider split view, alert auto-run, heat validation on pyramid.
 */
const positionsModule = (() => {
  let _selectedTradeId = null;
  let _isFullscreen = false;
  let _cachedSettings = null;
  let _cachedDefRPT = 0;

  // ── CMP / candle fetch helper (Supabase Edge Function proxy) ─────────────
  const SUPABASE_URL = APP_CONFIG.SUPABASE_URL;
  const SUPABASE_KEY = APP_CONFIG.SUPABASE_ANON_KEY;

  async function _fetchLiveCmp(symbol, includeOHLC = false) {
    try {
      // If the symbol already includes a suffix, don't append .NS
      const hasSuffix = symbol.includes('.');
      const ticker = hasSuffix ? encodeURIComponent(symbol) : `${encodeURIComponent(symbol)}.NS`;
      const url = `${SUPABASE_URL}/functions/v1/yahoo-finance?ticker=${ticker}` + (includeOHLC ? '&interval=1d&range=1mo' : '');
      const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data   = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      if (includeOHLC) {
        const timestamps = result.timestamp;
        const ohlcv      = result.indicators.quote[0];
        const candles    = timestamps.map((ts, i) => ({
          time:  ts,
          open:  parseFloat(ohlcv.open[i]?.toFixed(2)  || 0),
          high:  parseFloat(ohlcv.high[i]?.toFixed(2)  || 0),
          low:   parseFloat(ohlcv.low[i]?.toFixed(2)   || 0),
          close: parseFloat(ohlcv.close[i]?.toFixed(2) || 0),
        })).filter(c => c.open && c.high && c.low && c.close);
        return { price: result.meta?.regularMarketPrice || candles[candles.length-1]?.close, candles };
      }
      return result.meta?.regularMarketPrice || null;
    } catch { return null; }
  }

  async function init() {
    // Auto-refresh handles alert engine internally now
    await _renderOverviewCards();
    await _renderTable();
    _setupNewTradeBtn();
    _listenForEngine();
  }

  // ── Live updates come from the Trade Lifecycle runner (js/engine/runner.js) ──
  let _engineListener = null;
  function _listenForEngine() {
    if (_engineListener) return;
    _engineListener = async () => {
      if (!document.getElementById('mod-positions')?.classList.contains('active')) return;
      await _renderOverviewCards();
      if (_selectedTradeId) await _renderDetailPanel(_selectedTradeId);
      else await _renderTable();
    };
    window.addEventListener('tlm:cycle', _engineListener);
  }

  async function _syncNow() {
    app.toast('Running rule engine…', 'info', 1500);
    try {
      const ran = await TLMRunner.runCycle({ force: true });
      if (!ran) app.toast('Nothing to evaluate', 'info');
    } catch (e) { app.toast(e.message, 'error'); }
  }

  /** Mark / dismiss a lifecycle alert from the detail panel. */
  async function _alertAct(alertId, status, tradeId) {
    await db.updateAlert(alertId, status === 'Executed' ? { status, executed_at: new Date().toISOString() } : { status });
    await _renderDetailPanel(tradeId);
  }

  // ── Overview Cards ─────────────────────────────────────────────────────────
  async function _renderOverviewCards() {
    const openTrades  = await db.getOpenTrades();
    const capital     = await db.getCapital();
    const settings    = await db.getSettings();
    const closedTrades= await db.getClosedTrades();
    const realizedPnl = calc.getTotalPnl(closedTrades);
    const equity      = calc.getCurrentEquity(capital, realizedPnl);
    const currentR    = calc.getCurrentR(equity, settings);
    const heat        = calc.getPortfolioHeat(openTrades, equity);   // returns %
    const heatRs      = calc.getPortfolioHeatRs(openTrades);          // absolute ₹
    const maxHeat     = Number(settings?.riskManagement?.maxPortfolioHeat  || 5);  // %
    const warnHeat    = Number(settings?.riskManagement?.warningPortfolioHeat || 3); // %
    const totalExposure = openTrades.reduce((s, t) => s + calc.getTradeMetrics(t).exposure, 0);
    const unrealizedPnl = openTrades.reduce((s, t) => {
      const m = calc.getTradeMetrics(t);
      const cmp = t.cmp || m.avgEntryPrice;
      return s + calc.getUnrealizedPnl(t, cmp);
    }, 0);

    const heatCls = heat >= maxHeat ? 'negative' : heat >= warnHeat ? 'warning' : 'positive';
    const _pct    = v => equity > 0 ? (v / equity * 100).toFixed(1) : '0';  // % of AV helper
    const _s      = v => v >= 0 ? '+' : '';  // sign helper
    const cards = [
      { label: 'Open Positions', value: openTrades.length, sub: 'Currently active', icon: '📊' },
      { label: 'Total Exposure',
        value: `<span class="prv-amt">${calc.formatCurrency(totalExposure)}</span><span class="prv-pct">${_pct(totalExposure)}% AV</span>`,
        sub: `${_pct(totalExposure)}% of equity`, icon: '💼' },
      { label: 'Portfolio Heat',
        value: `${heat.toFixed(2)}% / ${maxHeat}%`,
        sub: `<span class="prv-amt">${calc.formatCurrency(heatRs)} at risk</span><span class="prv-pct">${_pct(heatRs)}% AV at risk</span> • Warn: ${warnHeat}%`,
        icon: '🌡️', cls: heatCls },
      { label: 'Unrealized P&L',
        value: `<span class="prv-amt">${calc.formatCurrency(unrealizedPnl)}</span><span class="prv-pct">${_s(unrealizedPnl)}${_pct(unrealizedPnl)}% AV</span>`,
        sub: 'Based on CMP', icon: '📈', cls: unrealizedPnl >= 0 ? 'positive' : 'negative' },
    ];

    const el = document.getElementById('pos-overview-cards');
    if (!el) return;
    el.innerHTML = cards.map(c => `
      <div class="stat-card">
        <div class="stat-card-icon">${c.icon}</div>
        <div class="stat-card-label">${c.label}</div>
        <div class="stat-card-value">${c.value}</div>
        <div class="stat-card-sub ${c.cls || ''}">${c.sub}</div>
      </div>`).join('');
  }

  // ── Positions Table Sort State ────────────────────────────────────────────
  let _sortState = { col: 'entryDate', dir: 'desc' };

  // ── Positions Table ────────────────────────────────────────────────────────
  async function _renderTable() {
    const tbl = document.getElementById('pos-table');
    if (!tbl) return;
    // Build sortable headers
    const _arrow = col => {
      if (_sortState.col !== col) return '<span style="color:var(--text-muted);font-size:10px;margin-left:3px">↕</span>';
      return _sortState.dir === 'asc'
        ? '<span style="color:#5b6af0;font-size:10px;margin-left:3px">↑</span>'
        : '<span style="color:#5b6af0;font-size:10px;margin-left:3px">↓</span>';
    };
    const _th = (col, label) =>
      `<th data-sort="${col}" style="cursor:pointer;user-select:none;white-space:nowrap" onclick="positionsModule._sortTable('${col}')">${label}${_arrow(col)}</th>`;

    const thead = tbl.querySelector('thead tr');
    if (thead) {
      thead.innerHTML =
        _th('symbol','Symbol') + '<th>Type</th>' + _th('entryDate','Entry Date') + '<th title="Days since entry">Days</th>' +
        '<th>Open Qty</th><th>Avg Entry</th><th>Init Stop</th><th>Curr Stop</th><th>CMP</th>' +
        _th('chgPct','Chg%') + _th('openRisk','Open Risk ₹') +
        _th('exposure','Exposure') + _th('unrealPnl','Unreal. P&L (R)') +
        _th('netPnl','Net P&L') + '<th>Alert</th>';
    }

    const tbody = document.getElementById('pos-table-body');
    if (!tbody) return;
    const openTrades = await db.getOpenTrades();
    const capital    = await db.getCapital();
    const settings   = await db.getSettings();
    const closedTrades = await db.getClosedTrades();
    const realizedPnl  = calc.getTotalPnl(closedTrades);
    const equity       = calc.getCurrentEquity(capital, realizedPnl);

    if (!openTrades.length) {
      tbody.innerHTML = `<tr><td colspan="15"><div class="no-data"><div class="no-data-icon">📭</div>No open positions. Click "+ New Trade" to add one.</div></td></tr>`;
      return;
    }

    // Compute sort key for each trade, then sort
    const withKeys = openTrades.map(trade => {
      const m         = calc.getTradeMetrics(trade, settings);
      const cmp       = trade.cmp || m.avgEntryPrice;
      const unrealPnl = calc.getUnrealizedPnl(trade, cmp);
      const chgPct    = m.avgEntryPrice > 0 ? ((cmp - m.avgEntryPrice) / m.avgEntryPrice * 100) : 0;
      const exposurePct = equity > 0 ? (m.exposure / equity * 100) : 0;
      const netPnl      = m.realizedPnl || 0;
      const riskPct      = equity > 0 ? (m.currentRisk / equity * 100) : 0;
      const unrealPct    = equity > 0 ? (unrealPnl / equity * 100) : 0;
      const netPct       = equity > 0 ? (netPnl / equity * 100) : 0;
      const entryDate    = trade.entries?.[0]?.date || trade.createdAt || '';
      return { trade, m, cmp, unrealPnl, chgPct, exposurePct, riskPct, unrealPct, netPct, netPnl, entryDate };
    });

    withKeys.sort((a, b) => {
      let va, vb;
      switch (_sortState.col) {
        case 'symbol':    va = a.trade.symbol; vb = b.trade.symbol; break;
        case 'entryDate': va = a.entryDate;    vb = b.entryDate;    break;
        case 'chgPct':    va = a.chgPct;       vb = b.chgPct;       break;
        case 'openRisk':  va = a.m.currentRisk; vb = b.m.currentRisk; break;
        case 'exposure':  va = a.m.exposure;   vb = b.m.exposure;   break;
        case 'unrealPnl': va = a.unrealPnl;    vb = b.unrealPnl;    break;
        case 'netPnl':    va = a.m.realizedPnl; vb = b.m.realizedPnl; break;
        default:          va = a.entryDate;    vb = b.entryDate;
      }
      const cmp_ = typeof va === 'string' ? va.localeCompare(vb) : (va - vb);
      return _sortState.dir === 'asc' ? cmp_ : -cmp_;
    });

    const pending = {};
    (await db.getAlerts({ limit: 300 })).filter(a => a.mode === 'real' && a.status === 'New').forEach(a => { pending[a.trade_id] = (pending[a.trade_id] || 0) + 1; });
    tbody.innerHTML = withKeys.map(({ trade, m, cmp, unrealPnl, chgPct,
      exposurePct, riskPct, unrealPct, netPct, netPnl }) => {
      const unrealR   = m.trueRPT > 0 ? (unrealPnl / m.trueRPT) : 0;
      const stage     = TLMPanel.stateOf(trade);
      const alertBadge= (stage ? `<span class="tlm-stage">${TLMRules.stageLabel(stage)}</span> ` : '')
        + (pending[trade.id] ? `<span class="badge badge-warning">⚠ ${pending[trade.id]}</span>` : '');
      const pnlCls    = unrealPnl >= 0 ? 'text-success' : 'text-danger';
      const riskRCls  = m.currentRisk >= 0 ? 'text-success'
        : Math.abs(m.currentRisk) > m.trueRPT ? 'text-danger'
        : 'text-warning';
      const chgCls    = chgPct >= 0 ? 'text-success' : 'text-danger';
      const symColor  = cmp >= m.avgEntryPrice ? 'text-success' : 'text-danger';
      const _s        = v => v >= 0 ? '+' : '';   // sign helper
      const pIS  = calc.pctFromEntry(trade.initialStop, m.avgEntryPrice, trade.direction);
      const pCS  = calc.pctFromEntry(m.currentStop,     m.avgEntryPrice, trade.direction);
      const pCMP = calc.pctFromEntry(cmp,               m.avgEntryPrice, trade.direction);
      return `<tr data-id="${trade.id}" onclick="positionsModule._onRowClick('${trade.id}')">
        <td><strong class="${symColor}">${trade.symbol}</strong> <span class="badge badge-muted" style="font-size:10px">${trade.direction}</span></td>
        <td><span class="badge badge-muted">${trade.tradeType}</span></td>
        <td>${calc.formatDate(trade.entries?.[0]?.date || '')}</td>
        <td class="font-mono text-muted" style="font-size:12px">${m.tradingDays}d</td>
        <td class="font-mono"><span class="prv-blur">${m.openQty}</span></td>
        <td class="font-mono">₹${calc.formatNumber(m.avgEntryPrice)}</td>
        <td class="font-mono">₹${calc.formatNumber(trade.initialStop)}<div class="entry-pct ${pIS.cls}">${pIS.str}</div></td>
        <td class="font-mono">₹${calc.formatNumber(m.currentStop)}<div class="entry-pct ${pCS.cls}">${pCS.str}</div></td>
        <td class="font-mono" data-cmp-cell="${trade.id}" style="cursor:pointer" onclick="event.stopPropagation();positionsModule._showCmpModal('${trade.id}')" title="Click to update CMP">
          ₹${calc.formatNumber(cmp)} <span style="color:#5b6af0;font-size:10px">✎</span>
          <div class="entry-pct ${pCMP.cls}">${pCMP.str}</div></td>
        <td class="${chgCls} font-mono">${_s(chgPct)}${chgPct.toFixed(1)}%</td>
        <td class="${riskRCls} font-mono">
          <span class="prv-amt">${calc.formatCurrency(m.currentRisk)}</span>
          <span class="prv-pct">${_s(riskPct)}${Math.abs(riskPct).toFixed(1)}% AV</span></td>
        <td class="font-mono">
          <span class="prv-amt">${calc.formatCurrency(m.exposure)}&nbsp;</span>
          (${exposurePct.toFixed(1)}% AV)</td>
        <td class="${pnlCls} font-mono fw-600">
          <span class="prv-amt">${calc.formatCurrency(unrealPnl)} <span style="font-size:11px">(${_s(unrealR)}${unrealR.toFixed(2)}R)</span></span>
          <span class="prv-pct">${_s(unrealPct)}${unrealPct.toFixed(2)}% AV</span></td>
        <td class="${netPnl >= 0 ? 'text-success' : netPnl < 0 ? 'text-danger' : 'text-muted'} font-mono">
          <span class="prv-amt">${calc.formatCurrency(netPnl)}</span>
          <span class="prv-pct">${_s(netPct)}${netPct.toFixed(2)}% AV</span></td>
        <td>${alertBadge}</td>
      </tr>`;
    }).join('');
  }


  // ── Column Sort Handler ────────────────────────────────────────────────────
  function _sortTable(col) {
    if (_sortState.col === col) {
      // Same column — toggle direction
      _sortState.dir = _sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      // New column — default to descending
      _sortState.col = col;
      _sortState.dir = 'desc';
    }
    _renderTable();
  }

  async function _onRowClick(id) {
    _selectedTradeId = id;
    document.querySelectorAll('#pos-table-body tr').forEach(r => r.classList.remove('selected'));
    document.querySelector(`#pos-table-body tr[data-id="${id}"]`)?.classList.add('selected');
    await _renderDetailPanel(id);
  }

  // ── Detail Panel ───────────────────────────────────────────────────────────
  async function _renderDetailPanel(tradeId) {
    const panel = document.getElementById('pos-detail-panel');
    if (!panel) return;
    panel.classList.remove('hidden');

    // Make split view 50/50
    const splitView = document.getElementById('pos-split-view');
    if (splitView) {
      splitView.querySelector('.split-left')?.setAttribute('style', 'flex:1.05');
      splitView.querySelector('.split-right')?.setAttribute('style', 'flex:1');
    }

    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const m         = calc.getTradeMetrics(trade);
    const cmp       = trade.cmp || m.avgEntryPrice;
    const unrealPnl = calc.getUnrealizedPnl(trade, cmp);
    const unrealR   = m.trueRPT > 0 ? (unrealPnl / m.trueRPT) : 0;
    // Fetch equity for Exposure % of AV
    const _cap    = await db.getCapital();
    const _closed = await db.getClosedTrades();
    const equity  = calc.getCurrentEquity(_cap, calc.getTotalPnl(_closed));
    const dirBadge  = `<span class="badge ${trade.direction === 'Long' ? 'badge-success' : 'badge-danger'}">${trade.direction}</span>`;
    const openAlerts = (await db.getAlerts({ limit: 300 })).filter(a => a.trade_id === tradeId && a.status === 'New');
    const alertHtml = openAlerts.map(a => `
        <div class="tlm-alert ${a.rule_id === 'LC-09' ? 'critical' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <strong>${a.alert_type}</strong>
            <span style="font-size:11px;color:var(--text-muted)">${new Date(a.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <pre>${a.message || ''}</pre>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" onclick="positionsModule._alertAct('${a.id}','Executed','${tradeId}')">✓ Mark executed</button>
            <button class="btn btn-sm btn-secondary" onclick="positionsModule._alertAct('${a.id}','Dismissed','${tradeId}')">Dismiss</button>
          </div>
        </div>`).join('');
    const playbook  = await db.getPlaybookById(trade.playbookId);

    panel.innerHTML = `
      <div class="detail-panel">
        <div class="detail-panel-header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="detail-symbol">${trade.symbol}</span>
              ${dirBadge}
              <span class="badge badge-muted">${trade.tradeType}</span>
              <span class="badge badge-muted" style="font-size:10px;">${trade.exchange || 'NSE'}</span>
            </div>
            <div class="detail-sub">${m.holdingDays} days held (trading days: ${m.tradingDays}) · Entry: ${calc.formatDate(trade.entries?.[0]?.date)} · Playbook: ${playbook?.name || '—'}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;" id="pos-panel-btns">
            <button class="btn btn-secondary btn-sm" id="pos-fs-btn"
              onclick="positionsModule._toggleFullscreen()"
              title="Full Screen — hides position table">
              ⛶
            </button>
            <button class="btn btn-secondary btn-sm" onclick="positionsModule._showEditTradeModal('${tradeId}')" title="Edit Trade">Edit Trade</button>
            <button class="btn btn-danger btn-sm" onclick="positionsModule._deleteTrade('${tradeId}')" title="Delete Trade">Delete Trade</button>
            <button class="detail-close-btn" onclick="positionsModule._closePanel()" title="Close panel — return to position table">✕</button>
          </div>
        </div>
        <div class="detail-panel-body">
          ${alertHtml}
          <div class="metric-grid">
            <div class="metric-item"><div class="metric-label">Avg Entry</div><div class="metric-value">₹${calc.formatNumber(m.avgEntryPrice)}</div></div>
            <div class="metric-item">
              <div class="metric-label">CMP <span style="color:#5b6af0;font-size:10px;cursor:pointer" onclick="positionsModule._showCmpModal('${tradeId}')">✎ Update</span></div>
              <div class="metric-value">₹${calc.formatNumber(cmp)}<div class="entry-pct ${calc.pctFromEntry(cmp, m.avgEntryPrice, trade.direction).cls}">${calc.pctFromEntry(cmp, m.avgEntryPrice, trade.direction).str}</div></div>
            </div>
            ${m.avgExitPrice > 0 ? `<div class="metric-item"><div class="metric-label">Avg Exit</div><div class="metric-value">₹${calc.formatNumber(m.avgExitPrice)}<div class="entry-pct ${calc.pctFromEntry(m.avgExitPrice, m.avgEntryPrice, trade.direction).cls}">${calc.pctFromEntry(m.avgExitPrice, m.avgEntryPrice, trade.direction).str}</div></div></div>` : ''}
            <div class="metric-item"><div class="metric-label">Initial Stop</div><div class="metric-value">₹${calc.formatNumber(trade.initialStop)}<div class="entry-pct ${calc.pctFromEntry(trade.initialStop, m.avgEntryPrice, trade.direction).cls}">${calc.pctFromEntry(trade.initialStop, m.avgEntryPrice, trade.direction).str}</div></div></div>
            <div class="metric-item"><div class="metric-label">Current Stop</div><div class="metric-value">₹${calc.formatNumber(m.currentStop)}<div class="entry-pct ${calc.pctFromEntry(m.currentStop, m.avgEntryPrice, trade.direction).cls}">${calc.pctFromEntry(m.currentStop, m.avgEntryPrice, trade.direction).str}</div></div></div>
            <div class="metric-item"><div class="metric-label">Open Qty</div><div class="metric-value"><span class="prv-blur">${m.openQty}</span></div></div>
            <div class="metric-item"><div class="metric-label">Exposure</div><div class="metric-value">
              <span class="prv-amt">${calc.formatCurrency(m.exposure)}</span>
              <span class="prv-pct">${equity > 0 ? (m.exposure/equity*100).toFixed(1) : 0}% AV</span>
              <span style="display:block;font-size:11px;font-weight:400;color:var(--text-muted)">${equity > 0 ? (m.exposure/equity*100).toFixed(1) : 0}% of AV</span></div></div>
            <div class="metric-item"><div class="metric-label">RPT</div><div class="metric-value">
              <span class="prv-blur">₹${calc.formatNumber(m.trueRPT)}</span></div></div>
            <div class="metric-item"><div class="metric-label">Open Risk ₹</div><div class="metric-value ${m.currentRisk >= 0 ? 'positive' : Math.abs(m.currentRisk) > m.trueRPT ? 'negative' : 'text-warning'}">
              <span class="prv-amt">${calc.formatCurrency(m.currentRisk)}</span>
              <span class="prv-pct">${m.currentRisk >= 0 ? '+' : ''}${equity > 0 ? (m.currentRisk/equity*100).toFixed(2) : 0}% AV</span></div></div>
            <div class="metric-item"><div class="metric-label">Unreal. P&L</div><div class="metric-value ${unrealPnl >= 0 ? 'positive' : 'negative'}">
              <span class="prv-amt">${calc.formatCurrency(unrealPnl)} <span style="font-size:11px">(${unrealR >= 0 ? '+' : ''}${unrealR.toFixed(2)}R)</span></span>
              <span class="prv-pct">${unrealPnl >= 0 ? '+' : ''}${equity > 0 ? (unrealPnl/equity*100).toFixed(2) : 0}% AV</span></div></div>
            <div class="metric-item"><div class="metric-label">Realized P&L</div><div class="metric-value ${m.realizedPnl >= 0 ? 'positive' : m.realizedPnl < 0 ? 'negative' : ''}">
              <span class="prv-amt">${calc.formatCurrency(m.realizedPnl || 0)} <span style="font-size:11px">(${calc.formatR(m.profitR)})</span></span>
              <span class="prv-pct">${(m.realizedPnl||0) >= 0 ? '+' : ''}${equity > 0 ? ((m.realizedPnl||0)/equity*100).toFixed(2) : 0}% AV</span></div></div>
          </div>


          <div class="card tlm-card" style="padding:12px;margin:12px 0">${TLMPanel.html(trade)}</div>

          <div class="quick-actions">
            <button class="quick-action-btn exit" onclick="positionsModule._showExitModal('${tradeId}', 'partial')">Partial Exit</button>
            <button class="quick-action-btn exit" onclick="positionsModule._showExitModal('${tradeId}', 'final')">Final Exit</button>
            <button class="quick-action-btn pyramid" onclick="positionsModule._showPyramidModal('${tradeId}')">Pyramid</button>
            <button class="quick-action-btn" onclick="positionsModule._showStopModal('${tradeId}')">Revise Stop</button>
            <button class="quick-action-btn" onclick="positionsModule._showNoteModal('${tradeId}')">Add Note</button>
            <button class="quick-action-btn" onclick="positionsModule._showCmpModal('${tradeId}')" style="background:#e0e7ff;color:#5b6af0">Update CMP</button>
          </div>

          <div class="detail-tab-bar">
            <button class="detail-tab-btn active" data-dtab="lifecycle">Lifecycle</button>
            <button class="detail-tab-btn" data-dtab="stops">Stop History</button>
            <button class="detail-tab-btn" data-dtab="notes">Notes</button>
            <button class="detail-tab-btn" data-dtab="chart">Chart</button>
          </div>
          <div id="pos-dtab-content">${_renderLifecycleTab(trade)}</div>
        </div>
      </div>`;

    panel.querySelectorAll('.detail-tab-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        panel.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const t  = await db.getTradeById(tradeId);
        const tc = document.getElementById('pos-dtab-content');
        if (!tc) return;
        if (btn.dataset.dtab === 'lifecycle') tc.innerHTML = _renderLifecycleTab(t);
        else if (btn.dataset.dtab === 'stops')     tc.innerHTML = _renderStopsTab(t);
        else if (btn.dataset.dtab === 'notes')     tc.innerHTML = _renderNotesTab(t);
        else if (btn.dataset.dtab === 'chart')     tc.innerHTML = _renderChartTab(t);
      });
    });

    TLMPanel.loadSnapshots(trade);

    // Restore fullscreen state if we are currently in fullscreen (panel HTML was just rebuilt)
    if (_isFullscreen) {
      const fsBtn      = document.getElementById('pos-fs-btn');
      const tablePanel = document.getElementById('pos-table-panel');
      const splitView  = document.getElementById('pos-split-view');
      if (tablePanel) tablePanel.style.display = 'none';  // forceful hide
      panel.style.cssText = 'flex:1;min-width:0;width:100%;';
      if (splitView)  splitView.style.cssText  = 'height:calc(100vh - 200px);';
      if (fsBtn)      { fsBtn.textContent = '\u229F'; fsBtn.title = 'Minimize — return to split view'; }
    }
  }

  // ── Lifecycle Tab with Edit/Delete ─────────────────────────────────────────
  function _renderLifecycleTab(trade) {
    const m   = calc.getTradeMetrics(trade);
    const rows = [];

    // Track running avg entry for per-row profit calculation
    let runCost = 0, runQty = 0;

    // Build rows with extra computed fields
    const allBuys = [
      ...(trade.entries  || []).map(e => ({ ...e, rowType:'Entry' })),
      ...(trade.pyramids || []).map(p => ({ ...p, rowType:'Pyramid' })),
    ].sort((a,b) => (a.date||'').localeCompare(b.date||''));

    const allSells = [
      ...(trade.partialExits || []).map(p => ({ ...p, rowType:'Partial Exit' })),
      ...(trade.finalExit ? [{ ...trade.finalExit, id: trade.finalExit.id||'fe', rowType:'Final Exit' }] : []),
    ].sort((a,b) => (a.date||'').localeCompare(b.date||''));

    // Combine all into one sorted list
    const allRows = [
      ...allBuys.map(r => ({ ...r, isBuy: true  })),
      ...allSells.map(r => ({ ...r, isBuy: false })),
    ].sort((a,b) => (a.date||'').localeCompare(b.date||''));

    for (const r of allRows) {
      let profit = 0, rMult = 0;
      if (r.isBuy) {
        runCost += Number(r.price) * Number(r.qty);
        runQty  += Number(r.qty);
      } else {
        const avgEntry = runQty > 0 ? runCost / runQty : m.avgEntryPrice;
        const grossP   = trade.direction === 'Long'
          ? (Number(r.price) - avgEntry) * Number(r.qty)
          : (avgEntry - Number(r.price)) * Number(r.qty);
        profit = grossP;
        const riskPerShare = avgEntry - Number(trade.initialStop || 0);
        rMult  = riskPerShare !== 0 ? (Number(r.price) - avgEntry) / Math.abs(riskPerShare) : 0;
      }

      const typeBadge = r.rowType.includes('Exit') ? 'badge-danger' : r.rowType === 'Pyramid' ? 'badge-success' : 'badge-primary';
      const profitCls = profit > 0 ? 'text-success' : profit < 0 ? 'text-danger' : '';
      const rMultCls  = rMult  > 0 ? 'text-success' : rMult  < 0 ? 'text-danger' : '';

      rows.push(`<tr>
        <td><span class="badge ${typeBadge}">${r.rowType}</span></td>
        <td>${calc.formatDate(r.date)}</td>
        <td class="font-mono">₹${calc.formatNumber(r.price)}</td>
        <td>${r.qty}</td>
        <td class="font-mono">₹${calc.formatNumber(r.charges||0)}</td>
        <td class="font-mono ${profitCls}">${r.isBuy ? '—' : calc.formatCurrency(profit)}</td>
        <td class="font-mono ${rMultCls}">${r.isBuy ? '—' : rMult.toFixed(2)+'R'}</td>
        <td>
          <button class="btn btn-secondary btn-xs" title="Edit" onclick="positionsModule._editLifecycleRow('${trade.id}','${r.rowType}','${r.id}')">✏</button>
          <button class="btn btn-danger btn-xs" title="Delete" onclick="positionsModule._deleteLifecycleRow('${trade.id}','${r.rowType}','${r.id}')">🗑</button>
        </td>
      </tr>`);
    }

    if (!rows.length) return `<div class="no-data">No transactions recorded.</div>`;

    return `<table class="data-table">
      <thead><tr><th>Type</th><th>Date</th><th>Price</th><th>Qty</th><th>Charges</th><th>Profit</th><th>R Multiple</th><th style="width:70px">Actions</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
      <tfoot><tr>
        <td colspan="5" style="font-size:12px;color:var(--text-muted)">Net Realized P&amp;L (incl. all charges)</td>
        <td colspan="3" class="font-mono fw-600 ${m.realizedPnl >= 0 ? 'text-success' : 'text-danger'}">${calc.formatCurrency(m.realizedPnl||0)} (${calc.formatR(m.profitR||0)})</td>
      </tr></tfoot>
    </table>`;
  }

  // ── Delete Lifecycle Record ────────────────────────────────────────────────
  async function _deleteLifecycleRow(tradeId, type, recordId) {
    if (!confirm(`Delete this ${type} record? This will recalculate all metrics.`)) return;
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const updated = { ...trade };
    if (type === 'Entry') {
      if ((trade.entries||[]).length <= 1) { app.toast('Cannot delete the only entry record. Delete the entire trade instead.', 'error'); return; }
      updated.entries = trade.entries.filter(e => e.id !== recordId);
    } else if (type === 'Pyramid') {
      updated.pyramids = (trade.pyramids||[]).filter(p => p.id !== recordId);
    } else if (type === 'Partial Exit') {
      updated.partialExits = (trade.partialExits||[]).filter(p => p.id !== recordId);
    } else if (type === 'Final Exit') {
      updated.finalExit = null;
    }
    await db.saveTrade(updated);
    app.toast(`${type} record deleted and metrics recalculated.`, 'success');
    await init();
    await _renderDetailPanel(tradeId);
  }

  // ── Edit Lifecycle Record ──────────────────────────────────────────────────
  async function _editLifecycleRow(tradeId, type, recordId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    let record;
    if (type === 'Entry')        record = (trade.entries||[]).find(e => e.id === recordId);
    else if (type === 'Pyramid') record = (trade.pyramids||[]).find(p => p.id === recordId);
    else if (type === 'Partial Exit') record = (trade.partialExits||[]).find(p => p.id === recordId);
    else if (type === 'Final Exit')   record = trade.finalExit;
    if (!record) return;

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="el-date" value="${record.date}"></div>
      <div class="form-group"><label class="form-label">Price (₹)</label><input class="form-input" type="number" id="el-price" step="0.05" value="${record.price}"></div>
      <div class="form-group"><label class="form-label">Qty</label><input class="form-input" type="number" id="el-qty" min="1" value="${record.qty}"></div>
      <div class="form-group"><label class="form-label">Charges (₹)</label><input class="form-input" type="number" id="el-charges" step="0.01" value="${record.charges||0}"></div>
    </div>`;
    app.openModal(`Edit ${type} — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save',   label:'Save & Recalculate', class:'btn-primary', onClick: async () => {
        const date    = document.getElementById('el-date').value;
        const price   = parseFloat(document.getElementById('el-price').value);
        const qty     = parseInt(document.getElementById('el-qty').value);
        const charges = parseFloat(document.getElementById('el-charges').value) || 0;
        if (!date || !price || !qty) { app.toast('Please fill all fields', 'error'); return; }
        const updated = { ...trade };
        const updRec  = { ...record, date, price, qty, charges };
        if (type === 'Entry')         updated.entries      = (trade.entries||[]).map(e => e.id===recordId ? updRec : e);
        else if (type === 'Pyramid')  updated.pyramids     = (trade.pyramids||[]).map(p => p.id===recordId ? updRec : p);
        else if (type === 'Partial Exit') updated.partialExits = (trade.partialExits||[]).map(p => p.id===recordId ? updRec : p);
        else if (type === 'Final Exit')   updated.finalExit = updRec;
        await db.saveTrade(updated);
        app.closeModal();
        app.toast(`${type} updated — metrics recalculated.`, 'success');
        await init();
        await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  // ── CMP Update Modal (manual + Yahoo Finance) ─────────────────────────────
  async function _showCmpModal(tradeId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const curCmp = trade.cmp || calc.getTradeMetrics(trade).avgEntryPrice;
    const content = `<div>
      <div class="form-group">
        <label class="form-label">Current Market Price (₹) for ${trade.symbol}</label>
        <input class="form-input" type="number" id="cmp-value" step="0.05" value="${curCmp}" placeholder="Enter CMP manually">
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" id="btn-fetch-price">🔍 Fetch from Yahoo Finance (NSE)</button>
        <span id="cmp-fetch-status" style="font-size:12px;color:var(--text-muted)"></span>
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">
        ℹ Phase 1: Manual entry. If Yahoo fetch fails (CORS), enter price from NSE/Zerodha manually.<br>
        <a href="https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(trade.symbol)}" target="_blank" style="color:#5b6af0">Open NSE Quote ↗</a>
      </div>
    </div>`;
    app.openModal(`Update CMP — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save', label:'Update CMP', class:'btn-primary', onClick: async () => {
        const newCmp = parseFloat(document.getElementById('cmp-value').value);
        if (!newCmp || newCmp <= 0) { app.toast('Enter a valid price', 'error'); return; }
        await db.saveTrade({ ...trade, cmp: newCmp });
        app.closeModal();
        app.toast(`CMP updated: ₹${calc.formatNumber(newCmp)}`, 'success');
        await init();
        if (_selectedTradeId === tradeId) await _renderDetailPanel(tradeId);
      }}
    ]);

    // Attach Yahoo Finance fetch button (via Supabase Edge Function proxy — no CORS issues)
    setTimeout(() => {
      document.getElementById('btn-fetch-price')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('cmp-fetch-status');
        statusEl.textContent = '⏳ Fetching...';
        try {
          // Use Supabase Edge Function proxy to avoid CORS
          const SUPABASE_URL = APP_CONFIG.SUPABASE_URL;
          const SUPABASE_KEY = APP_CONFIG.SUPABASE_ANON_KEY;
          const ticker = `${encodeURIComponent(trade.symbol)}.NS`;
          const url = `${SUPABASE_URL}/functions/v1/yahoo-finance?ticker=${ticker}&interval=1d&range=1d`;
          const resp = await fetch(url, {
            headers: {
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json'
            }
          });
          if (!resp.ok) throw new Error('Network error');
          const data = await resp.json();
          const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (price) {
            document.getElementById('cmp-value').value = price.toFixed(2);
            statusEl.textContent = `✅ Fetched: ₹${price.toFixed(2)}`;
          } else {
            statusEl.textContent = '❌ Price not found. Enter manually.';
          }
        } catch(e) {
          statusEl.textContent = `❌ Fetch failed: ${e.message}. Enter manually.`;
        }
      });
    }, 50);
  }

  function _renderStopsTab(trade) {
    const stops = trade.stopRevisions || [];
    if (!stops.length) return `<div class="no-data">No stop revisions recorded.</div>`;
    return `<div>
      <table class="lc-table" style="width:100%">
        <thead><tr>
          <th>Rev</th><th>Date</th><th>From</th><th></th><th>To</th><th>Source</th><th>Notes</th><th>Actions</th>
        </tr></thead>
        <tbody>
        ${stops.map((s, i) => `<tr>
          <td><span class="badge badge-muted">Rev ${i+1}</span></td>
          <td>${calc.formatDate(s.date)}</td>
          <td class="font-mono">₹${calc.formatNumber(s.oldStop)}</td>
          <td><span class="stop-arrow">→</span></td>
          <td class="font-mono fw-600">₹${calc.formatNumber(s.newStop)}</td>
          <td><span class="badge badge-muted">${s.actionSource || '—'}</span></td>
          <td style="font-size:11px;color:var(--text-muted);max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${s.notes||''}">${
            s.notes ? s.notes : '—'
          }</td>
          <td>
            <button class="btn btn-secondary btn-xs" title="Edit" onclick="positionsModule._editStopRow('${trade.id}','${s.id || i}')">✏</button>
            <button class="btn btn-danger btn-xs" title="Delete" onclick="positionsModule._deleteStopRow('${trade.id}','${s.id || i}')">🗑</button>
          </td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // ── Edit Stop Revision ────────────────────────────────────────────────────
  async function _editStopRow(tradeId, recordId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const stops = trade.stopRevisions || [];
    // Find by id or index fallback
    const idx = stops.findIndex(s => s.id === recordId || String(stops.indexOf(s)) === String(recordId));
    if (idx === -1) { app.toast('Stop record not found', 'error'); return; }
    const s = stops[idx];

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Date</label>
        <input class="form-input" type="date" id="sr-date" value="${s.date || ''}"></div>
      <div class="form-group"><label class="form-label">From Stop (₹)</label>
        <input class="form-input" type="number" id="sr-old" step="0.05" value="${s.oldStop || 0}"></div>
      <div class="form-group"><label class="form-label">To Stop (₹) *</label>
        <input class="form-input" type="number" id="sr-new" step="0.05" value="${s.newStop || 0}"></div>
      <div class="form-group"><label class="form-label">Source</label>
        <select class="form-select" id="sr-source">
          <option ${(s.actionSource||'Manual')==='Manual'?'selected':''}>Manual</option>
          <option ${s.actionSource==='System'?'selected':''}>System</option>
          <option ${s.actionSource==='ATR'?'selected':''}>ATR</option>
          <option ${s.actionSource==='Breakeven'?'selected':''}>Breakeven</option>
          <option ${s.actionSource==='Trailing'?'selected':''}>Trailing</option>
        </select></div>
      <div class="form-group form-full"><label class="form-label">Notes</label>
        <input class="form-input" id="sr-notes" value="${s.notes || ''}"></div>
    </div>`;

    app.openModal(`Edit Stop Revision — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save',   label:'Save Changes', class:'btn-primary', onClick: async () => {
        const date    = document.getElementById('sr-date').value;
        const oldStop = parseFloat(document.getElementById('sr-old').value) || 0;
        const newStop = parseFloat(document.getElementById('sr-new').value);
        const source  = document.getElementById('sr-source').value;
        const notes   = document.getElementById('sr-notes').value.trim();
        if (!date || !newStop) { app.toast('Date and New Stop are required', 'error'); return; }
        const updatedStop = { ...s, date, oldStop, newStop, actionSource: source, notes };
        const updatedStops = stops.map((sr, i2) => i2 === idx ? updatedStop : sr);
        // If this is the last revision, also update trade.currentStop
        const isLast = idx === stops.length - 1;
        const updated = { ...trade, stopRevisions: updatedStops };
        if (isLast) updated.currentStop = newStop;
        await db.saveTrade(updated);
        app.closeModal();
        app.toast('Stop revision updated', 'success');
        await init();
        await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  // ── Delete Stop Revision ──────────────────────────────────────────────────
  async function _deleteStopRow(tradeId, recordId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const stops = trade.stopRevisions || [];
    const idx = stops.findIndex(s => s.id === recordId || String(stops.indexOf(s)) === String(recordId));
    if (idx === -1) { app.toast('Stop record not found', 'error'); return; }
    if (stops.length <= 1) { app.toast('Cannot delete the initial stop. Edit it instead.', 'error'); return; }
    if (!confirm('Delete this stop revision? currentStop will revert to the previous revision.')) return;
    const updatedStops = stops.filter((_, i2) => i2 !== idx);
    const newCurrentStop = updatedStops[updatedStops.length - 1]?.newStop || trade.initialStop || 0;
    const updated = { ...trade, stopRevisions: updatedStops, currentStop: newCurrentStop };
    await db.saveTrade(updated);
    app.toast('Stop revision deleted. Current stop reverted.', 'success');
    await init();
    await _renderDetailPanel(tradeId);
  }

  function _renderNotesTab(trade) {
    const notes = trade.notes || [];
    return `<div>
      ${notes.length ? notes.map(n => `<div class="note-item"><div class="note-date">${calc.formatDate(n.date)}</div><div class="note-text">${n.text}</div></div>`).join('') : `<div class="no-data" style="padding:20px 0">No notes yet.</div>`}
    </div>`;
  }

  function _renderChartTab(trade) {
    const symbol = trade.symbol;
    const m      = calc.getTradeMetrics(trade);
    const cmp    = trade.cmp || m.avgEntryPrice;
    
    // Build TradingView symbol — prefer BSE for BSE-listed stocks, else NSE
    const exchange = trade.exchange === 'BSE' ? 'BSE' : 'NSE';
    const tvSymbol = `${exchange}:${symbol}`;
    const nseUrl   = `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`;

    // Render the container HTML first; chart is drawn after DOM is ready
    setTimeout(() => _drawLightweightChart(trade, symbol, m, cmp), 80);

    return `
      <div style="background:#0f172a;border-radius:12px;padding:12px;margin-top:4px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div style="color:#e2e8f0;font-weight:600;font-size:14px;">📈 ${symbol} — Daily Chart</div>
          <div style="display:flex;gap:6px;">
            <span id="chart-status-${symbol}" style="font-size:11px;color:#64748b;">⏳ Loading data...</span>
          </div>
        </div>
        <div id="lw-chart-${symbol}" style="width:100%;height:320px;border-radius:8px;overflow:hidden;"></div>
        <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
          <span style="font-size:11px;color:#22c55e;">━ Entry ₹${calc.formatNumber(m.avgEntryPrice)}</span>
          <span style="font-size:11px;color:#ef4444;">━ Stop ₹${calc.formatNumber(m.currentStop)}</span>
          <span style="font-size:11px;color:#f59e0b;">━ CMP ₹${calc.formatNumber(cmp)}</span>
          <div style="margin-left:auto;display:flex;gap:6px;">
            <a href="https://www.tradingview.com/chart/?symbol=${tvSymbol}" target="_blank" class="btn btn-secondary btn-sm">🔗 TradingView (${exchange})</a>
            <a href="${nseUrl}" target="_blank" class="btn btn-secondary btn-sm">📊 NSE</a>
          </div>
        </div>
      </div>`;
  }

  async function _drawLightweightChart(trade, symbol, m, cmp) {
    const container = document.getElementById(`lw-chart-${symbol}`);
    const statusEl  = document.getElementById(`chart-status-${symbol}`);
    if (!container || typeof LightweightCharts === 'undefined') return;

    // Create chart
    const chart = LightweightCharts.createChart(container, {
      width:  container.clientWidth,
      height: 320,
      layout: { background: { color: '#0f172a' }, textColor: '#94a3b8' },
      grid:   { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: false },
    });

    // Hollow candle series — body color driven by close vs prev close
    const candleSeries = chart.addCandlestickSeries({
      upColor:        'rgba(0,0,0,0)', // hollow body for up candles
      downColor:      '#ef4444',       // filled body for down candles
      borderUpColor:  '#22c55e',
      borderDownColor:'#ef4444',
      wickUpColor:    '#22c55e',
      wickDownColor:  '#ef4444',
    });

    // Fetch OHLC data — try NSE (.NS) first, fallback to BSE (.BO)
    const tryFetch = async (suffix) => {
      const ticker = `${encodeURIComponent(symbol)}${suffix}`;
      const url    = `${SUPABASE_URL}/functions/v1/yahoo-finance?ticker=${ticker}&interval=1d&range=2y`;
      const resp   = await fetch(url, { headers: { 'Authorization': `Bearer ${SUPABASE_KEY}` } });
      const data   = await resp.json();
      return data?.chart?.result?.[0] || null;
    };

    try {
      let result = await tryFetch('.NS');
      if (!result) {
        if (statusEl) statusEl.textContent = '⏳ NSE data empty — trying BSE...';
        result = await tryFetch('.BO');
      }

      if (result) {
        const timestamps = result.timestamp;
        const ohlcv      = result.indicators.quote[0];

        // Build hollow candles: color = close vs PREVIOUS close (not open)
        const rawCandles = timestamps.map((ts, i) => {
          const o = ohlcv.open[i],  h = ohlcv.high[i];
          const l = ohlcv.low[i],   c = ohlcv.close[i];
          if (!o || !h || !l || !c) return null;
          const prevClose = i > 0 ? ohlcv.close[i - 1] : c;
          const isUp      = c >= prevClose;
          return {
            time:        new Date(ts * 1000).toISOString().split('T')[0],
            open:        parseFloat(o.toFixed(2)),
            high:        parseFloat(h.toFixed(2)),
            low:         parseFloat(l.toFixed(2)),
            close:       parseFloat(c.toFixed(2)),
            // Hollow (transparent body) if up, filled if down
            color:       isUp ? 'rgba(0,0,0,0)' : '#ef4444',
            borderColor: isUp ? '#22c55e'        : '#ef4444',
            wickColor:   isUp ? '#22c55e'        : '#ef4444',
          };
        }).filter(Boolean);

        candleSeries.setData(rawCandles);

        // ── Target & Stop Loss Lines (starting from entry date) ──
        const entryDate = trade.entries?.[0]?.date?.split('T')[0];
        const entryIndex = entryDate ? rawCandles.findIndex(c => c.time === entryDate) : 0;
        const targetCandles = rawCandles.slice(Math.max(0, entryIndex));
        
        const _addTargetLine = (price, color, title) => {
          if (!price || price <= 0) return;
          const lineSeries = chart.addLineSeries({
            color: color, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed,
            title: title, lastValueVisible: true, priceLineVisible: false,
            crosshairMarkerVisible: false
          });
          lineSeries.setData(targetCandles.map(c => ({ time: c.time, value: price })));
        };

        const tlm = TLMPanel.stateOf(trade);
        _addTargetLine(m.currentStop, '#ef4444', `SL ₹${calc.formatNumber(m.currentStop)}`);
        if (tlm) {
          if (tlm.hardStop !== m.currentStop) _addTargetLine(tlm.hardStop, '#f97316', `Hard stop ₹${calc.formatNumber(tlm.hardStop)}`);
          [['T1', '#eab308'], ['T2', '#22c55e'], ['T5', '#3b82f6'], ['T10', '#a855f7']].forEach(([k, col]) =>
            _addTargetLine(tlm.targets[k], col, `${TLMRules.planOf(tlm)[k].r}R ₹${calc.formatNumber(tlm.targets[k])}`));
          const tr = TLMEngine.activeTranche(tlm);
          if (tr) _addTargetLine(tr.trail, '#f59e0b', `Trail ${TLMRules.planOf(tlm)[tr.id].r}R ₹${calc.formatNumber(tr.trail)}`);
        }

        // ── Entry & Exit markers on actual candles ────────────────
        const markers = [];

        // Entry markers (one per entry leg — pyramids included)
        const allEntries = [...(trade.entries || []), ...(trade.pyramids || [])];
        allEntries.forEach((entry, idx) => {
          if (!entry?.date) return;
          const d = entry.date.split('T')[0];
          if (rawCandles.find(c => c.time === d)) {
            markers.push({
              time:     d,
              position: 'belowBar',
              color:    '#22c55e',
              shape:    'arrowUp',
              text:     idx === 0 ? `Entry ₹${calc.formatNumber(entry.price)}` : `Add ₹${calc.formatNumber(entry.price)}`,
            });
          }
        });

        // Partial exit markers
        (trade.partialExits || []).forEach(exit => {
          if (!exit?.date) return;
          const d = exit.date.split('T')[0];
          if (rawCandles.find(c => c.time === d)) {
            markers.push({
              time:     d,
              position: 'aboveBar',
              color:    '#f59e0b',
              shape:    'arrowDown',
              text:     `Exit ₹${calc.formatNumber(exit.price)}`,
            });
          }
        });

        // Final exit marker
        if (trade.finalExit?.date) {
          const d = trade.finalExit.date.split('T')[0];
          if (rawCandles.find(c => c.time === d)) {
            markers.push({
              time:     d,
              position: 'aboveBar',
              color:    '#ef4444',
              shape:    'arrowDown',
              text:     `Final Exit ₹${calc.formatNumber(trade.finalExit.price)}`,
            });
          }
        }

        // Sort markers by time (required by LightweightCharts)
        markers.sort((a, b) => a.time.localeCompare(b.time));
        if (markers.length) candleSeries.setMarkers(markers);

        // Default visible window = last 3 months; full 2y available on scroll
        const lastDate  = rawCandles[rawCandles.length - 1]?.time;
        const fromDate  = new Date(lastDate);
        fromDate.setMonth(fromDate.getMonth() - 3);
        const fromStr   = fromDate.toISOString().split('T')[0];
        chart.timeScale().setVisibleRange({ from: fromStr, to: lastDate });
        if (statusEl) statusEl.textContent = `✅ ${rawCandles.length} candles loaded (3m view, scroll for 2y)`;
      } else {
        if (statusEl) statusEl.textContent = '❌ No data. Try TradingView link.';
      }
    } catch(e) {
      if (statusEl) statusEl.textContent = `❌ ${e.message}`;
    }

    // Responsive resize
    const ro = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth }));
    ro.observe(container);
  }



  // ── Close Panel — hides detail, restores table-only view ──────────────────
  function _closePanel() {
    // Exit fullscreen cleanly before closing
    if (_isFullscreen) {
      _isFullscreen = false;
      const tablePanel = document.getElementById('pos-table-panel');
      if (tablePanel) tablePanel.style.display = '';
    }
    const panel     = document.getElementById('pos-detail-panel');
    const splitView = document.getElementById('pos-split-view');
    if (panel)     { panel.classList.add('hidden'); panel.style.cssText = ''; }
    if (splitView) { splitView.style.cssText = ''; splitView.querySelector('.split-left')?.removeAttribute('style'); splitView.querySelector('.split-right')?.removeAttribute('style'); }
    _selectedTradeId = null;
    document.querySelectorAll('#pos-table-body tr').forEach(r => r.classList.remove('selected'));
  }

  // ── Fullscreen toggle ──────────────────────────────────────────────────────
  // ⛶ = Enter fullscreen (table hidden, detail panel fills screen)
  // ⊡ = Exit fullscreen back to split view (table + detail side by side)
  function _toggleFullscreen() {
    _isFullscreen = !_isFullscreen;
    const tablePanel = document.getElementById('pos-table-panel');
    const detPanel   = document.getElementById('pos-detail-panel');
    const splitView  = document.getElementById('pos-split-view');
    const fsBtn      = document.getElementById('pos-fs-btn');

    if (_isFullscreen) {
      // Enter fullscreen: force-hide table, expand detail to fill full width
      if (tablePanel) tablePanel.style.display = 'none';
      if (detPanel)   detPanel.style.cssText = 'flex:1;min-width:0;width:100%;';
      if (splitView)  splitView.style.cssText = 'height:calc(100vh - 200px);';
      if (fsBtn)      { fsBtn.textContent = '\u229F'; fsBtn.title = 'Minimize — return to split view'; }
    } else {
      // Exit fullscreen: restore split view
      if (tablePanel) tablePanel.style.display = '';
      if (detPanel)   detPanel.style.cssText = '';
      if (splitView)  { splitView.style.cssText = ''; splitView.querySelector('.split-left')?.removeAttribute('style'); splitView.querySelector('.split-right')?.removeAttribute('style'); }
      if (fsBtn)      { fsBtn.textContent = '\u26F6'; fsBtn.title = 'Full Screen — hides position table'; }
    }
  }

  // ── Quick Action Modals ────────────────────────────────────────────────────
  async function _showExitModal(tradeId, type) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const settings = await db.getSettings();
    _cachedSettings = settings;

    const m       = calc.getTradeMetrics(trade);
    const today   = new Date().toISOString().split('T')[0];
    const isPartial = type === 'partial';
    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Exit Date</label><input class="form-input" type="date" id="exit-date" value="${today}"></div>
      <div class="form-group"><label class="form-label">Exit Price (₹)</label><input class="form-input" type="number" id="exit-price" placeholder="e.g. 1350" step="0.05" oninput="positionsModule._autoCalcExitCharges('${trade.tradeType}')"></div>
      ${isPartial ? `<div class="form-group"><label class="form-label">Qty to Exit (Open: ${m.openQty})</label><input class="form-input" type="number" id="exit-qty" value="${Math.floor(m.openQty/2)}" min="1" max="${m.openQty}" oninput="positionsModule._autoCalcExitCharges('${trade.tradeType}')"></div>` : `<input type="hidden" id="exit-qty" value="${m.openQty}">`}
      <div class="form-group"><label class="form-label">Charges (₹)</label><input class="form-input" type="number" id="exit-charges" value="0" step="0.01"></div>
      <div class="form-group form-full"><label class="form-label">Action Source</label>
        <select class="form-select" id="exit-source">
          <option>LC-07 Trail exit</option><option>LC-09 Hard stop</option><option>Manual Discretionary</option><option>Full Close</option>
        </select>
      </div>
    </div>`;
    app.openModal(`${isPartial ? 'Partial' : 'Final'} Exit — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save', label:'Confirm Exit', class:'btn-danger', onClick: async () => {
        const date    = document.getElementById('exit-date').value;
        const price   = parseFloat(document.getElementById('exit-price').value);
        const qty     = parseInt(document.getElementById('exit-qty').value);
        const charges = parseFloat(document.getElementById('exit-charges').value) || 0;
        const source  = document.getElementById('exit-source').value;
        if (!date || !price || !qty) { app.toast('Please fill all required fields', 'error'); return; }
        if (qty > m.openQty) { app.toast(`Cannot exit more than ${m.openQty} shares`, 'error'); return; }
        const updated    = { ...trade };
        const exitRecord = { id: db.generateId('ex'), date, price, qty, charges, actionSource: source };
        if (isPartial && qty < m.openQty) {
          updated.partialExits = [...(trade.partialExits || []), exitRecord];
        } else {
          updated.finalExit = exitRecord;
        }

        await db.saveTrade(updated);
        app.closeModal();
        await TLMAlerts.markExecuted(tradeId, ['SELL', 'EXIT_ALL']);
        app.toast(`Exit recorded for ${trade.symbol}`, 'success');
        await init();
        const stillOpen = await db.getTradeById(tradeId);
        if (stillOpen) await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  async function _showPyramidModal(tradeId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const today      = new Date().toISOString().split('T')[0];
    const settings   = await db.getSettings();
    _cachedSettings  = settings;
    const capital    = await db.getCapital();
    const closedT    = await db.getClosedTrades();
    const realPnl    = calc.getTotalPnl(closedT);
    const equity     = calc.getCurrentEquity(capital, realPnl);
    const maxHeat    = Number(settings?.riskManagement?.maxPortfolioHeat || 5);
    const openTrades = await db.getOpenTrades();
    const m          = calc.getTradeMetrics(trade);
    const curStop    = m.currentStop || trade.currentStop || 0;
    // Lifecycle add (target 1): same qty as the first entry, stop raised per Settings.
    const tlm        = TLMPanel.stateOf(trade);
    const tlmPlan    = TLMRules.planOf(tlm);
    const tlmAdd     = tlm && tlmPlan.T1.on
      ? { qty: tlm.firstQty, r: tlmPlan.T1.r, stop: TLMIndicators.roundTick(tlm.initialStop + TLMRunner.paramsFrom(settings).stopRaiseAt1R * tlm.r) }
      : { qty: 0 };

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Date</label>
        <input class="form-input" type="date" id="pyr-date" value="${today}"></div>
      <div class="form-group"><label class="form-label">Pyramid Type</label>
        <select class="form-input" id="pyr-type" onchange="
          if(this.value === 'tlmAdd') {
            document.getElementById('pyr-qty').value = ${tlmAdd.qty};
            document.getElementById('pyr-stop').value = ${tlmAdd.stop};
            positionsModule._autoCalcPyramidCharges('${trade.tradeType}');
          }
        ">
          <option value="manual">Manual Entry</option>
          ${tlmAdd.qty ? `<option value="tlmAdd">Lifecycle add at ${tlmAdd.r}R — ${tlmAdd.qty} Qty, stop ₹${calc.formatNumber(tlmAdd.stop)}</option>` : ''}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Entry Price (₹)</label>
        <input class="form-input" type="number" id="pyr-price" step="0.05"
          oninput="positionsModule._autoCalcPyramidCharges('${trade.tradeType}')"></div>
      <div class="form-group"><label class="form-label">Qty</label>
        <input class="form-input" type="number" id="pyr-qty" min="1"
          oninput="positionsModule._autoCalcPyramidCharges('${trade.tradeType}'); document.getElementById('pyr-type').value = 'manual';"></div>
      <div class="form-group"><label class="form-label">Charges (₹)</label>
        <input class="form-input" type="number" id="pyr-charges" value="0" step="0.01"></div>
      <div class="form-group">
        <label class="form-label">Stop Loss (₹)
          <span style="font-size:10px;font-weight:400;color:var(--text-muted);margin-left:6px">
            Current: ₹${calc.formatNumber(curStop)} — change if you moved stop before pyramiding
          </span>
        </label>
        <input class="form-input" type="number" id="pyr-stop" step="0.05" value="${curStop}">
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <input class="form-input" id="pyr-notes" placeholder="Reason for pyramid..."></div>
      <div class="form-full" id="pyr-heat-warn"></div>
    </div>`;

    app.openModal(`Pyramid — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save',   label:'Add Pyramid', class:'btn-success', onClick: async () => {
        const date    = document.getElementById('pyr-date').value;
        const price   = parseFloat(document.getElementById('pyr-price').value);
        const qty     = parseInt(document.getElementById('pyr-qty').value);
        const charges = parseFloat(document.getElementById('pyr-charges').value) || 0;
        const newStop = parseFloat(document.getElementById('pyr-stop').value) || curStop;
        const notes   = document.getElementById('pyr-notes').value;
        if (!date || !price || !qty) { app.toast('Please fill all fields', 'error'); return; }

        // Portfolio heat check — use entered stop for accurate risk
        const pyrRisk  = Math.abs((price - newStop) * qty);
        const projHeat = equity > 0 ? ((calc.getPortfolioHeatRs(openTrades) + pyrRisk) / equity * 100) : 0;
        const warnEl   = document.getElementById('pyr-heat-warn');

        if (projHeat > maxHeat + 1) {
          if (warnEl) warnEl.innerHTML = `<div class="alert-banner danger">⚠ High Risk: Projected heat ${projHeat.toFixed(2)}% exceeds max ${maxHeat}% by ${(projHeat-maxHeat).toFixed(2)}%. Are you sure?</div>`;
          if (!confirm(`Portfolio heat will reach ${projHeat.toFixed(2)}% (max: ${maxHeat}%). Proceed?`)) return;
        } else if (projHeat > maxHeat) {
          if (!confirm(`Portfolio heat will reach ${projHeat.toFixed(2)}% — slightly above max ${maxHeat}%. Proceed?`)) return;
        }

        // Build update atomically
        const updated = { ...trade };

        // If stop changed → log a stop revision BEFORE pyramid in same save
        // computeRPT() will process stop before buy on same date (fixed sort order)
        if (newStop !== curStop) {
          updated.currentStop   = newStop;
          updated.stopRevisions = [
            ...(trade.stopRevisions || []),
            { id: db.generateId('sr'), date, oldStop: curStop, newStop, actionSource: 'Manual', notes: 'Stop updated at pyramid entry' }
          ];
        }

        // Add the pyramid
        updated.pyramids = [
          ...(trade.pyramids || []),
          { id: db.generateId('py'), date, price, qty, charges, actionSource: 'Pyramid', notes }
        ];

        await db.saveTrade(updated);
        app.closeModal();
        await TLMAlerts.markExecuted(tradeId, ['BUY']);
        const stopMsg = newStop !== curStop ? ` | Stop → ₹${calc.formatNumber(newStop)}` : '';
        app.toast(`Pyramid added to ${trade.symbol}${stopMsg}`, 'success');
        await init();
        await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  async function _showStopModal(tradeId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const today = new Date().toISOString().split('T')[0];
    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="stop-date" value="${today}"></div>
      <div class="form-group"><label class="form-label">Old Stop (₹) <span style="font-size:10px;color:var(--text-muted)">(auto-filled)</span></label><input class="form-input" type="number" id="stop-old" value="${calc.getTradeMetrics(trade).currentStop}" readonly style="background:var(--surface-2);color:var(--text-muted)"></div>
      <div class="form-group"><label class="form-label">New Stop (₹)</label><input class="form-input" type="number" id="stop-new" step="0.05"></div>
      <div class="form-group"><label class="form-label">Source</label><select class="form-select" id="stop-source"><option>Manual</option><option>Trail</option><option>System</option></select></div>
      <div class="form-group form-full"><label class="form-label">Notes</label><input class="form-input" id="stop-notes" placeholder="Reason for revision..."></div>
    </div>`;
    app.openModal(`Revise Stop — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save', label:'Save Stop', class:'btn-primary', onClick: async () => {
        const date    = document.getElementById('stop-date').value;
        const oldStop = parseFloat(document.getElementById('stop-old').value);
        const newStop = parseFloat(document.getElementById('stop-new').value);
        const source  = document.getElementById('stop-source').value;
        const notes   = document.getElementById('stop-notes').value;
        if (!date || !newStop) { app.toast('Please fill all fields', 'error'); return; }
        const updated = { ...trade, currentStop: newStop, stopRevisions: [...(trade.stopRevisions||[]), { id: db.generateId('sr'), date, oldStop, newStop, actionSource: source, notes }] };
        await db.saveTrade(updated);
        app.closeModal();
        await TLMAlerts.markExecuted(tradeId, ['STOP', 'BRIEF', 'TRAIL']);
        app.toast(`Stop revised for ${trade.symbol}`, 'success');
        await init(); await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  async function _showNoteModal(tradeId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const today = new Date().toISOString().split('T')[0];
    const content = `<div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="note-date" value="${today}"></div>
      <div class="form-group"><label class="form-label">Note</label><textarea class="form-input form-textarea" id="note-text" placeholder="Enter your observation..." rows="4"></textarea></div>`;
    app.openModal(`Add Note — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save', label:'Save Note', class:'btn-primary', onClick: async () => {
        const date = document.getElementById('note-date').value;
        const text = document.getElementById('note-text').value.trim();
        if (!text) { app.toast('Please enter a note', 'error'); return; }
        const updated = { ...trade, notes: [...(trade.notes||[]), { id: db.generateId('nt'), date, text }] };
        await db.saveTrade(updated);
        app.closeModal();
        app.toast('Note saved', 'success');
        await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  // ── New Trade Modal ────────────────────────────────────────────────────────
  function _setupNewTradeBtn() {
    const btn = document.getElementById('btn-new-trade');
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', async () => { await _showNewTradeModal(); });
    const imp = document.getElementById('btn-import-positions');
    if (imp) imp.onclick = () => ImportModule.open('positions', init);
  }

  async function _showNewTradeModal() {
    const playbooks = (await db.getPlaybooks()).filter(p => p.status === 'Active');
    const today     = new Date().toISOString().split('T')[0];
    const settings  = await db.getSettings();
    const capital   = await db.getCapital();
    const closedT   = await db.getClosedTrades();
    const realPnl   = calc.getTotalPnl(closedT);
    const equity    = calc.getCurrentEquity(capital, realPnl);
    const defRPT    = calc.getCurrentR(equity, settings);
    
    _cachedSettings = settings;
    _cachedDefRPT = defRPT;

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Symbol *</label><input class="form-input" id="nt-symbol" placeholder="e.g. RELIANCE" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"></div>
      <div class="form-group"><label class="form-label">Sector</label>
        <select class="form-select" id="nt-sector">
          <option>Banking</option><option>IT</option><option>Energy</option><option>Pharma</option><option>FMCG</option><option>Auto</option><option>Telecom</option><option>Chemicals</option><option>NBFC</option><option>Consumer</option><option>Cement</option><option>Other</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Trade Type</label>
        <select class="form-select" id="nt-type" onchange="positionsModule._autoCalcTrade('type')"><option>Equity</option><option>Intraday</option><option>Futures</option></select>
      </div>
      <div class="form-group"><label class="form-label">Direction</label>
        <select class="form-select" id="nt-direction"><option>Long</option><option>Short</option></select>
      </div>
      <div class="form-group"><label class="form-label">Exchange</label>
        <select class="form-select" id="nt-exchange"><option value="NSE" selected>NSE</option><option value="BSE">BSE</option></select>
      </div>
      <div class="form-group"><label class="form-label">Playbook</label>
        <select class="form-select" id="nt-playbook">
          <option value="">— None —</option>
          ${playbooks.map(p => `<option value="${p.id}">${p.name} (v${p.currentVersion})</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Entry Date *</label><input class="form-input" type="date" id="nt-date" value="${today}"></div>
      <div class="form-group"><label class="form-label">Entry Price (₹) *</label><input class="form-input" type="number" id="nt-price" step="0.05" oninput="positionsModule._autoCalcTrade('price')"></div>
      <div class="form-group"><label class="form-label">Initial Stop Loss (₹) *</label><input class="form-input" type="number" id="nt-stop" step="0.05" oninput="positionsModule._autoCalcTrade('stop')"></div>
      <div class="form-group"><label class="form-label">Qty *</label><input class="form-input" type="number" id="nt-qty" min="1" oninput="positionsModule._autoCalcTrade('qty')"></div>
      <div class="form-group"><label class="form-label">RPT (₹) <span style="color:var(--text-muted);font-weight:400">(auto / default: ${calc.formatCurrency(defRPT)})</span></label><input class="form-input" type="number" id="nt-rpt" placeholder="${defRPT.toFixed(0)}" oninput="positionsModule._autoCalcTrade('rpt')"></div>
      <div class="form-group"><label class="form-label">Charges (₹)</label><input class="form-input" type="number" id="nt-charges" value="0"></div>
      <div class="form-group"><label class="form-label">CMP <span id="nt-cmp-status" style="font-size:11px;color:var(--text-muted);font-weight:400">— auto-fetched on symbol entry</span></label><input class="form-input" type="number" id="nt-cmp" step="0.05" placeholder="Auto-fetching..."></div>
    </div>`;
    app.openModal('New Trade', content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save',   label:'Add Trade', class:'btn-primary', onClick: async () => {
        const symbol    = document.getElementById('nt-symbol').value.trim().toUpperCase();
        const sector    = document.getElementById('nt-sector').value;
        const tradeType = document.getElementById('nt-type').value;
        const direction = document.getElementById('nt-direction').value;
        const playbookId= document.getElementById('nt-playbook').value;
        const date      = document.getElementById('nt-date').value;
        const price     = parseFloat(document.getElementById('nt-price').value);
        const qty       = parseInt(document.getElementById('nt-qty').value);
        const stop      = parseFloat(document.getElementById('nt-stop').value);
        const rpt       = parseFloat(document.getElementById('nt-rpt').value) || Math.abs((price - stop) * qty) || defRPT;
        const charges   = parseFloat(document.getElementById('nt-charges').value) || 0;
        const cmp       = parseFloat(document.getElementById('nt-cmp').value) || price;
        const exchange   = document.getElementById('nt-exchange')?.value || 'NSE';
        if (!symbol || !date || !price || !qty || !stop) { app.toast('Please fill all required (*) fields', 'error'); return; }

        const pb = playbookId ? await db.getPlaybookById(playbookId) : null;
        const trade = {
          id: db.generateId('tr'), symbol, sector, tradeType, direction, exchange,
          playbookId, playbookVersion: playbookId ? pb?.currentVersion || '1.0' : '',
          initialStop: stop, currentStop: stop, rpt,
          tlmState: TLMEngine.createState({ entryPrice: price, firstQty: qty, initialStop: stop, params: TLMRunner.paramsFrom(await db.getSettings()), now: Date.now() }),
          entries: [{ id: db.generateId('en'), date, price, qty, charges, notes:'' }],
          pyramids: [], stopRevisions: [{ id: db.generateId('sr'), date, oldStop: 0, newStop: stop, actionSource:'Manual', notes:'Initial stop' }],
          partialExits: [], finalExit: null, notes: [], alerts: [],
          ruleFollowed: true, reviewStatus: 'Pending', rating: 0,
          chartLink: `https://www.tradingview.com/chart/?symbol=${exchange}:${symbol}`, tags: [sector],
          cmp, createdAt: date, closedAt: null
        };
        await db.saveTrade(trade);
        app.closeModal();
        app.toast(`Trade added: ${symbol}`, 'success');
        await init();
      }}
    ]);

    // ── Auto-fetch CMP when symbol is entered (800ms debounce) ────────────
    setTimeout(() => {
      const symbolEl = document.getElementById('nt-symbol');
      const cmpEl    = document.getElementById('nt-cmp');
      const statusEl = document.getElementById('nt-cmp-status');
      if (!symbolEl) return;
      let _debounce;
      symbolEl.addEventListener('input', () => {
        clearTimeout(_debounce);
        const sym = symbolEl.value.trim().toUpperCase();
        if (sym.length < 2) return;
        _debounce = setTimeout(async () => {
          if (statusEl) statusEl.textContent = '⏳ Fetching...';
          const price = await _fetchLiveCmp(sym);
          if (price) {
            if (cmpEl) cmpEl.value = price.toFixed(2);
            if (statusEl) statusEl.textContent = `✅ ₹${calc.formatNumber(price)}`;
          } else {
            if (statusEl) statusEl.textContent = '❌ Not found — enter manually';
          }
        }, 800);
      });
    }, 80);
  }

  function _autoCalcTrade(source) {
    const price = parseFloat(document.getElementById('nt-price')?.value) || 0;
    const stop  = parseFloat(document.getElementById('nt-stop')?.value) || 0;
    const qtyEl = document.getElementById('nt-qty');
    const rptEl = document.getElementById('nt-rpt');
    const type  = document.getElementById('nt-type')?.value || 'Equity';
    const chargesEl = document.getElementById('nt-charges');

    let qty = parseInt(qtyEl?.value) || 0;
    let rpt = parseFloat(rptEl?.value) || _cachedDefRPT;

    // Position Sizing Logic
    if (price && stop) {
      const riskPerShare = Math.abs(price - stop);
      if (riskPerShare > 0) {
        if (source === 'price' || source === 'stop') {
          // Calculate target Qty based on default RPT
          qty = Math.floor(_cachedDefRPT / riskPerShare);
          if (qtyEl) qtyEl.value = qty;
          rpt = qty * riskPerShare;
          if (rptEl) rptEl.value = rpt.toFixed(0);
        } else if (source === 'qty') {
          // User manually edited Qty, update RPT
          rpt = qty * riskPerShare;
          if (rptEl) rptEl.value = rpt.toFixed(0);
        } else if (source === 'rpt') {
          // User manually edited RPT, update Qty
          qty = Math.floor(rpt / riskPerShare);
          if (qtyEl) qtyEl.value = qty;
        }
      }
    }

    // Charges Logic (Buy Side Only)
    if (price && qty && _cachedSettings && chargesEl) {
      const buyTurnover = price * qty;
      const charges = calc.getZerodhaCharges(type, buyTurnover, 0, _cachedSettings);
      chargesEl.value = charges.total.toFixed(2);
    } else if (chargesEl) {
      chargesEl.value = '0';
    }
  }

  function _autoCalcExitCharges(type) {
    const price = parseFloat(document.getElementById('exit-price')?.value) || 0;
    const qty = parseInt(document.getElementById('exit-qty')?.value) || 0;
    const chargesEl = document.getElementById('exit-charges');

    if (price && qty && _cachedSettings && chargesEl) {
      const sellTurnover = price * qty;
      // Pass 0 for buy turnover, sellTurnover for sell side
      const charges = calc.getZerodhaCharges(type, 0, sellTurnover, _cachedSettings);
      chargesEl.value = charges.total.toFixed(2);
    } else if (chargesEl) {
      chargesEl.value = '0';
    }
  }

  function _autoCalcPyramidCharges(type) {
    const price = parseFloat(document.getElementById('pyr-price')?.value) || 0;
    const qty = parseInt(document.getElementById('pyr-qty')?.value) || 0;
    const chargesEl = document.getElementById('pyr-charges');

    if (price && qty && _cachedSettings && chargesEl) {
      const buyTurnover = price * qty;
      const charges = calc.getZerodhaCharges(type, buyTurnover, 0, _cachedSettings);
      chargesEl.value = charges.total.toFixed(2);
    } else if (chargesEl) {
      chargesEl.value = '0';
    }
  }

  async function _deleteTrade(tradeId) {
    if (!confirm('Are you sure you want to permanently delete this entire trade? This action cannot be undone.')) return;
    await db.deleteTrade(tradeId);
    app.toast('Trade deleted successfully', 'success');
    _closePanel();
    await init();
  }

  async function _showEditTradeModal(tradeId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Initial Stop Loss (₹)</label>
        <input class="form-input" type="number" id="edit-initial-stop" step="0.05" value="${trade.initialStop || ''}"></div>
      <div class="form-full">
        <p style="font-size:12px;color:var(--text-muted);margin-top:10px;">
          Changing the initial stop recalculates 1R and all four targets. The lifecycle stage is kept.
        </p>
      </div>
    </div>`;

    app.openModal(`Edit Trade — ${trade.symbol}`, content, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save', label: 'Save Changes', class: 'btn-success', onClick: async () => {
          const initStop = parseFloat(document.getElementById('edit-initial-stop').value);
          if (!initStop) { app.toast('Initial stop is required', 'error'); return; }

          const updated = { ...trade, initialStop: initStop };
          const old = trade.tlmState;
          if (old) {
            const plan = TLMRules.planOf(old);   // keep this trade's own target levels and on/off
            const fresh = TLMEngine.createState({ entryPrice: old.entryPrice, firstQty: old.firstQty, initialStop: initStop,
              params: { target1R: plan.T1.r, target2R: plan.T2.r, target5R: plan.T5.r, target10R: plan.T10.r,
                        enable1R: plan.T1.on, enable2R: plan.T2.on, enable5R: plan.T5.on, enable10R: plan.T10.on,
                        tranche5Pct: plan.T5.pct, tranche10Pct: plan.T10.pct } });
            if (!fresh) { app.toast('Initial stop must be below the entry price', 'error'); return; }
            updated.tlmState = { ...old, initialStop: fresh.initialStop, r: fresh.r, targets: fresh.targets, plan: fresh.plan,
              hardStop: old.stage <= TLMRules.STAGES.ENTERED ? fresh.hardStop : old.hardStop };
          }

          await db.saveTrade(updated);
          app.closeModal();
          app.toast('Trade updated successfully', 'success');
          await init();
          positionsModule._onRowClick(tradeId);
        }
      }
    ]);
  }

  return { init, _onRowClick, _closePanel, _toggleFullscreen, _showExitModal,
    _showPyramidModal, _showStopModal, _showNoteModal, _showCmpModal, _showEditTradeModal, _autoCalcTrade, _autoCalcExitCharges,
    _autoCalcPyramidCharges, _editLifecycleRow, _deleteLifecycleRow, _editStopRow, _deleteStopRow,
    _deleteTrade, _sortTable, _alertAct, forceRefresh: _syncNow };
})();
