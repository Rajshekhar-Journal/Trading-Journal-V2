/**
 * trades.js — Module 03: Trades
 * Closed trade history, performance metrics, detail panel with full lifecycle.
 * Fixes: edit/delete lifecycle, missing columns, realized P&L in lifecycle,
 *        TradingView chart fix, fullscreen panel, CMP update.
 */
const tradesModule = (() => {
  let _range    = 'YTD';
  let _sortCol  = 'exitDate';
  let _sortDir  = -1;
  let _selectedId  = null;
  let _isFullscreen = false;

  async function init() {
    _setupFilters();
    await _render();
  }

  function _setupFilters() {
    document.querySelectorAll('#trades-date-filter .filter-btn').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', async () => {
        document.querySelectorAll('#trades-date-filter .filter-btn').forEach(b => b.classList.remove('active'));
        fresh.classList.add('active');
        _range = fresh.dataset.range;
        await _render();
      });
    });
    ['trades-search','trades-filter-result','trades-filter-setup'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { const fresh = el.cloneNode(true); el.parentNode.replaceChild(fresh, el); fresh.addEventListener('input', async () => _renderTable(await _getFilteredTrades())); }
    });
    // Column sort
    document.querySelectorAll('#trades-table th[data-sort]').forEach(th => {
      const fresh = th.cloneNode(true);
      th.parentNode.replaceChild(fresh, th);
      fresh.addEventListener('click', async () => {
        if (_sortCol === fresh.dataset.sort) _sortDir *= -1;
        else { _sortCol = fresh.dataset.sort; _sortDir = -1; }
        _renderTable(await _getFilteredTrades());
      });
    });
  }

  async function _getFilteredTrades() {
    let trades = calc.filterByDateRange(await db.getClosedTrades(), _range);
    const search = document.getElementById('trades-search')?.value?.toLowerCase() || '';
    const result = document.getElementById('trades-filter-result')?.value || '';
    const setup  = document.getElementById('trades-filter-setup')?.value || '';
    if (search) trades = trades.filter(t => t.symbol.toLowerCase().includes(search));
    if (result) trades = trades.filter(t => calc.getTradeResult(t) === result);
    if (setup)  trades = trades.filter(t => t.playbookId === setup);
    return trades;
  }

  async function _render() {
    const allClosed = await db.getClosedTrades();
    const filtered  = calc.filterByDateRange(allClosed, _range);
    await _populateSetupFilter(allClosed);
    _renderSummaryCards(filtered);
    _renderTable(await _getFilteredTrades());
  }

  async function _populateSetupFilter(trades) {
    const sel = document.getElementById('trades-filter-setup');
    if (!sel) return;
    const playbooks = await db.getPlaybooks();
    const usedIds   = [...new Set(trades.map(t => t.playbookId).filter(Boolean))];
    sel.innerHTML = '<option value="">All Setups</option>' +
      usedIds.map(id => { const pb = playbooks.find(p => p.id === id); return pb ? `<option value="${id}">${pb.name}</option>` : ''; }).join('');
  }

  function _renderSummaryCards(trades) {
    const el = document.getElementById('trades-summary-cards');
    if (!el) return;
    const wr        = calc.getWinRate(trades);
    const { avgWinR, avgLossR, winCount, lossCount } = calc.getAvgWinLoss(trades);
    const netR      = calc.getTotalR(trades);
    const netPnl    = calc.getTotalPnl(trades);
    const ruleBreaks= trades.filter(t => !t.ruleFollowed).length;
    const exp       = calc.getExpectancy(trades);
    const cards = [
      { label:'Total Trades', value:trades.length, sub:`${winCount}W / ${lossCount}L`, icon:'📋' },
      { label:'Win Rate', value:`${wr.toFixed(1)}%`, sub:`Break-even: ${trades.length-winCount-lossCount}`, icon:'🎯', cls:wr>=40?'positive':'negative' },
      { label:'Net P&L', value:calc.formatCurrency(netPnl), sub:`${calc.formatR(netR)}`, icon:'💰', cls:netPnl>=0?'positive':'negative' },
      { label:'Expectancy', value:calc.formatR(exp), sub:'per trade', icon:'📊', cls:exp>=0?'positive':'negative' },
      { label:'Avg Win / Loss', value:`${avgWinR.toFixed(2)}R`, sub:`Avg Loss: ${avgLossR.toFixed(2)}R`, icon:'⚖️' },
      { label:'Rule Breaks', value:ruleBreaks, sub:`${trades.length>0?((ruleBreaks/trades.length)*100).toFixed(0):0}% of trades`, icon:'⚠️', cls:ruleBreaks>0?'negative':'positive' },
    ];
    el.innerHTML = cards.map(c => `
      <div class="stat-card">
        <div class="stat-card-icon">${c.icon}</div>
        <div class="stat-card-label">${c.label}</div>
        <div class="stat-card-value ${c.cls==='positive'?'text-success':c.cls==='negative'?'text-danger':''}">${c.value}</div>
        <div class="stat-card-sub">${c.sub}</div>
      </div>`).join('');
  }

  async function _renderTable(trades) {
    const tbl = document.getElementById('trades-table');
    if (!tbl) return;
    // Update header dynamically with all SRS columns
    const thead = tbl.querySelector('thead tr');
    if (thead) {
      thead.innerHTML = `
        <th data-sort="symbol">Symbol</th>
        <th data-sort="entryDate">Entry Date</th>
        <th>Avg Entry</th>
        <th data-sort="exitDate">Exit Date</th>
        <th>Avg Exit</th>
        <th data-sort="holdingDays">Days</th>
        <th data-sort="setup">Setup</th>
        <th>Type</th>
        <th>Dir</th>
        <th data-sort="pnl">P&L (₹)</th>
        <th data-sort="profitR">R</th>
        <th>Return%</th>
        <th data-sort="result">Result</th>
        <th>Rules</th>
        <th>Review</th>`;
      // Re-attach sort listeners after header update
      thead.querySelectorAll('th[data-sort]').forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', async () => {
          if (_sortCol === th.dataset.sort) _sortDir *= -1;
          else { _sortCol = th.dataset.sort; _sortDir = -1; }
          _renderTable(await _getFilteredTrades());
        });
      });
    }

    const tbody = document.getElementById('trades-table-body');
    if (!tbody) return;
    const sorted = [...trades].sort((a,b) => {
      const ma = calc.getTradeMetrics(a), mb = calc.getTradeMetrics(b);
      const map = {
        symbol:     [a.symbol, b.symbol],
        entryDate:  [a.entries?.[0]?.date||'', b.entries?.[0]?.date||''],
        exitDate:   [a.finalExit?.date||'', b.finalExit?.date||''],
        holdingDays:[ma.holdingDays, mb.holdingDays],
        pnl:        [ma.realizedPnl, mb.realizedPnl],
        profitR:    [ma.profitR, mb.profitR],
        setup:      [a.playbookId||'', b.playbookId||''],
        result:     [calc.getTradeResult(a), calc.getTradeResult(b)],
      };
      const [va, vb] = map[_sortCol] || [0,0];
      return va < vb ? _sortDir : va > vb ? -_sortDir : 0;
    });
    if (!sorted.length) {
      tbody.innerHTML = `<tr><td colspan="15"><div class="no-data"><div class="no-data-icon">📭</div>No closed trades for this period.</div></td></tr>`;
      return;
    }
    const playbooks = await db.getPlaybooks();
    tbody.innerHTML = sorted.map(trade => {
      const m        = calc.getTradeMetrics(trade);
      const result   = calc.getTradeResult(trade);
      const pb       = playbooks.find(p => p.id === trade.playbookId);
      const rowCls   = result==='Win'?'trade-row-win':result==='Loss'?'trade-row-loss':'trade-row-be';
      const rCls     = m.profitR>0?'text-success':m.profitR<0?'text-danger':'text-muted';
      const resBadge = result==='Win'?'badge-success':result==='Loss'?'badge-danger':'badge-muted';
      const revBadge = trade.reviewStatus==='Reviewed'?'badge-success':trade.reviewStatus==='Pending'?'badge-warning':'badge-muted';
      const retPct   = m.positionSize > 0 ? ((m.realizedPnl/m.positionSize)*100).toFixed(1) : '—';
      return `<tr class="${rowCls}${!trade.ruleFollowed?' trade-row-rule-break':''}" data-id="${trade.id}" onclick="tradesModule._onRowClick('${trade.id}')">
        <td><strong>${trade.symbol}</strong></td>
        <td>${calc.formatDate(trade.entries?.[0]?.date||'')}</td>
        <td class="font-mono">₹${calc.formatNumber(m.avgEntryPrice)}</td>
        <td>${calc.formatDate(trade.finalExit?.date||'')}</td>
        <td class="font-mono">₹${calc.formatNumber(m.avgExitPrice)}</td>
        <td>${m.holdingDays}d (T: ${m.tradingDays})</td>
        <td class="text-muted">${pb?.name||'—'}</td>
        <td><span class="badge badge-muted" style="font-size:10px">${trade.tradeType||'Equity'}</span></td>
        <td><span class="badge ${trade.direction==='Long'?'badge-success':'badge-danger'}" style="font-size:10px">${trade.direction?.[0]||'L'}</span></td>
        <td class="${m.realizedPnl>=0?'text-success':'text-danger'} font-mono fw-600">${calc.formatCurrency(m.realizedPnl)}</td>
        <td class="${rCls} font-mono fw-600">${calc.formatR(m.profitR)}</td>
        <td class="${m.realizedPnl>=0?'text-success':'text-danger'}">${retPct}%</td>
        <td><span class="badge ${resBadge}">${result}</span></td>
        <td>${trade.ruleFollowed?'<span class="rule-tick">✓</span>':'<span class="rule-cross">✗</span>'}</td>
        <td><span class="badge ${revBadge}" style="font-size:10px">${trade.reviewStatus||'Pending'}</span></td>
      </tr>`;
    }).join('');
  }

  async function _onRowClick(id) {
    _selectedId = id;
    document.querySelectorAll('#trades-table-body tr').forEach(r => r.classList.remove('selected'));
    document.querySelector(`#trades-table-body tr[data-id="${id}"]`)?.classList.add('selected');
    await _renderDetailPanel(id);
  }

  async function _renderDetailPanel(tradeId) {
    const panel = document.getElementById('trades-detail-panel');
    if (!panel) return;
    panel.classList.remove('hidden');

    // Make split 50/50
    const splitView = document.getElementById('trades-split-view');
    if (splitView) {
      splitView.querySelector('.split-left')?.setAttribute('style', 'flex:1.05');
      splitView.querySelector('.split-right')?.setAttribute('style', 'flex:1');
    }

    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const m       = calc.getTradeMetrics(trade);
    const result  = calc.getTradeResult(trade);
    const pb      = await db.getPlaybookById(trade.playbookId);
    const resBadge= result==='Win'?'badge-success':result==='Loss'?'badge-danger':'badge-muted';

    panel.innerHTML = `
      <div class="detail-panel">
        <div class="detail-panel-header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="detail-symbol">${trade.symbol}</span>
              <span class="badge ${resBadge}">${result}</span>
              <span class="badge badge-muted">${trade.direction}</span>
              <span class="badge badge-muted">${trade.tradeType||'Equity'}</span>
            </div>
            <div class="detail-sub">${calc.formatDate(trade.entries?.[0]?.date)} → ${calc.formatDate(trade.finalExit?.date)} · ${m.holdingDays} days (trading days: ${m.tradingDays})</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button class="btn btn-secondary btn-sm" onclick="tradesModule._toggleFullscreen()" title="Toggle fullscreen">⛶</button>
            <button class="btn btn-danger btn-sm" onclick="tradesModule._deleteTrade('${tradeId}')" title="Delete Trade">Delete Trade</button>
            <button class="detail-close-btn" onclick="tradesModule._closePanel()">✕</button>
          </div>
        </div>
        <div class="detail-panel-body">
          <div class="metric-grid">
            <div class="metric-item"><div class="metric-label">Avg Entry</div><div class="metric-value">₹${calc.formatNumber(m.avgEntryPrice)}</div></div>
            <div class="metric-item"><div class="metric-label">Avg Exit</div><div class="metric-value">₹${calc.formatNumber(m.avgExitPrice)}</div></div>
            <div class="metric-item"><div class="metric-label">Net P&L</div><div class="metric-value ${m.realizedPnl>=0?'positive':'negative'}">${calc.formatCurrency(m.realizedPnl)}</div></div>
            <div class="metric-item"><div class="metric-label">Result (R)</div><div class="metric-value ${m.profitR>=0?'positive':'negative'}">${calc.formatR(m.profitR)}</div></div>
            <div class="metric-item"><div class="metric-label">RPT</div><div class="metric-value">₹${calc.formatNumber(m.initialRPT)}</div></div>
            <div class="metric-item"><div class="metric-label">Return %</div><div class="metric-value ${m.realizedPnl>=0?'positive':'negative'}">${m.positionSize>0?((m.realizedPnl/m.positionSize)*100).toFixed(2)+'%':'—'}</div></div>
            <div class="metric-item"><div class="metric-label">Setup</div><div class="metric-value" style="font-size:12px">${pb?.name||'—'}</div></div>
            <div class="metric-item"><div class="metric-label">Total Charges</div><div class="metric-value">₹${calc.formatNumber(m.totalCharges)}</div></div>
          </div>
          <div class="detail-tab-bar">
            <button class="detail-tab-btn active" data-dtab="overview">Overview</button>
            <button class="detail-tab-btn" data-dtab="lifecycle">Lifecycle</button>
            <button class="detail-tab-btn" data-dtab="stops">Stops</button>
            <button class="detail-tab-btn" data-dtab="notes">Notes</button>
            <button class="detail-tab-btn" data-dtab="chart">Chart</button>
          </div>
          <div id="trades-dtab-content">${_tabOverview(trade, m, pb)}</div>
        </div>
      </div>`;

    panel.querySelectorAll('.detail-tab-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        panel.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const t   = await db.getTradeById(tradeId);
        const tm  = calc.getTradeMetrics(t);
        const tpb = await db.getPlaybookById(t.playbookId);
        const tc  = document.getElementById('trades-dtab-content');
        if (!tc) return;
        const tab = btn.dataset.dtab;
        if (tab==='overview')  { tc.innerHTML = _tabOverview(t,tm,tpb); _setupOverviewTab(t,tradeId); }
        else if (tab==='lifecycle') tc.innerHTML = _tabLifecycle(t, tradeId);
        else if (tab==='stops')    tc.innerHTML = _tabStops(t);
        else if (tab==='notes')    tc.innerHTML = _tabNotes(t,tradeId);
        else if (tab==='chart')    tc.innerHTML = _tabChart(t);
      });
    });
    _setupOverviewTab(trade, tradeId);

    // Re-apply fullscreen state if currently in fullscreen (panel HTML was just rebuilt)
    if (_isFullscreen) {
      const splitView  = document.getElementById('trades-split-view');
      const tablePanel = document.getElementById('trades-table-panel');
      const detPanel   = document.getElementById('trades-detail-panel');
      tablePanel?.classList.add('hidden');
      if (detPanel) detPanel.style.cssText = 'flex:1;min-width:0;';
      if (splitView) splitView.style.height = 'calc(100vh - 200px)';
    }
  }

  function _tabOverview(trade, m, pb) {
    const stars    = [1,2,3,4,5].map(i => `<span class="star ${i<=(trade.rating||0)?'active':''}" data-star="${i}">★</span>`).join('');
    const revStatus= ['Pending','Reviewed','Needs Work'].map(s => `<option ${trade.reviewStatus===s?'selected':''}>${s}</option>`).join('');
    return `
      <div class="settings-row"><div><div class="settings-row-label">Trade Type</div></div><div><span class="badge badge-muted">${trade.tradeType}</span></div></div>
      <div class="settings-row"><div><div class="settings-row-label">Direction</div></div><div><span class="badge ${trade.direction==='Long'?'badge-success':'badge-danger'}">${trade.direction}</span></div></div>
      <div class="settings-row"><div><div class="settings-row-label">Playbook</div></div><div><span>${pb?.name||'—'}</span></div></div>
      <div class="settings-row"><div><div class="settings-row-label">Rules Followed</div></div><div><label class="toggle-switch"><input type="checkbox" id="ov-rule" ${trade.ruleFollowed?'checked':''}><span class="toggle-slider"></span></label></div></div>
      <div class="settings-row"><div><div class="settings-row-label">Rating</div></div><div><div class="star-rating" id="ov-stars">${stars}</div></div></div>
      <div class="settings-row"><div><div class="settings-row-label">Review Status</div></div><div><select class="form-select form-select-sm" id="ov-review" style="width:130px">${revStatus}</select></div></div>
      <div class="settings-row"><div><div class="settings-row-label">Total Charges</div></div><div><span class="font-mono">₹${calc.formatNumber(m.totalCharges)}</span></div></div>
      ${trade.chartLink ? `<div style="margin-top:10px"><a href="${trade.chartLink}" target="_blank" class="btn btn-secondary btn-sm">📈 Open Chart in TradingView</a></div>` : ''}`;
  }

  function _setupOverviewTab(trade, tradeId) {
    const ruleEl   = document.getElementById('ov-rule');
    const reviewEl = document.getElementById('ov-review');
    const starsEl  = document.getElementById('ov-stars');
    const save = async () => {
      const t = await db.getTradeById(tradeId);
      if (!t) return;
      await db.saveTrade({ ...t, ruleFollowed: ruleEl?.checked ?? t.ruleFollowed, reviewStatus: reviewEl?.value || t.reviewStatus });
      app.toast('Saved', 'success');
      _renderTable(await _getFilteredTrades());
    };
    ruleEl?.addEventListener('change', save);
    reviewEl?.addEventListener('change', save);
    starsEl?.querySelectorAll('.star').forEach(star => {
      star.addEventListener('click', async () => {
        const rating = parseInt(star.dataset.star);
        const t = await db.getTradeById(tradeId);
        await db.saveTrade({ ...t, rating });
        starsEl.querySelectorAll('.star').forEach((s,i) => s.classList.toggle('active', i<rating));
      });
    });
  }

  // ── Lifecycle Tab with Edit/Delete and Realized P&L summary ───────────────
  function _tabLifecycle(trade, tradeId) {
    const rows = [];
    (trade.entries     || []).forEach(e => rows.push({ type:'Entry',        id:e.id, date:e.date, price:e.price, qty:e.qty, charges:e.charges||0 }));
    (trade.pyramids    || []).forEach(p => rows.push({ type:'Pyramid',      id:p.id, date:p.date, price:p.price, qty:p.qty, charges:p.charges||0 }));
    (trade.partialExits|| []).forEach(p => rows.push({ type:'Partial Exit', id:p.id, date:p.date, price:p.price, qty:p.qty, charges:p.charges||0 }));
    if (trade.finalExit) rows.push({ type:'Final Exit', id:trade.finalExit.id||'fe', date:trade.finalExit.date, price:trade.finalExit.price, qty:trade.finalExit.qty, charges:trade.finalExit.charges||0 });
    rows.sort((a,b) => (a.date||'').localeCompare(b.date||''));
    if (!rows.length) return `<div class="no-data">No transactions.</div>`;
    const m = calc.getTradeMetrics(trade);
    const tid = trade.id;
    return `<table class="data-table">
      <thead><tr><th>Type</th><th>Date</th><th>Price</th><th>Qty</th><th>Charges</th><th style="width:70px">Actions</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td><span class="badge ${r.type.includes('Exit')?'badge-danger':r.type==='Pyramid'?'badge-success':'badge-primary'}">${r.type}</span></td>
        <td>${calc.formatDate(r.date)}</td>
        <td class="font-mono">₹${calc.formatNumber(r.price)}</td>
        <td>${r.qty}</td>
        <td class="font-mono">₹${calc.formatNumber(r.charges)}</td>
        <td>
          <button class="btn btn-secondary btn-xs" title="Edit" onclick="tradesModule._editLifecycleRow('${tid}','${r.type}','${r.id}')">✏</button>
          <button class="btn btn-danger btn-xs" title="Delete" onclick="tradesModule._deleteLifecycleRow('${tid}','${r.type}','${r.id}')">🗑</button>
        </td>
      </tr>`).join('')}</tbody>
      <tfoot><tr>
        <td colspan="3" style="font-size:12px;color:var(--text-muted)">Realized P&L</td>
        <td colspan="3" class="font-mono fw-600 ${m.realizedPnl>=0?'text-success':'text-danger'}">${calc.formatCurrency(m.realizedPnl)} (${calc.formatR(m.profitR)})</td>
      </tr></tfoot>
    </table>`;
  }

  async function _deleteLifecycleRow(tradeId, type, recordId) {
    if (!confirm(`Delete this ${type} record? Metrics will recalculate automatically.`)) return;
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    const updated = { ...trade };
    if (type === 'Entry') {
      if ((trade.entries||[]).length <= 1) { app.toast('Cannot delete the only entry. Delete entire trade instead.','error'); return; }
      updated.entries = trade.entries.filter(e => e.id !== recordId);
    } else if (type === 'Pyramid') {
      updated.pyramids = (trade.pyramids||[]).filter(p => p.id !== recordId);
    } else if (type === 'Partial Exit') {
      updated.partialExits = (trade.partialExits||[]).filter(p => p.id !== recordId);
    } else if (type === 'Final Exit') {
      updated.finalExit = null;
    }
    await db.saveTrade(updated);
    app.toast(`${type} deleted — metrics recalculated.`, 'success');
    await _render();
    await _renderDetailPanel(tradeId);
    document.querySelector('.detail-tab-btn[data-dtab="lifecycle"]')?.click();
  }

  async function _editLifecycleRow(tradeId, type, recordId) {
    const trade = await db.getTradeById(tradeId);
    if (!trade) return;
    let record;
    if (type==='Entry')          record = (trade.entries||[]).find(e => e.id===recordId);
    else if (type==='Pyramid')   record = (trade.pyramids||[]).find(p => p.id===recordId);
    else if (type==='Partial Exit') record = (trade.partialExits||[]).find(p => p.id===recordId);
    else if (type==='Final Exit')   record = trade.finalExit;
    if (!record) return;

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="el-date" value="${record.date}"></div>
      <div class="form-group"><label class="form-label">Price (₹)</label><input class="form-input" type="number" id="el-price" step="0.05" value="${record.price}"></div>
      <div class="form-group"><label class="form-label">Qty</label><input class="form-input" type="number" id="el-qty" min="1" value="${record.qty}"></div>
      <div class="form-group"><label class="form-label">Charges (₹)</label><input class="form-input" type="number" id="el-charges" step="0.01" value="${record.charges||0}"></div>
    </div>`;
    app.openModal(`Edit ${type} — ${trade.symbol}`, content, [
      { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
      { id:'save', label:'Save & Recalculate', class:'btn-primary', onClick: async () => {
        const date    = document.getElementById('el-date').value;
        const price   = parseFloat(document.getElementById('el-price').value);
        const qty     = parseInt(document.getElementById('el-qty').value);
        const charges = parseFloat(document.getElementById('el-charges').value) || 0;
        if (!date||!price||!qty) { app.toast('Fill all fields','error'); return; }
        const updRec  = { ...record, date, price, qty, charges };
        const updated = { ...trade };
        if (type==='Entry')          updated.entries      = (trade.entries||[]).map(e => e.id===recordId ? updRec : e);
        else if (type==='Pyramid')   updated.pyramids     = (trade.pyramids||[]).map(p => p.id===recordId ? updRec : p);
        else if (type==='Partial Exit') updated.partialExits = (trade.partialExits||[]).map(p => p.id===recordId ? updRec : p);
        else if (type==='Final Exit')   updated.finalExit = updRec;
        await db.saveTrade(updated);
        app.closeModal();
        app.toast(`${type} updated — metrics recalculated.`,'success');
        await _render();
        await _renderDetailPanel(tradeId);
        document.querySelector('.detail-tab-btn[data-dtab="lifecycle"]')?.click();
      }}
    ]);
  }

  function _tabStops(trade) {
    const stops = trade.stopRevisions || [];
    if (!stops.length) return `<div class="no-data">No stop revisions.</div>`;
    return `<div>${stops.map((s,i) => `<div class="stop-item">
      <span class="badge badge-muted">Rev ${i+1}</span>
      <span>${calc.formatDate(s.date)}</span>
      <span class="font-mono">₹${calc.formatNumber(s.oldStop)}</span>
      <span class="stop-arrow">→</span>
      <span class="font-mono fw-600">₹${calc.formatNumber(s.newStop)}</span>
      <span class="badge badge-muted">${s.actionSource}</span>
    </div>`).join('')}</div>`;
  }

  function _tabNotes(trade, tradeId) {
    const notes = trade.notes || [];
    const today = new Date().toISOString().split('T')[0];
    return `<div>
      ${notes.map(n => `<div class="note-item"><div class="note-date">${calc.formatDate(n.date)}</div><div class="note-text">${n.text}</div></div>`).join('') || `<div class="no-data" style="padding:16px 0">No notes yet.</div>`}
      <div style="margin-top:12px">
        <input class="form-input" type="date" id="td-note-date" value="${today}" style="margin-bottom:8px">
        <textarea class="form-input form-textarea" id="td-note-text" placeholder="Add a note..." rows="3"></textarea>
        <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="tradesModule._addNote('${tradeId}')">Save Note</button>
      </div>
    </div>`;
  }

  async function _addNote(tradeId) {
    const date = document.getElementById('td-note-date').value;
    const text = document.getElementById('td-note-text').value.trim();
    if (!text) return app.toast('Enter a note','error');
    const trade = await db.getTradeById(tradeId);
    await db.saveTrade({ ...trade, notes: [...(trade.notes||[]), { id: db.generateId('nt'), date, text }] });
    app.toast('Note saved','success');
    await _renderDetailPanel(tradeId);
    document.querySelector('.detail-tab-btn[data-dtab="notes"]')?.click();
  }

  function _tabChart(trade) {
    const symbol = trade.symbol;
    const tvSym  = encodeURIComponent(`NSE:${symbol}`);
    return `<div class="tv-chart-wrap">
      <iframe
        src="https://www.tradingview.com/widgetembed/?frameElementId=tv_trade_${symbol}&symbol=${tvSym}&interval=D&hidesidetoolbar=0&symboledit=1&saveimage=1&theme=light&style=1&timezone=Asia%2FKolkata&studies=%5B%22MASimple%4020%22%2C%22MASimple%4050%22%5D&show_popup_button=1&popup_width=1000&popup_height=650&locale=en"
        width="100%" height="340" allowtransparency="true" scrolling="no" allowfullscreen>
      </iframe>
      <div style="margin-top:6px;display:flex;gap:8px;">
        <a href="https://www.tradingview.com/chart/?symbol=NSE:${symbol}" target="_blank" class="btn btn-secondary btn-sm">🔗 Open Full Chart in TradingView</a>
        <a href="https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}" target="_blank" class="btn btn-secondary btn-sm">📊 NSE Quote</a>
      </div>
    </div>`;
  }

  function _toggleFullscreen() {
    _isFullscreen = !_isFullscreen;
    const splitView  = document.getElementById('trades-split-view');
    const tablePanel = document.getElementById('trades-table-panel');
    const detPanel   = document.getElementById('trades-detail-panel');
    const fsBtn      = detPanel?.querySelector('.btn-secondary[onclick*="_toggleFullscreen"]');

    if (_isFullscreen) {
      // Enter fullscreen: force-hide table, expand detail to full width
      if (tablePanel) tablePanel.style.display = 'none';
      if (detPanel)   detPanel.style.cssText = 'flex:1;min-width:0;width:100%;';
      if (splitView)  splitView.style.cssText = 'height:calc(100vh - 200px);';
      if (fsBtn)      { fsBtn.textContent = '\u229F'; fsBtn.title = 'Minimize — return to split view'; }
    } else {
      // Exit fullscreen: restore split view
      if (tablePanel) tablePanel.style.display = '';
      if (detPanel)   detPanel.style.cssText = '';
      if (splitView)  { splitView.style.cssText = ''; splitView.querySelector('.split-left')?.removeAttribute('style'); splitView.querySelector('.split-right')?.removeAttribute('style'); }
      if (fsBtn)      { fsBtn.textContent = '\u26F6'; fsBtn.title = 'Toggle fullscreen'; }
    }
  }

  function _closePanel() {
    if (_isFullscreen) {
      _isFullscreen = false;
      const tablePanel = document.getElementById('trades-table-panel');
      if (tablePanel) tablePanel.style.display = '';
    }
    const panel     = document.getElementById('trades-detail-panel');
    const splitView = document.getElementById('trades-split-view');
    if (panel)     { panel.classList.add('hidden'); panel.style.cssText = ''; }
    if (splitView) { splitView.style.cssText = ''; splitView.querySelector('.split-left')?.removeAttribute('style'); splitView.querySelector('.split-right')?.removeAttribute('style'); }
    _selectedId = null;
  }

  async function _deleteTrade(tradeId) {
    if (!confirm('Are you sure you want to permanently delete this entire trade? This action cannot be undone.')) return;
    await db.deleteTrade(tradeId);
    app.toast('Trade deleted successfully', 'success');
    _closePanel();
    await init();
  }

  return { init, _onRowClick, _closePanel, _toggleFullscreen, _addNote, _deleteLifecycleRow, _editLifecycleRow, _deleteTrade };
})();
