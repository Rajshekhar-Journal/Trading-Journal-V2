/**
 * app.js — Application Router, Navigation & Global State
 * Initializes the app, handles module switching, toasts, modals.
 */

const app = (() => {
  let _currentModule = 'dashboard';
  const _modules = { dashboard: dashboardModule, positions: positionsModule, trades: tradesModule, playbook: playbookModule, analytics: analyticsModule, capital: capitalModule, settings: settingsModule };

  // Phase 2: async init with auth guard
  async function init() {
    // Check authentication — redirect to login if no session
    const ok = await auth.requireAuth();
    if (!ok) return;

    _setupNav();
    _setupGlobalListeners();
    const settings = await db.getSettings();
    const startModule = settings?.general?.defaultStartupModule || 'dashboard';
    navigate(startModule);
    await _updateTraderName();
  }

  function navigate(moduleId) {
    if (!_modules[moduleId]) return;
    document.querySelectorAll('.module-page').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    const page = document.getElementById(`mod-${moduleId}`);
    const btn  = document.querySelector(`.nav-btn[data-module="${moduleId}"]`);
    if (page) page.classList.add('active');
    if (btn)  btn.classList.add('active');
    _currentModule = moduleId;
    // Phase 2: all module init() are async — fire and catch errors
    try {
      const result = _modules[moduleId].init();
      if (result && typeof result.catch === 'function') {
        result.catch(e => console.error(`Error in module: ${moduleId}`, e));
      }
    } catch(e) { console.error(`Error initializing module: ${moduleId}`, e); }
  }

  function _setupNav() {
    document.querySelectorAll('.nav-btn[data-module]').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.module));
    });
  }

  function _setupGlobalListeners() {
    document.getElementById('btn-market-health')?.addEventListener('click', showMarketHealthModal);
    document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay') closeModal();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    // Phase 2: logout button
    document.getElementById('btn-logout')?.addEventListener('click', () => auth.signOut());
    // Settings change listener
    db.on('settings', async () => await _updateTraderName());
  }

  async function _updateTraderName() {
    const settings = await db.getSettings();
    const name = settings?.general?.traderName || 'Trader';
    const el = document.getElementById('trader-name');
    if (el) el.textContent = name;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function toast(message, type = 'success', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    t.innerHTML = `<span class="toast-icon">${icons[type] || '✓'}</span><span class="toast-msg">${message}</span>`;
    container.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, duration);
  }

  // ── Modal ──────────────────────────────────────────────────────────────────
  function openModal(title, content, actions = []) {
    const overlay = document.getElementById('modal-overlay');
    const container = document.getElementById('modal-container');
    if (!overlay || !container) return;
    const actionsHtml = actions.map(a => `<button class="btn ${a.class || 'btn-secondary'}" id="modal-action-${a.id}">${a.label}</button>`).join('');
    container.innerHTML = `
      <div class="modal-header">
        <h3 class="modal-title">${title}</h3>
        <button class="modal-close" onclick="app.closeModal()">✕</button>
      </div>
      <div class="modal-body">${content}</div>
      ${actionsHtml ? `<div class="modal-footer">${actionsHtml}</div>` : ''}`;
    overlay.classList.remove('hidden');
    actions.forEach(a => {
      document.getElementById(`modal-action-${a.id}`)?.addEventListener('click', () => { a.onClick?.(); });
    });
  }

  function closeModal() {
    document.getElementById('modal-overlay')?.classList.add('hidden');
    document.getElementById('modal-container').innerHTML = '';
  }

  // ── Market Health Modal (premium chart-based) ─────────────────────────────
  let _mhCharts = [];

  async function showMarketHealthModal() {
    const mh       = await db.getMarketHealth();
    const settings = await db.getSettings();
    const thr = settings?.marketHealthThresholds || { rsiOB: 70, rsiOS: 30, breadthOB: 80, breadthOS: 25 };

    const rsiVal  = mh.rsiValue   ?? null;
    const bPct    = mh.breadthPct ?? null;
    const rsiStatus  = rsiVal == null ? 'No data' : rsiVal > thr.rsiOB ? 'Overbought' : rsiVal < thr.rsiOS ? 'Oversold' : 'Neutral';
    const bStatus    = bPct  == null ? 'No data' : bPct  > thr.breadthOB ? 'Overbought' : bPct < thr.breadthOS ? 'Oversold' : 'Neutral';
    const rsiColor   = rsiVal == null ? 'var(--text-muted,#64748b)' : rsiVal > thr.rsiOB ? '#ef4444' : rsiVal < thr.rsiOS ? '#22c55e' : 'var(--text,#1e293b)';
    const bColor     = bPct  == null ? 'var(--text-muted,#64748b)' : bPct  > thr.breadthOB ? '#ef4444' : bPct  < thr.breadthOS ? '#22c55e' : 'var(--text,#1e293b)';
    const trendE     = mh.trend === 'Uptrend' ? '\u{1F7E2}' : mh.trend === 'Downtrend' ? '\u{1F534}' : '\u{1F7E1}';

    const noRsiData     = (mh.rsiHistory?.length     ?? 0) === 0;
    const noBreadthData = (mh.breadthHistory?.length  ?? 0) === 0;

    const content = `<div style="width:100%;min-width:0;">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px;">
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;">
          <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:4px;">Market Trend</div>
          <div style="font-size:17px;font-weight:700;">${trendE} ${mh.trend || 'Unknown'}</div>
          <div style="font-size:10px;color:#64748b;margin-top:3px;line-height:1.4;">
            ${mh.trend === 'Uptrend' ? 'Price > EMA20 > EMA50' : mh.trend === 'Downtrend' ? 'Price < EMA20 < EMA50' : 'Mixed EMA signals'}
          </div>
          <div style="font-size:10px;margin-top:3px;font-weight:600;color:${mh.trend === 'Uptrend' ? '#22c55e' : mh.trend === 'Downtrend' ? '#ef4444' : '#f59e0b'};">
            ${mh.trend === 'Uptrend' ? '→ Add exposure' : mh.trend === 'Downtrend' ? '→ Reduce exposure' : '→ Wait for clarity'}
          </div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;">
          <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:4px;">Breadth</div>
          <div style="font-size:17px;font-weight:700;color:#5b6af0;">${mh.breadthClassification || 'Unknown'}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">Ratio: ${mh.breadthValue ? mh.breadthValue + 'x' : '—'} (above÷below EMA20)</div>
          <div style="font-size:10px;margin-top:3px;color:#64748b;">${mh.guidance || 'Run Auto Fetch'}</div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;">
          <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:4px;">RSI (14)</div>
          <div style="font-size:17px;font-weight:700;color:${rsiColor};">${rsiVal != null ? rsiVal.toFixed(1) : '—'}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">${rsiStatus}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;line-height:1.3;">
            ${rsiVal == null ? 'Run Auto Fetch' : rsiVal > thr.rsiOB ? 'Correction risk — avoid new longs' : rsiVal < thr.rsiOS ? 'Bounce likely — watch reversals' : 'Momentum balanced'}
          </div>
        </div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;">
          <div style="font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;margin-bottom:4px;">Breadth %</div>
          <div style="font-size:17px;font-weight:700;color:${bColor};">${bPct != null ? bPct.toFixed(1) + '%' : '—'}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">${bStatus}</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;line-height:1.3;">
            ${bPct == null ? 'Run Auto Fetch' : bPct > thr.breadthOB ? 'Market overextended — reversal risk' : bPct < thr.breadthOS ? 'Market washed out — watch for bounce' : 'Healthy broad participation'}
          </div>
        </div>
      </div>

      <div style="font-size:11px;color:#5b6af0;margin-bottom:14px;margin-top:-6px;">
        <a href="#" onclick="app.closeModal();app.navigate('settings');event.preventDefault();" style="color:#5b6af0;text-decoration:none;">
          ℹ Learn how to read these metrics →
        </a>
        <span style="color:#64748b;margin-left:8px;">(Settings → General → User Manual → Market Health)</span>
      </div>

      <div style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="font-size:11px;font-weight:700;color:#f59e0b;letter-spacing:1px;">RSI (14) — NIFTY 500 INDEX</div>
          <div style="font-size:10px;color:#64748b;">OB <span style="color:#ef4444;">${thr.rsiOB}</span>&nbsp;|&nbsp;OS <span style="color:#22c55e;">${thr.rsiOS}</span></div>
        </div>
        <div id="mh-rsi-chart" style="height:195px;border-radius:8px;overflow:hidden;background:#0f172a;${noRsiData ? 'display:flex;align-items:center;justify-content:center;' : ''}">
          ${noRsiData ? '<span style="color:#64748b;font-size:12px;">No history yet — click Auto Fetch to load</span>' : ''}
        </div>
      </div>

      <div style="margin-bottom:18px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div style="font-size:11px;font-weight:700;color:#22c55e;letter-spacing:1px;">% STOCKS ABOVE 20 EMA — NIFTY 500</div>
          <div style="font-size:10px;color:#64748b;">OB <span style="color:#ef4444;">${thr.breadthOB}%</span>&nbsp;|&nbsp;OS <span style="color:#22c55e;">${thr.breadthOS}%</span></div>
        </div>
        <div id="mh-breadth-chart" style="height:195px;border-radius:8px;overflow:hidden;background:#0f172a;${noBreadthData ? 'display:flex;align-items:center;justify-content:center;' : ''}">
          ${noBreadthData ? '<span style="color:#64748b;font-size:12px;">No history yet — click Auto Fetch to load</span>' : ''}
        </div>
      </div>

      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:14px;">
        <div style="font-size:11px;font-weight:600;color:#94a3b8;margin-bottom:10px;">Customise Thresholds</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;">
          <div><label style="font-size:10px;color:#94a3b8;display:block;margin-bottom:3px;">RSI Overbought</label>
            <input class="form-input" type="number" id="mh-rsi-ob" value="${thr.rsiOB}" min="50" max="95" style="padding:6px;font-size:13px;"></div>
          <div><label style="font-size:10px;color:#94a3b8;display:block;margin-bottom:3px;">RSI Oversold</label>
            <input class="form-input" type="number" id="mh-rsi-os" value="${thr.rsiOS}" min="5" max="50" style="padding:6px;font-size:13px;"></div>
          <div><label style="font-size:10px;color:#94a3b8;display:block;margin-bottom:3px;">Breadth OB %</label>
            <input class="form-input" type="number" id="mh-breadth-ob" value="${thr.breadthOB}" min="50" max="100" style="padding:6px;font-size:13px;"></div>
          <div><label style="font-size:10px;color:#94a3b8;display:block;margin-bottom:3px;">Breadth OS %</label>
            <input class="form-input" type="number" id="mh-breadth-os" value="${thr.breadthOS}" min="0" max="50" style="padding:6px;font-size:13px;"></div>
        </div>
      </div>
      <div style="font-size:10px;color:#64748b;margin-top:10px;text-align:right;">
        Last updated: ${mh.lastUpdated || 'Never'} &nbsp;|&nbsp; Source: Yahoo Finance (Nifty 500)
      </div>
    </div>`;

    openModal('Market Health Dashboard', content, [
      { id: 'mh-close', label: 'Close', class: 'btn-secondary', onClick: () => { _destroyMhCharts(); closeModal(); } },
      { id: 'mh-thr', label: 'Save Thresholds', class: 'btn-primary', onClick: async () => {
          const newThr = {
            rsiOB:     parseInt(document.getElementById('mh-rsi-ob')?.value)     || 70,
            rsiOS:     parseInt(document.getElementById('mh-rsi-os')?.value)     || 30,
            breadthOB: parseInt(document.getElementById('mh-breadth-ob')?.value) || 80,
            breadthOS: parseInt(document.getElementById('mh-breadth-os')?.value) || 25,
          };
          const s = await db.getSettings();
          s.marketHealthThresholds = newThr;
          await db.saveSettings(s);
          toast('Thresholds saved', 'success');
          _destroyMhCharts(); closeModal();
          setTimeout(() => showMarketHealthModal(), 150);
      }},
      { id: 'mh-auto', label: 'Auto Fetch (Nifty 500)', class: 'btn-success', onClick: async () => {
          _destroyMhCharts(); closeModal();
          await updateMarketHealthAuto();
          setTimeout(() => showMarketHealthModal(), 600);
      }},
    ]);

    const mc = document.getElementById('modal-container');
    if (mc) { mc.style.maxWidth = '860px'; mc.style.width = '92vw'; }
    requestAnimationFrame(() => _renderMhCharts(mh, thr));
  }

  function _destroyMhCharts() {
    _mhCharts.forEach(c => { try { c.remove(); } catch(e) {} });
    _mhCharts = [];
    const mc = document.getElementById('modal-container');
    if (mc) { mc.style.maxWidth = ''; mc.style.width = ''; }
  }

  function _renderMhCharts(mh, thr) {
    if (typeof LightweightCharts === 'undefined') return;
    const isDark  = document.documentElement.getAttribute('data-theme') !== 'light';
    const bg      = isDark ? '#0f172a' : '#f8fafc';
    const grid    = isDark ? '#1e293b' : '#e2e8f0';
    const textCol = isDark ? '#94a3b8' : '#64748b';
    const baseOpts = {
      layout:     { background: { color: bg }, textColor: textCol, fontSize: 11 },
      grid:       { vertLines: { color: grid }, horzLines: { color: grid } },
      timeScale:  { borderColor: grid, rightOffset: 5 },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.1, bottom: 0.1 } },
      handleScroll: true, handleScale: true,
    };

    // Default visible range: last 8 months (or all available data if shorter)
    const today   = new Date();
    const toDate  = today.toISOString().split('T')[0];
    const from8   = new Date(today);
    from8.setMonth(from8.getMonth() - 8);
    const fromDate = from8.toISOString().split('T')[0];

    let rsiChart = null, bChart = null;

    // ── RSI Chart ──────────────────────────────────────────────────────────
    const rsiEl = document.getElementById('mh-rsi-chart');
    if (rsiEl && (mh.rsiHistory?.length ?? 0) > 0) {
      rsiChart = LightweightCharts.createChart(rsiEl, { ...baseOpts, height: 195, width: rsiEl.offsetWidth || 800 });
      const s = rsiChart.addLineSeries({ color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      s.setData(mh.rsiHistory.map(d => ({ time: d.date, value: d.value })));
      s.createPriceLine({ price: thr.rsiOB, color: '#ef4444', lineWidth: 1, lineStyle: 2, title: 'OB' });
      s.createPriceLine({ price: thr.rsiOS, color: '#22c55e', lineWidth: 1, lineStyle: 2, title: 'OS' });
      // Set 8-month default range
      try { rsiChart.timeScale().setVisibleRange({ from: fromDate, to: toDate }); }
      catch(e) { rsiChart.timeScale().fitContent(); }
      _mhCharts.push(rsiChart);
    }

    // ── Breadth % Chart ────────────────────────────────────────────────────
    const bEl = document.getElementById('mh-breadth-chart');
    if (bEl && (mh.breadthHistory?.length ?? 0) > 0) {
      bChart = LightweightCharts.createChart(bEl, { ...baseOpts, height: 195, width: bEl.offsetWidth || 800 });
      const s = bChart.addLineSeries({ color: '#22c55e', lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
      s.setData(mh.breadthHistory.map(d => ({ time: d.date, value: d.value })));
      s.createPriceLine({ price: thr.breadthOB, color: '#ef4444', lineWidth: 1, lineStyle: 2, title: 'OB' });
      s.createPriceLine({ price: thr.breadthOS, color: '#22c55e', lineWidth: 1, lineStyle: 2, title: 'OS' });
      // Set 8-month default range
      try { bChart.timeScale().setVisibleRange({ from: fromDate, to: toDate }); }
      catch(e) { bChart.timeScale().fitContent(); }
      _mhCharts.push(bChart);
    }

    // ── Bidirectional time-scale sync (calendar-date based, not bar-index) ────
    // Using subscribeVisibleTimeRangeChange + setVisibleRange so both charts
    // always show the same calendar window regardless of data density differences.
    if (rsiChart && bChart) {
      let _syncing = false;
      rsiChart.timeScale().subscribeVisibleTimeRangeChange(range => {
        if (_syncing || !range) return;
        _syncing = true;
        try { bChart.timeScale().setVisibleRange(range); } catch(e) {}
        _syncing = false;
      });
      bChart.timeScale().subscribeVisibleTimeRangeChange(range => {
        if (_syncing || !range) return;
        _syncing = true;
        try { rsiChart.timeScale().setVisibleRange(range); } catch(e) {}
        _syncing = false;
      });
    }
  }

  async function updateMarketHealthAuto() {
    toast('Fetching Nifty 500 data… ~30s', 'info', 35000);
    try {
      const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvcHNrdXdxbGJ0ZXlpeXB3bmlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMTI3NTksImV4cCI6MjA5OTY4ODc1OX0.gG0TU9Uf3ODJOqUu4SqZs-Uk1CKlUb47DrfULVg6vHY';
      const res = await fetch('https://zopskuwqlbteyiypwnid.supabase.co/functions/v1/market-health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}`, 'apikey': KEY }
      });
      if (!res.ok) { const t = await res.text(); throw new Error(t); }
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await db.saveMarketHealth(data);
      toast('Market Health updated from Nifty 500', 'success');
      if (_currentModule === 'dashboard') dashboardModule.init();
    } catch (e) {
      console.error(e);
      toast('Auto Fetch failed: ' + e.message, 'error');
    }
  }

  function getCurrentModule() { return _currentModule; }
  function refreshCurrentModule() { navigate(_currentModule); }

  return { init, navigate, toast, openModal, closeModal, showMarketHealthModal, updateMarketHealthAuto, getCurrentModule, refreshCurrentModule };
})();

document.addEventListener('DOMContentLoaded', () => app.init());
