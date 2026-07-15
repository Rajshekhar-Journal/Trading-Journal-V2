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

  // ── Market Health Modal ────────────────────────────────────────────────────
  async function showMarketHealthModal() {
    const mh = await db.getMarketHealth();
    const content = `
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">Market Trend</label>
          <select class="form-select" id="mh-trend">
            <option value="Uptrend" ${mh.trend==='Uptrend'?'selected':''}>🟢 Uptrend (EMA20 > EMA50)</option>
            <option value="Downtrend" ${mh.trend==='Downtrend'?'selected':''}>🔴 Downtrend (EMA20 ≤ EMA50)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Breadth Matrix Value</label>
          <input class="form-input" type="number" id="mh-breadth" step="0.01" min="0" value="${mh.breadthValue || 1.82}" placeholder="e.g. 1.82">
          <span class="form-hint">Stocks above EMA20 ÷ Stocks below EMA20</span>
        </div>
        <div class="form-group form-full">
          <label class="form-label">Classification (auto from breadth value)</label>
          <div id="mh-classification-display" class="classification-badge">${mh.breadthClassification || 'Strong'} — ${mh.guidance || 'Breakouts Favoured'}</div>
        </div>
        <div class="form-group form-full">
          <span class="form-hint">Last updated: ${mh.lastUpdated || 'Not set'} &nbsp;|&nbsp; Source: Manual entry — NSE live data via API in Phase 3</span>
        </div>
      </div>`;
    openModal('Update Market Health', content, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: closeModal },
      { id: 'save', label: 'Save', class: 'btn-primary', onClick: async () => {
        const trend = document.getElementById('mh-trend').value;
        const breadthValue = parseFloat(document.getElementById('mh-breadth').value) || 0;
        let breadthClassification, guidance;
        if (breadthValue < 0.5) { breadthClassification = 'Extreme Weakness'; guidance = 'Look For Reversal'; }
        else if (breadthValue < 1.0) { breadthClassification = 'Weak'; guidance = 'Capital Preservation'; }
        else if (breadthValue < 1.5) { breadthClassification = 'Selective'; guidance = 'Selective Entries'; }
        else { breadthClassification = 'Strong'; guidance = 'Breakouts Favoured'; }
        await db.saveMarketHealth({ trend, breadthValue, breadthClassification, guidance });
        closeModal();
        toast('Market Health updated', 'success');
        if (_currentModule === 'dashboard') dashboardModule.init();
      }}
    ]);
    document.getElementById('mh-breadth')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value) || 0;
      let cls, guid;
      if (v < 0.5) { cls = '🔵 Extreme Weakness'; guid = 'Look For Reversal'; }
      else if (v < 1.0) { cls = '🔴 Weak'; guid = 'Capital Preservation'; }
      else if (v < 1.5) { cls = '🟡 Selective'; guid = 'Selective Entries'; }
      else { cls = '🟢 Strong'; guid = 'Breakouts Favoured'; }
      const d = document.getElementById('mh-classification-display');
      if (d) d.textContent = `${cls} — ${guid}`;
    });
  }

  function getCurrentModule() { return _currentModule; }
  function refreshCurrentModule() { navigate(_currentModule); }

  return { init, navigate, toast, openModal, closeModal, showMarketHealthModal, getCurrentModule, refreshCurrentModule };
})();

document.addEventListener('DOMContentLoaded', () => app.init());
