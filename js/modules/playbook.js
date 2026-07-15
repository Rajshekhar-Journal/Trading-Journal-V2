/**
 * playbook.js — Module 04: Playbook
 * Trading setup library with versioning and performance analytics.
 */
const playbookModule = (() => {
  let _selectedPbId = null;
  let _cachedPb     = null;  // in-memory copy of the open playbook; mutated directly to avoid stale re-fetch

  async function init() {
    await _renderSummaryCards();
    await _renderTable();
    _setupSearch();
    _setupNewBtn();
  }

  async function _getPlaybookTrades(pbId) {
    const closed = await db.getClosedTrades();
    return closed.filter(t => t.playbookId === pbId);
  }

  async function _renderSummaryCards() {
    const pbs = await db.getPlaybooks();
    const active = pbs.filter(p => p.status === 'Active').length;
    const archived = pbs.filter(p => p.status === 'Archived').length;
    const drafts = pbs.filter(p => p.status === 'Draft').length;
    const closed = await db.getClosedTrades();
    const linked = closed.filter(t => t.playbookId).length;
    let bestName = '—', bestExp = -Infinity;
    for (const pb of pbs.filter(p => p.status === 'Active')) {
      const trades = await _getPlaybookTrades(pb.id);
      const exp = calc.getExpectancy(trades);
      if (exp > bestExp) { bestExp = exp; bestName = pb.name; }
    }
    const el = document.getElementById('pb-summary-cards');
    if (!el) return;
    el.innerHTML = [
      { label: 'Total Playbooks', value: pbs.length, icon: '📚' },
      { label: 'Active', value: active, icon: '✅', cls: 'positive' },
      { label: 'Archived', value: archived, icon: '🗃️' },
      { label: 'Draft Versions', value: drafts, icon: '📝' },
      { label: 'Linked Trades', value: linked, icon: '🔗' },
      { label: 'Best Performing', value: bestName, icon: '🏆', small: true },
    ].map(c => `<div class="stat-card">
      <div class="stat-card-icon">${c.icon}</div>
      <div class="stat-card-label">${c.label}</div>
      <div class="stat-card-value ${c.cls ? 'text-success' : ''}" style="${c.small ? 'font-size:14px' : ''}">${c.value}</div>
    </div>`).join('');
  }

  async function _renderTable(filter = '') {
    const tbody = document.getElementById('pb-table-body');
    if (!tbody) return;
    const statusFilter = document.getElementById('pb-filter-status')?.value || '';
    let pbs = await db.getPlaybooks();
    if (filter) pbs = pbs.filter(p => p.name.toLowerCase().includes(filter.toLowerCase()));
    if (statusFilter) pbs = pbs.filter(p => p.status === statusFilter);
    if (!pbs.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="no-data"><div class="no-data-icon">📚</div>No playbooks found.</div></td></tr>`;
      return;
    }
    const rows = await Promise.all(pbs.map(async pb => {
      const trades = await _getPlaybookTrades(pb.id);
      const wr = calc.getWinRate(trades);
      const { avgWinR } = calc.getAvgWinLoss(trades);
      const exp = calc.getExpectancy(trades);
      const stBadge = pb.status === 'Active' ? 'badge-success' : pb.status === 'Draft' ? 'badge-info' : 'badge-muted';
      return `<tr data-id="${pb.id}" onclick="playbookModule._onRowClick('${pb.id}')">
        <td><strong>${pb.name}</strong></td>
        <td>v${pb.currentVersion}</td>
        <td><span class="badge ${stBadge}">${pb.status}</span></td>
        <td>${pb.category || '—'}</td>
        <td>${trades.length}</td>
        <td>${trades.length > 0 ? wr.toFixed(1) + '%' : '—'}</td>
        <td>${trades.length > 0 ? avgWinR.toFixed(2) + 'R' : '—'}</td>
        <td class="${exp >= 0 ? 'text-success' : 'text-danger'}">${trades.length > 0 ? calc.formatR(exp) : '—'}</td>
      </tr>`;
    }));
    tbody.innerHTML = rows.join('');
  }

  async function _onRowClick(id) {
    _selectedPbId = id;
    document.querySelectorAll('#pb-table-body tr').forEach(r => r.classList.remove('selected'));
    document.querySelector(`#pb-table-body tr[data-id="${id}"]`)?.classList.add('selected');
    await _renderDetailPanel(id);
  }

  async function _renderDetailPanel(pbId) {
    const panel = document.getElementById('pb-detail-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    const pb = await db.getPlaybookById(pbId);
    if (!pb) return;
    _cachedPb = pb;  // prime the in-memory cache
    const ver = pb;  // flat Supabase schema: pb IS the version
    const stBadge = pb.status === 'Active' ? 'badge-success' : pb.status === 'Draft' ? 'badge-info' : 'badge-muted';

    panel.innerHTML = `
      <div class="detail-panel">
        <div class="detail-panel-header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span class="detail-symbol" style="font-size:15px">${pb.name}</span>
              <span class="badge ${stBadge}">${pb.status}</span>
              <span class="badge badge-muted">v${pb.currentVersion}</span>
            </div>
            <div class="detail-sub">${pb.category || 'Uncategorized'} · Created ${calc.formatDate(pb.createdAt || '')}</div>
          </div>
          <button class="detail-close-btn" onclick="playbookModule._closePanel()">✕</button>
        </div>
        <div class="detail-panel-body">
          <div class="detail-tab-bar">
            <button class="detail-tab-btn active" data-dtab="info">Setup Info</button>
            <button class="detail-tab-btn" data-dtab="entry">Entry Rules</button>
            <button class="detail-tab-btn" data-dtab="exit">Exit Rules</button>
            <button class="detail-tab-btn" data-dtab="risk">Risk Rules</button>
            <button class="detail-tab-btn" data-dtab="checklist">Checklist</button>
            <button class="detail-tab-btn" data-dtab="trades">Linked Trades</button>
            <button class="detail-tab-btn" data-dtab="analytics">Analytics</button>
            <button class="detail-tab-btn" data-dtab="history">Versions</button>
          </div>
          <div id="pb-dtab-content">${_tabInfo(pb, ver, pbId)}</div>
          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap" id="pb-action-row">
            ${pb.status === 'Active' ? `<button class="btn btn-secondary btn-sm" onclick="playbookModule._archivePlaybook('${pbId}')">Archive</button><button class="btn btn-primary btn-sm" onclick="playbookModule._newVersion('${pbId}')">Create New Version</button>` : ''}
            ${pb.status === 'Draft' ? `<button class="btn btn-success btn-sm" onclick="playbookModule._publishPlaybook('${pbId}')">Publish</button>` : ''}
          </div>
        </div>
      </div>`;

    panel.querySelectorAll('.detail-tab-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        panel.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tc = document.getElementById('pb-dtab-content');
        if (!tc) return;
        const tab = btn.dataset.dtab;
        // ALWAYS use _cachedPb — it is the single source of truth.
        // Mutations (_addEntryRule, _saveExitRules etc.) update _cachedPb in-place and then
        // persist to Supabase. We must NEVER re-fetch here; a stale read would silently
        // overwrite rules that were added but not yet fully replicated by Supabase.
        const p = _cachedPb;
        if (!p) return;
        if (tab === 'info')           tc.innerHTML = _tabInfo(p, p, pbId);
        else if (tab === 'entry')     tc.innerHTML = _tabEntryRules(p, p, pbId);
        else if (tab === 'exit')      tc.innerHTML = _tabExitRules(p, p, pbId);
        else if (tab === 'risk')      tc.innerHTML = _tabRiskRules(p, p, pbId);
        else if (tab === 'checklist') tc.innerHTML = _tabChecklist(p, p, pbId);
        // Trades/Analytics/History only fetch *trade* data internally — not the playbook object
        else if (tab === 'trades')    tc.innerHTML = await _tabLinkedTrades(p);
        else if (tab === 'analytics') tc.innerHTML = await _tabAnalytics(p);
        else if (tab === 'history')   tc.innerHTML = _tabVersionHistory(p);
      });
    });
  }

  function _tabInfo(pb, ver, pbId) {
    // ver === pb in flat schema; read directly from pb fields
    return `<div>
      <div class="form-group"><label class="form-label">Objective</label><textarea class="form-input form-textarea" id="pb-objective" rows="2">${pb.objective || ''}</textarea></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Market Type</label><input class="form-input" id="pb-mkttype" value="${pb.marketType || ''}"></div>
        <div class="form-group"><label class="form-label">Suitable Trend</label><input class="form-input" id="pb-trend" value="${pb.suitableTrend || ''}"></div>
        <div class="form-group"><label class="form-label">Risk Category</label><select class="form-select" id="pb-riskcat">
          ${['Low','Low-Medium','Medium','High'].map(r => `<option ${pb.riskCategory === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select></div>
        <div class="form-group"><label class="form-label">Ideal Holding Period</label><input class="form-input" id="pb-holding" value="${pb.idealHoldingPeriod || ''}"></div>
      </div>
      <div class="form-group"><label class="form-label">Description</label><textarea class="form-input form-textarea" id="pb-desc" rows="3">${pb.description || ''}</textarea></div>
      <div class="settings-save-bar"><button class="btn btn-secondary btn-sm" onclick="playbookModule._saveInfo('${pbId}')">Save Changes</button></div>
    </div>`;
  }

  async function _saveInfo(pbId) {
    // Mutate _cachedPb directly — DO NOT re-fetch from DB.
    // A fresh db.getPlaybookById() here could return a stale snapshot that overwrites
    // entry rules (or other mutations) that were saved but not yet replicated by Supabase.
    if (!_cachedPb) return;
    _cachedPb.objective          = document.getElementById('pb-objective')?.value  || '';
    _cachedPb.description        = document.getElementById('pb-desc')?.value       || '';
    _cachedPb.marketType         = document.getElementById('pb-mkttype')?.value    || '';
    _cachedPb.suitableTrend      = document.getElementById('pb-trend')?.value      || '';
    _cachedPb.riskCategory       = document.getElementById('pb-riskcat')?.value    || '';
    _cachedPb.idealHoldingPeriod = document.getElementById('pb-holding')?.value    || '';
    await db.savePlaybook(_cachedPb);
    app.toast('Playbook saved', 'success');
  }

  function _tabEntryRules(pb, ver, pbId) {
    const rules = ver.entryRules || [];
    return `<div>
      <ul class="rule-list" id="pb-entry-rules">${rules.map((r, i) => `<li class="rule-list-item"><span class="rule-num">${i+1}.</span><span>${r}</span><span class="rule-delete" onclick="playbookModule._deleteEntryRule('${pbId}',${i})">✕</span></li>`).join('')}</ul>
      <div class="add-rule-row"><input class="form-input" id="pb-new-entry-rule" placeholder="Add entry rule..."><button class="btn btn-primary btn-sm" onclick="playbookModule._addEntryRule('${pbId}')">Add</button></div>
    </div>`;
  }

  async function _addEntryRule(pbId) {
    const input = document.getElementById('pb-new-entry-rule');
    const rule = input?.value.trim();
    if (!rule) return;
    // Use cached pb — never re-fetch; avoids Supabase stale-read race
    if (!_cachedPb) return;
    _cachedPb.entryRules = [...(_cachedPb.entryRules || []), rule];
    await db.savePlaybook(_cachedPb);
    app.toast('Rule added', 'success');
    const tc = document.getElementById('pb-dtab-content');
    if (tc) tc.innerHTML = _tabEntryRules(_cachedPb, _cachedPb, pbId);
  }

  async function _deleteEntryRule(pbId, idx) {
    if (!_cachedPb) return;
    _cachedPb.entryRules = (_cachedPb.entryRules || []).filter((_, i) => i !== idx);
    await db.savePlaybook(_cachedPb);
    const tc = document.getElementById('pb-dtab-content');
    if (tc) tc.innerHTML = _tabEntryRules(_cachedPb, _cachedPb, pbId);
  }

  function _tabExitRules(pb, ver, pbId) {
    const er = ver.exitRules || {};
    return `<div>
      <div class="form-section-title">Structured Exit Rules</div>
      <div class="settings-row"><div><div class="settings-row-label">Day-5 Exit Rule</div><div class="settings-row-desc">Exit if trade hasn't moved significantly by day 5</div></div>
        <label class="toggle-switch"><input type="checkbox" id="er-day5" ${er.day5Rule ? 'checked' : ''} onchange="playbookModule._saveExitRules('${pbId}')"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row"><div><div class="settings-row-label">ATR Extension Exit</div><div class="settings-row-desc">Exit when price extends beyond ATR threshold</div></div>
        <label class="toggle-switch"><input type="checkbox" id="er-atr" ${er.atrExtension ? 'checked' : ''} onchange="playbookModule._saveExitRules('${pbId}')"><span class="toggle-slider"></span></label>
      </div>
      <div class="settings-row"><div><div class="settings-row-label">EMA20 Exit Signal</div><div class="settings-row-desc">Exit when price breaks below EMA20</div></div>
        <label class="toggle-switch"><input type="checkbox" id="er-ema" ${er.ema20Exit ? 'checked' : ''} onchange="playbookModule._saveExitRules('${pbId}')"><span class="toggle-slider"></span></label>
      </div>
      <div class="form-section-title">Custom Rules</div>
      <ul class="rule-list">${(er.customRules || []).map((r,i) => `<li class="rule-list-item"><span class="rule-num">${i+1}.</span><span>${r}</span></li>`).join('')}</ul>
    </div>`;
  }

  async function _saveExitRules(pbId) {
    if (!_cachedPb) return;
    _cachedPb.exitRules = { ...(_cachedPb.exitRules || {}),
      day5Rule:     document.getElementById('er-day5')?.checked,
      atrExtension: document.getElementById('er-atr')?.checked,
      ema20Exit:    document.getElementById('er-ema')?.checked,
    };
    await db.savePlaybook(_cachedPb);
  }

  function _tabRiskRules(pb, ver, pbId) {
    const rr = ver.riskRules || {};
    return `<div class="form-grid">
      <div class="form-group"><label class="form-label">Max Initial Risk (R)</label><input class="form-input" type="number" id="rr-maxrisk" step="0.25" value="${rr.maxInitialRisk || 1}"></div>
      <div class="form-group"><label class="form-label">Max Pyramid Count</label><input class="form-input" type="number" id="rr-maxpyr" min="0" value="${rr.maxPyramid || 1}"></div>
      <div class="form-group"><label class="form-label">Portfolio Heat Guideline (R)</label><input class="form-input" type="number" id="rr-heat" step="0.5" value="${rr.portfolioHeatGuideline || 4}"></div>
    </div>
    <div class="settings-save-bar"><button class="btn btn-secondary btn-sm" onclick="playbookModule._saveRiskRules('${pbId}')">Save</button></div>`;
  }

  async function _saveRiskRules(pbId) {
    if (!_cachedPb) return;
    _cachedPb.riskRules = {
      maxInitialRisk:         parseFloat(document.getElementById('rr-maxrisk')?.value) || 1,
      maxPyramid:             parseInt(document.getElementById('rr-maxpyr')?.value)    || 1,
      portfolioHeatGuideline: parseFloat(document.getElementById('rr-heat')?.value)   || 5,
    };
    await db.savePlaybook(_cachedPb);
    app.toast('Risk rules saved', 'success');
  }

  function _tabChecklist(pb, ver, pbId) {
    const items = ver.checklist || [];
    return `<div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Pre-trade checklist — all items must be ✓ before entering this setup.</p>
      <ul class="rule-list" id="pb-checklist">${items.map((item, i) => `<li class="rule-list-item"><input type="checkbox" style="accent-color:var(--primary)"><span style="flex:1">${item}</span><span class="rule-delete" onclick="playbookModule._deleteChecklist('${pbId}',${i})">✕</span></li>`).join('')}</ul>
      <div class="add-rule-row"><input class="form-input" id="pb-new-checklist" placeholder="Add checklist item..."><button class="btn btn-primary btn-sm" onclick="playbookModule._addChecklist('${pbId}')">Add</button></div>
    </div>`;
  }

  async function _addChecklist(pbId) {
    const input = document.getElementById('pb-new-checklist');
    const item = input?.value.trim();
    if (!item) return;
    if (!_cachedPb) return;
    _cachedPb.checklist = [...(_cachedPb.checklist || []), item];
    await db.savePlaybook(_cachedPb);
    app.toast('Checklist item added', 'success');
    const tc = document.getElementById('pb-dtab-content');
    if (tc) tc.innerHTML = _tabChecklist(_cachedPb, _cachedPb, pbId);
  }

  async function _deleteChecklist(pbId, idx) {
    if (!_cachedPb) return;
    _cachedPb.checklist = (_cachedPb.checklist || []).filter((_, i) => i !== idx);
    await db.savePlaybook(_cachedPb);
    const tc = document.getElementById('pb-dtab-content');
    if (tc) tc.innerHTML = _tabChecklist(_cachedPb, _cachedPb, pbId);
  }

  async function _tabLinkedTrades(pb) {
    const trades = await _getPlaybookTrades(pb.id);
    if (!trades.length) return `<div class="no-data">No closed trades linked to this playbook.</div>`;
    return `<table class="data-table"><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R</th><th>Result</th></tr></thead>
      <tbody>${trades.map(t => { const m = calc.getTradeMetrics(t); const r = calc.getTradeResult(t); return `<tr>
        <td><strong>${t.symbol}</strong></td>
        <td>${calc.formatDate(t.entries?.[0]?.date)}</td>
        <td>${calc.formatDate(t.finalExit?.date)}</td>
        <td class="${m.realizedPnl >= 0 ? 'text-success' : 'text-danger'} font-mono">${calc.formatCurrency(m.realizedPnl)}</td>
        <td class="${m.profitR >= 0 ? 'text-success' : 'text-danger'} font-mono">${calc.formatR(m.profitR)}</td>
        <td><span class="badge ${r === 'Win' ? 'badge-success' : r === 'Loss' ? 'badge-danger' : 'badge-muted'}">${r}</span></td>
      </tr>`; }).join('')}</tbody></table>`;
  }

  async function _tabAnalytics(pb) {
    const trades = await _getPlaybookTrades(pb.id);
    if (!trades.length) return `<div class="no-data">No trades to analyze.</div>`;
    const wr = calc.getWinRate(trades);
    const { avgWinR, avgLossR } = calc.getAvgWinLoss(trades);
    const exp = calc.getExpectancy(trades);
    const netR = calc.getTotalR(trades);
    const avgDays = trades.reduce((s,t) => s + calc.getTradeMetrics(t).holdingDays, 0) / trades.length;
    return `<div class="metric-grid">
      <div class="metric-item"><div class="metric-label">Trades</div><div class="metric-value">${trades.length}</div></div>
      <div class="metric-item"><div class="metric-label">Win Rate</div><div class="metric-value ${wr >= 40 ? 'positive' : 'negative'}">${wr.toFixed(1)}%</div></div>
      <div class="metric-item"><div class="metric-label">Avg Win</div><div class="metric-value positive">${avgWinR.toFixed(2)}R</div></div>
      <div class="metric-item"><div class="metric-label">Avg Loss</div><div class="metric-value negative">${avgLossR.toFixed(2)}R</div></div>
      <div class="metric-item"><div class="metric-label">Expectancy</div><div class="metric-value ${exp >= 0 ? 'positive' : 'negative'}">${calc.formatR(exp)}</div></div>
      <div class="metric-item"><div class="metric-label">Net R</div><div class="metric-value ${netR >= 0 ? 'positive' : 'negative'}">${calc.formatR(netR)}</div></div>
      <div class="metric-item"><div class="metric-label">Avg Holding</div><div class="metric-value">${avgDays.toFixed(0)} days</div></div>
      <div class="metric-item"><div class="metric-label">Net P&L</div><div class="metric-value ${calc.getTotalPnl(trades) >= 0 ? 'positive' : 'negative'}">${calc.formatCurrency(calc.getTotalPnl(trades))}</div></div>
    </div>`;
  }

  function _tabVersionHistory(pb) {
    const vers = (pb.versions || []).slice().reverse();
    return `<div class="version-history">${vers.map(v => `<div class="version-item">
      <span class="version-num">v${v.version}</span>
      <span class="badge ${v.status === 'Active' ? 'badge-success' : v.status === 'Draft' ? 'badge-info' : 'badge-muted'}">${v.status}</span>
      <span class="version-date">${calc.formatDate(v.createdAt || '')}</span>
      <span style="flex:1;font-size:12px;color:var(--text-muted)">${v.improvements || v.objective?.substring(0,60) || ''}</span>
    </div>`).join('')}</div>`;
  }

  async function _archivePlaybook(pbId) {
    if (!confirm('Archive this playbook?')) return;
    const pb = await db.getPlaybookById(pbId);
    await db.savePlaybook({ ...pb, status: 'Archived' });
    app.toast('Playbook archived', 'success');
    await init();
    await _renderDetailPanel(pbId);
  }

  async function _publishPlaybook(pbId) {
    const pb = await db.getPlaybookById(pbId);
    await db.savePlaybook({ ...pb, status: 'Active' });
    app.toast('Playbook published!', 'success');
    await init();
    await _renderDetailPanel(pbId);
  }

  async function _newVersion(pbId) {
    const pb = await db.getPlaybookById(pbId);
    const latestVer = parseFloat(pb.currentVersion) || 1.0;
    const newVerStr = (latestVer + 0.1).toFixed(1);
    const curVer = pb.versions.find(v => v.version === pb.currentVersion) || {};
    const newVer = { ...curVer, version: newVerStr, status: 'Draft', createdAt: new Date().toISOString().split('T')[0], improvements: '' };
    const updated = { ...pb, currentVersion: newVerStr, status: 'Draft', versions: [...pb.versions, newVer] };
    await db.savePlaybook(updated);
    app.toast(`Version ${newVerStr} created as Draft`, 'success');
    await init();
    await _renderDetailPanel(pbId);
  }

  function _setupSearch() {
    const search = document.getElementById('pb-search');
    const statusF = document.getElementById('pb-filter-status');
    if (search) { const f = search.cloneNode(true); search.parentNode.replaceChild(f, search); f.addEventListener('input', async () => await _renderTable(f.value)); }
    if (statusF) { const f = statusF.cloneNode(true); statusF.parentNode.replaceChild(f, statusF); f.addEventListener('change', async () => await _renderTable(document.getElementById('pb-search')?.value || '')); }
  }

  function _setupNewBtn() {
    const btn = document.getElementById('btn-new-playbook');
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => {
      const content = `<div class="form-grid">
        <div class="form-group"><label class="form-label">Playbook Name *</label><input class="form-input" id="np-name" placeholder="e.g. Stage 2 Breakout"></div>
        <div class="form-group"><label class="form-label">Category</label>
          <select class="form-select" id="np-category"><option>Momentum</option><option>Trend Following</option><option>Reversal</option><option>Breakout</option><option>Gap</option><option>Other</option></select>
        </div>
        <div class="form-group form-full"><label class="form-label">Objective</label><textarea class="form-input form-textarea" id="np-objective" placeholder="What is this setup trying to capture?" rows="3"></textarea></div>
      </div>`;
      app.openModal('New Playbook', content, [
        { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
        { id: 'save', label: 'Create Playbook', class: 'btn-primary', onClick: async () => {
          const name = document.getElementById('np-name')?.value.trim();
          const category = document.getElementById('np-category')?.value;
          const objective = document.getElementById('np-objective')?.value.trim();
          if (!name) { app.toast('Enter a playbook name', 'error'); return; }
          const today = new Date().toISOString().split('T')[0];
          const pb = { id: db.generateId('pb'), name, currentVersion: '1.0', status: 'Draft', category, createdAt: today,
            versions: [{ version: '1.0', status: 'Draft', createdAt: today, objective, description: '', marketType: '', suitableTrend: 'Uptrend', riskCategory: 'Medium', idealHoldingPeriod: '', entryRules: [], exitRules: { day5Rule: true, atrExtension: true, ema20Exit: true, customRules: [] }, riskRules: { maxInitialRisk: 1, maxPyramid: 1, portfolioHeatGuideline: 4 }, checklist: [], improvements: '' }]
          };
          await db.savePlaybook(pb);
          app.closeModal();
          app.toast(`Playbook "${name}" created as Draft`, 'success');
          await init();
        }}
      ]);
    });
  }

  function _closePanel() {
    document.getElementById('pb-detail-panel')?.classList.add('hidden');
    _selectedPbId = null;
  }

  return { init, _onRowClick, _closePanel, _saveInfo, _addEntryRule, _deleteEntryRule, _saveExitRules, _saveRiskRules, _addChecklist, _deleteChecklist, _archivePlaybook, _publishPlaybook, _newVersion };
})();
