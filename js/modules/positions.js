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

  async function init() {
    // Auto-run alert engine on every load
    try { alertEngine.checkAllAlerts(await db.getOpenTrades()); } catch(e) {}
    await _renderOverviewCards();
    await _renderTable();
    _setupNewTradeBtn();
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
    const cards = [
      { label: 'Open Positions',  value: openTrades.length,                    sub: 'Currently active',                                              icon: '📊' },
      { label: 'Total Exposure',  value: calc.formatCurrency(totalExposure),   sub: `${equity > 0 ? ((totalExposure/equity)*100).toFixed(1) : 0}% of equity`, icon: '💼' },
      { label: 'Portfolio Heat',  value: `${heat.toFixed(2)}% / ${maxHeat}%`, sub: `${calc.formatCurrency(heatRs)} at risk • Warn: ${warnHeat}%`,  icon: '🌡️', cls: heatCls },
      { label: 'Unrealized P&L',  value: calc.formatCurrency(unrealizedPnl),  sub: 'Based on CMP',                                                  icon: '📈', cls: unrealizedPnl >= 0 ? 'positive' : 'negative' },
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

  // ── Positions Table ────────────────────────────────────────────────────────
  async function _renderTable() {
    const tbl = document.getElementById('pos-table');
    if (!tbl) return;
    // Update header dynamically to include all SRS-required columns
    const thead = tbl.querySelector('thead tr');
    if (thead) {
      thead.innerHTML = `
        <th>Symbol</th><th>Type</th><th>Entry Date</th>
        <th>Open Qty</th><th>Avg Entry</th><th>Init Stop</th><th>Curr Stop</th>
        <th>CMP</th><th>Chg%</th><th>Open Risk R</th>
        <th>Exposure</th><th>Unreal. P&L (R)</th><th>Net P&L</th><th>Alert</th>`;
    }

    const tbody = document.getElementById('pos-table-body');
    if (!tbody) return;
    const openTrades = await db.getOpenTrades();
    const capital    = await db.getCapital();
    const settings   = await db.getSettings();
    const closedTrades = await db.getClosedTrades();
    const realizedPnl  = calc.getTotalPnl(closedTrades);
    const equity       = calc.getCurrentEquity(capital, realizedPnl);
    const currentR     = calc.getCurrentR(equity, settings);

    if (!openTrades.length) {
      tbody.innerHTML = `<tr><td colspan="14"><div class="no-data"><div class="no-data-icon">📭</div>No open positions. Click "+ New Trade" to add one.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = openTrades.map(trade => {
      const m         = calc.getTradeMetrics(trade);
      const cmp       = trade.cmp || m.avgEntryPrice;
      const unrealPnl = calc.getUnrealizedPnl(trade, cmp);
      const unrealR   = m.initialRPT > 0 ? (unrealPnl / m.initialRPT) : 0;
      const chgPct    = m.avgEntryPrice > 0 ? ((cmp - m.avgEntryPrice) / m.avgEntryPrice * 100) : 0;
      const alerts    = (trade.alerts || []).filter(a => a.status === 'Triggered');
      const alertBadge= alerts.length ? `<span class="badge badge-warning">⚠ ${alerts.length}</span>` : `<span class="badge badge-muted">—</span>`;
      const pnlCls    = unrealPnl >= 0 ? 'text-success' : 'text-danger';
      const riskRCls  = m.currentRiskR <= -1.5 ? 'text-danger' : m.currentRiskR <= -0.5 ? 'text-warning' : 'text-success';
      const chgCls    = chgPct >= 0 ? 'text-success' : 'text-danger';
      const netPnl    = m.realizedPnl || 0;  // = (AvgSell - AvgEntry) × SellQty − Charges
      const symColor  = cmp >= m.avgEntryPrice ? 'text-success' : 'text-danger';
      return `<tr data-id="${trade.id}" onclick="positionsModule._onRowClick('${trade.id}')">
        <td><strong class="${symColor}">${trade.symbol}</strong> <span class="badge badge-muted" style="font-size:10px">${trade.direction}</span></td>
        <td><span class="badge badge-muted">${trade.tradeType}</span></td>
        <td>${calc.formatDate(trade.entries?.[0]?.date || '')}</td>
        <td class="font-mono">${m.openQty}</td>
        <td class="font-mono">₹${calc.formatNumber(m.avgEntryPrice)}</td>
        <td class="font-mono">₹${calc.formatNumber(trade.initialStop)}</td>
        <td class="font-mono">₹${calc.formatNumber(m.currentStop)}</td>
        <td class="font-mono" style="cursor:pointer" onclick="event.stopPropagation();positionsModule._showCmpModal('${trade.id}')" title="Click to update CMP">
          ₹${calc.formatNumber(cmp)} <span style="color:#5b6af0;font-size:10px">✎</span></td>
        <td class="${chgCls} font-mono">${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(1)}%</td>
        <td class="${riskRCls} font-mono">${calc.formatR(m.currentRiskR)}</td>
        <td class="font-mono">${calc.formatCurrency(m.exposure)}</td>
        <td class="${pnlCls} font-mono fw-600">${calc.formatCurrency(unrealPnl)} <span style="font-size:11px">(${unrealR >= 0 ? '+' : ''}${unrealR.toFixed(2)}R)</span></td>
        <td class="${netPnl >= 0 ? 'text-success' : netPnl < 0 ? 'text-danger' : 'text-muted'} font-mono">${calc.formatCurrency(netPnl)}</td>
        <td>${alertBadge}</td>
      </tr>`;
    }).join('');
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
    const unrealR   = m.initialRPT > 0 ? (unrealPnl / m.initialRPT) : 0;
    const alerts    = (trade.alerts || []).filter(a => a.status === 'Triggered');
    const dirBadge  = `<span class="badge ${trade.direction === 'Long' ? 'badge-success' : 'badge-danger'}">${trade.direction}</span>`;
    const alertHtml = alerts.map(a => `<div class="alert-banner warning">⚠ ${a.type}</div>`).join('');
    const playbook  = await db.getPlaybookById(trade.playbookId);

    panel.innerHTML = `
      <div class="detail-panel">
        <div class="detail-panel-header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="detail-symbol">${trade.symbol}</span>
              ${dirBadge}
              <span class="badge badge-muted">${trade.tradeType}</span>
            </div>
            <div class="detail-sub">${m.holdingDays} days held (trading days: ${m.tradingDays}) · Entry: ${calc.formatDate(trade.entries?.[0]?.date)} · Playbook: ${playbook?.name || '—'}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;" id="pos-panel-btns">
            <button class="btn btn-secondary btn-sm" id="pos-fs-btn"
              onclick="positionsModule._toggleFullscreen()"
              title="Full Screen — hides position table">
              ⛶
            </button>
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
              <div class="metric-value">₹${calc.formatNumber(cmp)}</div>
            </div>
            ${m.avgExitPrice > 0 ? `<div class="metric-item"><div class="metric-label">Avg Exit</div><div class="metric-value">₹${calc.formatNumber(m.avgExitPrice)} <span style="font-size:11px;color:${m.avgExitPrice >= m.avgEntryPrice ? 'var(--positive)':'var(--negative)'}">(${((m.avgExitPrice-m.avgEntryPrice)/m.avgEntryPrice*100).toFixed(2)}%)</span></div></div>` : ''}
            <div class="metric-item"><div class="metric-label">Initial Stop</div><div class="metric-value">₹${calc.formatNumber(trade.initialStop)}</div></div>
            <div class="metric-item"><div class="metric-label">Current Stop</div><div class="metric-value">₹${calc.formatNumber(m.currentStop)}</div></div>
            <div class="metric-item"><div class="metric-label">Open Qty</div><div class="metric-value">${m.openQty}</div></div>
            <div class="metric-item"><div class="metric-label">Exposure</div><div class="metric-value">${calc.formatCurrency(m.exposure)}</div></div>
            <div class="metric-item"><div class="metric-label">RPT</div><div class="metric-value">₹${calc.formatNumber(m.initialRPT)}</div></div>
            <div class="metric-item"><div class="metric-label">Open Risk R</div><div class="metric-value ${m.currentRiskR <= -1 ? 'negative' : ''}">${calc.formatR(m.currentRiskR)}</div></div>
            <div class="metric-item"><div class="metric-label">Unreal. P&L</div><div class="metric-value ${unrealPnl >= 0 ? 'positive' : 'negative'}">${calc.formatCurrency(unrealPnl)} <span style="font-size:11px">(${unrealR >= 0 ? '+' : ''}${unrealR.toFixed(2)}R)</span></div></div>
            <div class="metric-item"><div class="metric-label">Realized P&L</div><div class="metric-value ${m.realizedPnl >= 0 ? 'positive' : m.realizedPnl < 0 ? 'negative' : ''}">${calc.formatCurrency(m.realizedPnl || 0)} <span style="font-size:11px">(${calc.formatR(m.profitR)})</span></div></div>
          </div>

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

    // Attach Yahoo Finance fetch button
    setTimeout(() => {
      document.getElementById('btn-fetch-price')?.addEventListener('click', async () => {
        const statusEl = document.getElementById('cmp-fetch-status');
        statusEl.textContent = '⏳ Fetching...';
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(trade.symbol)}.NS?interval=1d&range=1d`;
          const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
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
          statusEl.textContent = '❌ Cannot fetch (CORS). Use NSE link above.';
        }
      });
    }, 50);
  }

  function _renderStopsTab(trade) {
    const stops = trade.stopRevisions || [];
    if (!stops.length) return `<div class="no-data">No stop revisions recorded.</div>`;
    return `<div>${stops.map((s, i) => `<div class="stop-item">
      <span class="badge badge-muted">Rev ${i+1}</span>
      <span>${calc.formatDate(s.date)}</span>
      <span class="font-mono">₹${calc.formatNumber(s.oldStop)}</span>
      <span class="stop-arrow">→</span>
      <span class="font-mono fw-600">₹${calc.formatNumber(s.newStop)}</span>
      <span class="badge badge-muted">${s.actionSource}</span>
    </div>`).join('')}</div>`;
  }

  function _renderNotesTab(trade) {
    const notes = trade.notes || [];
    return `<div>
      ${notes.length ? notes.map(n => `<div class="note-item"><div class="note-date">${calc.formatDate(n.date)}</div><div class="note-text">${n.text}</div></div>`).join('') : `<div class="no-data" style="padding:20px 0">No notes yet.</div>`}
    </div>`;
  }

  function _renderChartTab(trade) {
    const symbol = trade.symbol;
    const tvSym  = encodeURIComponent(`NSE:${symbol}`);
    return `<div class="tv-chart-wrap">
      <iframe
        src="https://www.tradingview.com/widgetembed/?frameElementId=tv_pos_${symbol}&symbol=${tvSym}&interval=D&hidesidetoolbar=0&symboledit=1&saveimage=1&theme=light&style=1&timezone=Asia%2FKolkata&studies=%5B%22MASimple%4020%22%2C%22MASimple%4050%22%5D&show_popup_button=1&popup_width=1000&popup_height=650&locale=en"
        width="100%" height="360" allowtransparency="true" scrolling="no" allowfullscreen>
      </iframe>
      <div style="margin-top:6px;display:flex;gap:8px;">
        <a href="https://www.tradingview.com/chart/?symbol=NSE:${symbol}" target="_blank" class="btn btn-secondary btn-sm">🔗 Open Full Chart</a>
        <a href="https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}" target="_blank" class="btn btn-secondary btn-sm">📊 NSE Quote</a>
      </div>
    </div>`;
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
          <option>Manual</option><option>Day-5 Rule</option><option>ATR Extension</option><option>EMA20 Exit</option><option>Stop Triggered</option><option>Target Reached</option>
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

        // Auto-complete ALL triggered alerts when an exit is recorded.
        // The action source matches the alert type — mark them as Completed.
        updated.alerts = (trade.alerts || []).map(a => {
          if (a.status === 'Triggered') {
            return { ...a, status: 'Completed', completedAt: new Date().toISOString(), completedBy: source };
          }
          return a;
        });

        await db.saveTrade(updated);
        app.closeModal();
        app.toast(`Exit recorded for ${trade.symbol}. Alerts marked Completed.`, 'success');
        await init();
        const stillOpen = await db.getTradeById(tradeId);
        if (stillOpen) await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  async function _showPyramidModal(tradeId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const today    = new Date().toISOString().split('T')[0];
    const settings = await db.getSettings();
    _cachedSettings = settings;
    const capital  = await db.getCapital();
    const closedT  = await db.getClosedTrades();
    const realPnl  = calc.getTotalPnl(closedT);
    const equity   = calc.getCurrentEquity(capital, realPnl);
    const currentR = calc.getCurrentR(equity, settings);
    const maxHeat   = Number(settings?.riskManagement?.maxPortfolioHeat || 5);   // %
    const warnHeat  = Number(settings?.riskManagement?.warningPortfolioHeat || 3); // %
    const openTrades  = await db.getOpenTrades();
    const currentHeat = calc.getPortfolioHeat(openTrades, equity);  // returns %

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="pyr-date" value="${today}"></div>
      <div class="form-group"><label class="form-label">Entry Price (₹)</label><input class="form-input" type="number" id="pyr-price" step="0.05" oninput="positionsModule._autoCalcPyramidCharges('${trade.tradeType}')"></div>
      <div class="form-group"><label class="form-label">Qty</label><input class="form-input" type="number" id="pyr-qty" min="1" oninput="positionsModule._autoCalcPyramidCharges('${trade.tradeType}')"></div>
      <div class="form-group"><label class="form-label">Charges (₹)</label><input class="form-input" type="number" id="pyr-charges" value="0" step="0.01"></div>
      <div class="form-group form-full"><label class="form-label">Notes</label><input class="form-input" id="pyr-notes" placeholder="Reason for pyramid..."></div>
      <div class="form-full" id="pyr-heat-warn"></div>
    </div>`;
    app.openModal(`Pyramid — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save', label:'Add Pyramid', class:'btn-success', onClick: async () => {
        const date    = document.getElementById('pyr-date').value;
        const price   = parseFloat(document.getElementById('pyr-price').value);
        const qty     = parseInt(document.getElementById('pyr-qty').value);
        const charges = parseFloat(document.getElementById('pyr-charges').value) || 0;
        const notes   = document.getElementById('pyr-notes').value;
        if (!date || !price || !qty) { app.toast('Please fill all fields', 'error'); return; }

        // Portfolio heat validation (%)
        const m         = calc.getTradeMetrics(trade);
        const newRisk   = Math.abs((price - m.currentStop) * qty);       // ₹ risk of this pyramid
        const projHeat  = equity > 0 ? ((calc.getPortfolioHeatRs(openTrades) + newRisk) / equity * 100) : 0;
        const warnEl    = document.getElementById('pyr-heat-warn');

        if (projHeat > maxHeat + 1) {
          if (warnEl) warnEl.innerHTML = `<div class="alert-banner danger">⚠ High Risk: Projected heat ${projHeat.toFixed(2)}% exceeds max ${maxHeat}% by ${(projHeat-maxHeat).toFixed(2)}%. Are you sure?</div>`;
          if (!confirm(`Portfolio heat will reach ${projHeat.toFixed(2)}% (max: ${maxHeat}%). Proceed?`)) return;
        } else if (projHeat > maxHeat) {
          if (!confirm(`Portfolio heat will reach ${projHeat.toFixed(2)}% which slightly exceeds max ${maxHeat}%. Proceed?`)) return;
        }

        const updated = { ...trade, pyramids: [...(trade.pyramids||[]), { id: db.generateId('py'), date, price, qty, charges, actionSource: 'Pyramid', notes }] };
        await db.saveTrade(updated);
        app.closeModal();
        app.toast(`Pyramid added to ${trade.symbol}`, 'success');
        await init(); await _renderDetailPanel(tradeId);
      }}
    ]);
  }

  async function _showStopModal(tradeId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const today = new Date().toISOString().split('T')[0];
    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="stop-date" value="${today}"></div>
      <div class="form-group"><label class="form-label">Old Stop</label><input class="form-input" type="number" id="stop-old" value="${trade.currentStop}" readonly></div>
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
      <div class="form-group"><label class="form-label">CMP (for P&L tracking)</label><input class="form-input" type="number" id="nt-cmp" step="0.05"></div>
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
        if (!symbol || !date || !price || !qty || !stop) { app.toast('Please fill all required (*) fields', 'error'); return; }
        const pb = playbookId ? await db.getPlaybookById(playbookId) : null;
        const trade = {
          id: db.generateId('tr'), symbol, sector, tradeType, direction,
          playbookId, playbookVersion: playbookId ? pb?.currentVersion || '1.0' : '',
          initialStop: stop, currentStop: stop, rpt,
          entries: [{ id: db.generateId('en'), date, price, qty, charges, notes:'' }],
          pyramids: [], stopRevisions: [{ id: db.generateId('sr'), date, oldStop: 0, newStop: stop, actionSource:'Manual', notes:'Initial stop' }],
          partialExits: [], finalExit: null, notes: [], alerts: [],
          ruleFollowed: true, reviewStatus: 'Pending', rating: 0,
          chartLink: `https://www.tradingview.com/chart/?symbol=NSE:${symbol}`, tags: [sector],
          cmp, createdAt: date, closedAt: null
        };
        await db.saveTrade(trade);
        app.closeModal();
        app.toast(`Trade added: ${symbol}`, 'success');
        await init();
      }}
    ]);
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

  return { init, _onRowClick, _closePanel, _toggleFullscreen, _showExitModal, _showPyramidModal, _showStopModal, _showNoteModal, _showCmpModal, _autoCalcTrade, _autoCalcExitCharges, _autoCalcPyramidCharges, _editLifecycleRow, _deleteLifecycleRow, _deleteTrade };
})();
