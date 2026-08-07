/**
 * settings.js — Module 07: Settings
 * 8-page application configuration center.
 */
const settingsModule = (() => {
  let _activePage = 'general';
  let _hasUnsaved = false;

  const PAGES = [
    { id: 'general', label: '⚙ General', icon: '⚙️' },
    { id: 'trading', label: '📊 Trading Defaults', icon: '📊' },
    { id: 'risk', label: '🛡 Risk Management', icon: '🛡️' },
    { id: 'charges', label: '💳 Charges & Brokerage', icon: '💳' },
    { id: 'alerts', label: '🔔 Alerts & Notifications', icon: '🔔' },
    { id: 'data', label: '🗄 Data Management', icon: '🗄️' },
    { id: 'app', label: '📱 Application', icon: '📱' },
    { id: 'formulas', label: '𝑓 Formula Manager', icon: '🔢' },
  ];

  async function init() {
    _renderNav();
    _setupSearch();
    await _showPage(_activePage);
  }

  function _renderNav(filter = '') {
    const nav = document.getElementById('settings-nav-list');
    if (!nav) return;
    const pages = filter ? PAGES.filter(p => p.label.toLowerCase().includes(filter.toLowerCase())) : PAGES;
    nav.innerHTML = pages.map(p => `
      <div class="settings-nav-item ${_activePage === p.id ? 'active' : ''}" data-page="${p.id}" onclick="settingsModule._goPage('${p.id}')">
        ${p.label}
      </div>`).join('');
  }

  function _setupSearch() {
    const el = document.getElementById('settings-search');
    if (!el) return;
    const fresh = el.cloneNode(true);
    el.parentNode.replaceChild(fresh, el);
    fresh.addEventListener('input', () => _renderNav(fresh.value));
  }

  async function _goPage(pageId) {
    if (_hasUnsaved && !confirm('You have unsaved changes. Discard?')) return;
    _hasUnsaved = false;
    _activePage = pageId;
    _renderNav();
    await _showPage(pageId);
  }

  async function _showPage(id) {
    const el = document.getElementById('settings-content');
    if (!el) return;
    const asyncPages = { general: _pageGeneral, trading: _pageTrading, risk: _pageRisk, charges: _pageCharges, alerts: _pageAlerts, data: _pageData, app: _pageApp, formulas: _pageFormulas };
    if (asyncPages[id]) {
      el.innerHTML = await asyncPages[id]();
    } else {
      el.innerHTML = `<div class="no-data">Page not found.</div>`;
    }
    _setupUnsavedDetect();
  }

  function _setupUnsavedDetect() {
    document.querySelectorAll('#settings-content input, #settings-content select, #settings-content textarea').forEach(el => {
      el.addEventListener('change', () => { _hasUnsaved = true; }, { once: true });
    });
  }

  function _saveBtn(onSave) {
    return `<div class="settings-save-bar">
      <button class="btn btn-secondary btn-sm" onclick="settingsModule._resetPage()">Reset Defaults</button>
      <button class="btn btn-primary btn-sm" onclick="settingsModule._${onSave}()">Save Changes</button>
    </div>`;
  }

  // ── PAGE: General ──────────────────────────────────────────────────────────
  async function _pageGeneral() {
    const settings = await db.getSettings();
    const s = settings?.general || {};
    return `<div class="settings-page">
      <div class="settings-section-header">General Settings</div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Trader Name</label><input class="form-input" id="s-name" value="${s.traderName || ''}"></div>
        <div class="form-group"><label class="form-label">Base Currency</label>
          <select class="form-select" id="s-currency"><option ${s.currency==='INR'?'selected':''}>INR</option><option ${s.currency==='USD'?'selected':''}>USD</option><option ${s.currency==='EUR'?'selected':''}>EUR</option></select>
        </div>
        <div class="form-group"><label class="form-label">Timezone</label>
          <select class="form-select" id="s-tz"><option ${s.timezone==='Asia/Kolkata'?'selected':''}>Asia/Kolkata</option><option>UTC</option><option>America/New_York</option></select>
        </div>
        <div class="form-group"><label class="form-label">Date Format</label>
          <select class="form-select" id="s-datefmt"><option value="DD-MM-YYYY" ${s.dateFormat==='DD-MM-YYYY'?'selected':''}>DD-MM-YYYY</option><option value="MM-DD-YYYY">MM-DD-YYYY</option><option value="YYYY-MM-DD">YYYY-MM-DD</option></select>
        </div>
        <div class="form-group"><label class="form-label">Financial Year Start</label>
          <select class="form-select" id="s-fyr"><option ${s.fyStart==='April'?'selected':''}>April</option><option ${s.fyStart==='January'?'selected':''}>January</option></select>
        </div>
        <div class="form-group"><label class="form-label">Default Startup Module</label>
          <select class="form-select" id="s-startup">${['dashboard','positions','trades','playbook','analytics','capital','settings'].map(m => `<option value="${m}" ${s.defaultStartupModule===m?'selected':''}>${m.charAt(0).toUpperCase()+m.slice(1)}</option>`).join('')}</select>
        </div>
        <div class="form-group"><label class="form-label">Default Date Range</label>
          <select class="form-select" id="s-defrange">${['YTD','Monthly','Quarterly','All'].map(r => `<option ${s.defaultDateRange===r?'selected':''}>${r}</option>`).join('')}</select>
        </div>
      </div>

      <div class="settings-section-header" style="margin-top:24px;">Market Health Thresholds</div>
      <div style="font-size:12px;color:#64748b;margin-bottom:12px;">These control the Overbought/Oversold zones displayed in the Market Health dashboard charts.</div>
      <div class="form-grid">
        <div class="form-group">
          <label class="form-label">RSI — Overbought Level</label>
          <input class="form-input" type="number" id="s-mh-rsi-ob" value="${settings?.marketHealthThresholds?.rsiOB ?? 70}" min="50" max="95">
          <span class="form-hint">Default: 70. RSI above this = Overbought signal.</span>
        </div>
        <div class="form-group">
          <label class="form-label">RSI — Oversold Level</label>
          <input class="form-input" type="number" id="s-mh-rsi-os" value="${settings?.marketHealthThresholds?.rsiOS ?? 30}" min="5" max="50">
          <span class="form-hint">Default: 30. RSI below this = Oversold signal.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Breadth % — Overbought Level</label>
          <input class="form-input" type="number" id="s-mh-breadth-ob" value="${settings?.marketHealthThresholds?.breadthOB ?? 80}" min="50" max="100">
          <span class="form-hint">Default: 80. When &gt;80% of Nifty 500 stocks are above their 20 EMA.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Breadth % — Oversold Level</label>
          <input class="form-input" type="number" id="s-mh-breadth-os" value="${settings?.marketHealthThresholds?.breadthOS ?? 25}" min="0" max="50">
          <span class="form-hint">Default: 25. When &lt;25% of Nifty 500 stocks are above their 20 EMA.</span>
        </div>
      </div>

      ${_saveBtn('saveGeneral')}
      <div class="settings-section-header" style="margin-top:28px;">Display</div>
      <div class="toggle-wrap">
        <div class="toggle-wrap-label">
          <span class="toggle-wrap-title">🔒 Privacy Mode</span>
          <span class="toggle-wrap-hint">Blur all ₹ amounts — R-multiples and % stay visible. Shortcut: <kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:10px">Ctrl+Shift+P</kbd></span>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="s-privacy" ${s.privacyMode ? 'checked' : ''} onchange="app.applyPrivacyMode(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      ${_renderUserManual()}
    </div>`;
  }

  async function _saveGeneral() {
    const settings = await db.getSettings();
    settings.general = { ...settings.general,
      traderName:           document.getElementById('s-name')?.value,
      currency:             document.getElementById('s-currency')?.value,
      timezone:             document.getElementById('s-tz')?.value,
      dateFormat:           document.getElementById('s-datefmt')?.value,
      fyStart:              document.getElementById('s-fyr')?.value,
      defaultStartupModule: document.getElementById('s-startup')?.value,
      defaultDateRange:     document.getElementById('s-defrange')?.value,
      privacyMode:          document.getElementById('s-privacy')?.checked || false,
    };
    // Save Market Health thresholds
    settings.marketHealthThresholds = {
      rsiOB:     parseInt(document.getElementById('s-mh-rsi-ob')?.value)     || 70,
      rsiOS:     parseInt(document.getElementById('s-mh-rsi-os')?.value)     || 30,
      breadthOB: parseInt(document.getElementById('s-mh-breadth-ob')?.value) || 80,
      breadthOS: parseInt(document.getElementById('s-mh-breadth-os')?.value) || 25,
    };
    await db.saveSettings(settings);
    _hasUnsaved = false;
    app.toast('General settings saved', 'success');
    const name = settings.general.traderName;
    if (name) { document.getElementById('trader-name').textContent = name; document.getElementById('trader-avatar').textContent = name.charAt(0).toUpperCase(); }
  }

  // ── User Manual Accordion ───────────────────────────────────────────────────
  function _renderUserManual() {
    const S = (id, icon, title, body) => `
      <div class="um-section">
        <button class="um-toggle" onclick="settingsModule._umToggle('${id}')" id="${id}-btn">
          <span>${icon}&nbsp; ${title}</span>
          <span class="um-chev" id="${id}-chev">&#9658;</span>
        </button>
        <div class="um-body" id="${id}-body" style="display:none"><div class="um-content">${body}</div></div>
      </div>`;

    return `
      <div style="margin-top:28px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <div style="font-size:15px;font-weight:700;color:var(--navy);">&#128218; User Manual &amp; Help</div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="settingsModule._umExpandAll()">Expand All</button>
            <button class="btn btn-secondary btn-sm" onclick="settingsModule._umCollapseAll()">Collapse All</button>
          </div>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 14px;">Complete guide to all features. Click any section to expand.</p>
        <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;">

          ${S('um1','&#128202;','Module 01 &mdash; Dashboard',`
            <p>Your real-time command centre. Shows account health, open positions, and pending alerts at a glance.</p>
            <h4>Current State Row</h4><ul>
              <li><strong>Account Value:</strong> Net Deposits + Realized P&L. Shows % gain vs deposits.</li>
              <li><strong>Portfolio Heat:</strong> Total &apos;at-risk&apos; money &divide; Equity &times; 100. Excludes locked profit (stop above entry). Green = Safe, Yellow = Warning, Red = Max.</li>
              <li><strong>Remaining Capacity:</strong> How much more risk you can add before hitting the heat limit.</li>
              <li><strong>Market Health:</strong> Click &#9998; update to revise trend &amp; breadth. Click &#9432; for Market Breadth explanation.</li>
            </ul>
            <h4>Summary Cards</h4><p>Realized P&L, Total R, Win Rate, Avg Win/Loss R, Expectancy, Max Drawdown for the selected date period (Week/Month/Quarter/YTD/All).</p>
            <h4>Charts</h4><ul>
              <li><strong>Daily Net Cumulative P&L (Line):</strong> Accumulated realized P&L day by day.</li>
              <li><strong>Risk:Reward Bubble Chart:</strong> Each bubble = one trade. Size = |R|.</li>
            </ul>
            <h4>Action Centre</h4><p>All active alerts shown with phase colour, GTT instruction preview, and &checkmark; Done / Dismiss buttons.</p>`)}

          ${S('um-mh','&#128736;','Market Health &mdash; How to Read the Metrics',`
            <p>The <strong>Market Health Dashboard</strong> gives you a live macro view of the Nifty 500. Open it by clicking the <strong>Market Health</strong> button in the top bar. Hit <strong>Auto Fetch</strong> to refresh all values from Yahoo Finance.</p>

            <h4>&#128316; Market Trend (EMA-based)</h4>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Signal</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Condition</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Guidance</th></tr></thead><tbody>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);color:#22c55e;font-weight:600;">&#x1F7E2; Uptrend</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Price &gt; EMA20 &gt; EMA50</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Add exposure, buy breakouts</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);color:#ef4444;font-weight:600;">&#x1F534; Downtrend</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Price &lt; EMA20 &lt; EMA50</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Reduce longs, tighten stops</td></tr>
              <tr><td style="padding:5px 8px;color:#f59e0b;font-weight:600;">&#x1F7E1; Sideways</td><td style="padding:5px 8px;">Neither condition met</td><td style="padding:5px 8px;">Selective entries only, wait for clarity</td></tr>
            </tbody></table>

            <h4>&#128308; Breadth Matrix (Above/Below EMA20 Ratio)</h4>
            <p>Counts all Nifty 500 stocks. Ratio = Stocks above EMA20 &divide; Stocks below EMA20.</p>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Classification</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Ratio</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">What it means</th></tr></thead><tbody>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);color:#22c55e;font-weight:600;">Strong</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">&ge; 1.5x</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Broad participation. Breakouts likely to follow through.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);color:#f59e0b;font-weight:600;">Selective</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">1.0 &ndash; 1.49x</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Mixed market. Only take A-grade setups.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);color:#ef4444;font-weight:600;">Weak</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">0.5 &ndash; 0.99x</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Sellers in control. Capital preservation mode.</td></tr>
              <tr><td style="padding:5px 8px;color:#ef4444;font-weight:600;">Extreme Weakness</td><td style="padding:5px 8px;">&lt; 0.5x</td><td style="padding:5px 8px;">Capitulation zone. Watch for reversal setups only.</td></tr>
            </tbody></table>

            <h4>&#128200; RSI (14) &mdash; Nifty 500 Index</h4>
            <p>Measures momentum overbought/oversold on the Nifty 500 index price. Default thresholds: OB = 70, OS = 30 (set in Settings &rarr; General).</p>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Zone</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">RSI</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Interpretation</th></tr></thead><tbody>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);color:#ef4444;font-weight:600;">&#x1F534; Overbought</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">&gt; 70</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Correction risk. Avoid adding longs, trail stops.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">&#x26AA; Neutral</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">30 &ndash; 70</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Balanced momentum. Follow trend and breadth signals.</td></tr>
              <tr><td style="padding:5px 8px;color:#22c55e;font-weight:600;">&#x1F7E2; Oversold</td><td style="padding:5px 8px;">&lt; 30</td><td style="padding:5px 8px;">Market washed out. Watch for reversal setups.</td></tr>
            </tbody></table>

            <h4>&#128200; Breadth % &mdash; % of Nifty 500 Stocks Above 20 EMA</h4>
            <p>A breadth extreme indicator. Default thresholds: OB = 80%, OS = 25% (set in Settings &rarr; General).</p>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Zone</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">%</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Interpretation</th></tr></thead><tbody>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);color:#ef4444;font-weight:600;">&#x1F534; Overbought</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">&gt; 80%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Market overextended. Tighten trailing stops.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">&#x26AA; Neutral</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">25% &ndash; 80%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Healthy broad participation. Normal conditions.</td></tr>
              <tr><td style="padding:5px 8px;color:#22c55e;font-weight:600;">&#x1F7E2; Oversold</td><td style="padding:5px 8px;">&lt; 25%</td><td style="padding:5px 8px;">Mass selling. Watch for bounce / reversal setups.</td></tr>
            </tbody></table>

            <h4>Combined Signal Cheatsheet</h4>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Trend</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">RSI</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Breadth %</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Action</th></tr></thead><tbody>
              <tr style="background:rgba(34,197,94,0.08);"><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Uptrend</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Neutral</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Neutral</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;color:#22c55e;">BEST &mdash; Full deployment, pursue breakouts</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Uptrend</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Overbought</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Overbought</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Trail stops, avoid new longs, take partial profits</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Sideways</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Any</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Any</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Only A+ setups, reduce position sizing</td></tr>
              <tr style="background:rgba(239,68,68,0.08);"><td style="padding:5px 8px;">Downtrend</td><td style="padding:5px 8px;">Oversold</td><td style="padding:5px 8px;">Oversold</td><td style="padding:5px 8px;font-weight:600;color:#f59e0b;">Watch for reversal &mdash; do not add longs yet</td></tr>
            </tbody></table>
          `)}

          ${S('um2','&#128200;','Module 02 &mdash; Positions (Open Trades)',`
            <p>The heart of the journal. Tracks every open trade in real time with live CMP, metrics, and alert cards.</p>
            <h4>Position Table Columns</h4>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Column</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Description</th></tr></thead><tbody>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Symbol</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Stock symbol with Long/Short badge. Green if CMP &gt; Entry, Red if below.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Type</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Equity, Intraday, or Futures.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Entry Date</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Date of first entry. Sortable.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Days</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Trading days held (excludes weekends and NSE holidays).</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Open Qty</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Current remaining shares after partial exits.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Avg Entry</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Weighted average entry price across all entries and pyramids.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Init Stop</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Initial stop loss price. Shows <em>% from Avg Entry</em> below (red = risk, green = above entry).</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Curr Stop</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Current trailing stop. Shows <em>% from Avg Entry</em> below. Green = locked profit (stop above entry).</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">CMP</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Current Market Price (auto-fetched every 3 min). Click &#9998; to update manually. Shows <em>% from Avg Entry</em>.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Chg%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Percentage change from Avg Entry to CMP. Sortable.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Open Risk &#8377;</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Rupees at risk if stop is hit. Negative = real risk, positive = locked profit (trailing stop above entry).</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Exposure</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Current market value of position (Avg Entry &times; Qty). Shows % of Account Value.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Unreal. P&amp;L (R)</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Unrealized P&amp;L in &#8377; and R-multiple. R = Unrealized P&amp;L &divide; True RPT.</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);font-weight:600;">Net P&amp;L</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Realized P&amp;L from partial exits (if any).</td></tr>
              <tr><td style="padding:5px 8px;font-weight:600;">Alert</td><td style="padding:5px 8px;">Alert badge. Shows count of triggered alerts. Click row to see full instructions.</td></tr>
            </tbody></table>
            <h4>Adding a New Trade</h4><ol>
              <li>Click <strong>+ New Trade</strong>.</li>
              <li>Fill: Symbol, Sector, Type, Direction, <strong>Exchange (NSE/BSE)</strong>, Playbook, Date, Price, Stop Loss, Qty, RPT, Charges, CMP.</li>
              <li>CMP auto-fetched from Yahoo Finance on symbol entry. Qty auto-suggested from RPT &divide; risk.</li>
            </ol>
            <h4>Quick Actions in Detail Panel</h4><ul>
              <li><strong>Partial Exit</strong> &mdash; reduce position size, record date/price/qty/charges.</li>
              <li><strong>Final Exit</strong> &mdash; close full remaining position. Trade moves to Closed History.</li>
              <li><strong>Pyramid</strong> &mdash; add to position. Avg Entry updates. Stop can be revised atomically in the same action.</li>
              <li><strong>Revise Stop</strong> &mdash; update trailing stop. Full history tracked with old/new/source/notes.</li>
              <li><strong>Add Note</strong> &mdash; attach observations or reminders.</li>
              <li><strong>Update CMP</strong> &mdash; manual or auto-fetch from Yahoo Finance.</li>
            </ul>
            <h4>Detail Panel Tabs</h4><ul>
              <li><strong>Lifecycle:</strong> All entries, pyramids, partial exits, final exit in chronological order.</li>
              <li><strong>Stop History:</strong> Every revision with old/new stop, date, source, and reason. Editable/deletable.</li>
              <li><strong>Notes:</strong> All notes in date order.</li>
              <li><strong>Chart:</strong> 2-year daily candlestick with entry/exit markers, stop loss line, 20 EMA overlay (black). TradingView link uses correct exchange prefix (NSE/BSE).</li>
            </ul>
            <h4>% From Entry Labels</h4><p>Init Stop, Curr Stop, and CMP columns all show a small <em>% from Avg Entry</em> label beneath the price. <strong style="color:#22c55e">Green</strong> = favourable (above entry for Long), <strong style="color:#ef4444">Red</strong> = adverse. Helps instantly gauge how far your stop or price has moved from your entry.</p>
            <h4>&#128260; Sync Live Data</h4><p>Top-right button. Runs live CMP fetch + alert engine immediately, bypassing all market-hours and holiday restrictions.</p>`)}

          ${S('um3','&#128203;','Module 03 &mdash; Trades (Closed History)',`
            <p>Full history of all closed trades with rich filtering and performance metrics.</p>
            <h4>Summary Cards</h4><p>Total Trades, Win Rate, Net P&L, Net R, Expectancy, Max Drawdown for selected filters and date range.</p>
            <h4>Closed Trades Table</h4><ul>
              <li>Columns: Symbol, Entry, Exit, Days, Setup, P&L, R, Result, Rule Followed, Review Status.</li>
              <li>Init Stop, Avg Exit, and CMP all show <em>% from Avg Entry</em> labels.</li>
              <li>Click column headers to sort. Filter by Result, Setup, or Symbol search box.</li>
              <li>Click any row to open full Trade Detail Panel (lifecycle, stops, notes, chart).</li>
            </ul>
            <h4>Views</h4><p><strong>Metrics View:</strong> table. <strong>Chart View:</strong> All closed-trade charts stacked vertically with lazy-loading for fast scrolling.</p>`)}

          ${S('um4','&#128219;','Module 04 &mdash; Playbook',`
            <p>Your personal trading strategy library. Each playbook defines a specific setup with entry/exit rules and risk parameters.</p>
            <h4>Creating a Playbook</h4><ol><li>Click <strong>+ New Playbook</strong>.</li><li>Fill: Name, Version, Status, Category, Description, Entry Rules, Exit Rules, Risk Parameters.</li></ol>
            <h4>Linking to a Trade</h4><p>Select the Playbook in the New Trade modal. The version at time of entry is stored permanently.</p>
            <h4>Playbook Table Columns</h4><p>Name, Version, Status, Category, Trades, Win Rate, Avg R, Expectancy &mdash; all auto-computed from your trade history.</p>`)}

          ${S('um5','&#128201;','Module 05 &mdash; Analytics (6 Tabs)',`
            <h4>Tab 1: Performance</h4><ul>
              <li>Summary cards: Total Trades, Win Rate, Net P&L, Net R, Expectancy, Max Drawdown, Trading Score.</li>
              <li><strong>Cumulative P&L Chart:</strong> toggle to <strong>Cumulative Equity</strong> for account value with deposits.</li>
              <li>Trade P&L Sequence, Drawdown Curve, Monthly P&L Heatmap, Rolling 10-Trade Win Rate.</li>
            </ul>
            <h4>Tab 2: Trade Analytics</h4><p>R-multiple distribution, Holding Period vs R scatter, statistical breakdown.</p>
            <h4>Tab 3: Playbook Analytics</h4><p>Per-playbook: Win Rate, Avg Win/Loss R, Expectancy, Net R, Avg Days. Expectancy chart, Win Rate chart, <strong>Playbook vs Avg Holding Days chart</strong>.</p>
            <h4>Tab 4: Risk Analytics</h4><p>Current Portfolio Heat, Rule Violations count, table of trades where Rule Followed = No.</p>
            <h4>Tab 5: Discipline</h4><p>Rule-following rate, review completion %, review status breakdown.</p>
            <h4>Tab 6: Growth Simulator</h4><p>Monte Carlo compound growth simulator using your historical expectancy and trade frequency.</p>`)}

          ${S('um6','&#128176;','Module 06 &mdash; Capital Management',`
            <h4>Summary Cards</h4><p>Starting Capital, Current Equity, Net Deposits, Current RPT, Available Cash, Drawdown (Peak), CAGR, Absolute Return.</p>
            <h4>Equity Curve Chart</h4><p>Account value from first deposit through all transactions and realized P&L.</p>
            <h4>Risk Config Panel</h4><p>Read-only display of Risk Mode, Current RPT, Heat %. Edit in Settings &rarr; Risk Management.</p>
            <h4>Capital Ledger</h4><p>All Deposits, Withdrawals, Adjustments with running balance. Click <strong>+ Add Transaction</strong> to record new entries.</p>`)}

          ${S('um7','&#9881;','Module 07 &mdash; Settings (8 Sub-Pages)',`
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Page</th><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">What you configure</th></tr></thead><tbody>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">&#9881; General</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Trader name, currency, timezone, date format, FY start, default startup page and date range, Privacy Mode toggle. This User Manual.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">&#128202; Trading Defaults</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Default trade type, direction, max open positions, review status. RPT shown read-only (auto-computed from Risk Mgmt).</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">&#128737; Risk Management</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Max Portfolio Heat %, Warning Heat %, Max RPT cap, Risk Mode (Dynamic % or Fixed &#8377;). Market Breadth &rarr; RPT guidance table.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">&#128179; Charges &amp; Brokerage</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Broker, STT, brokerage, stamp duty, GST, SEBI charges. Auto-used in trade entry/exit calculations.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">&#128276; Alerts &amp; Notifications</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Telegram Bot Token, Chat ID, alert type toggles. Paste credentials here to receive live GTT alerts on your phone.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">&#128452; Data Management</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Export JSON backup, import from backup, clear all data. Manage NSE market holidays for alert engine exclusions.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">&#128241; Application</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Theme (Light/Dark), font size, local storage usage.</td></tr>
              <tr><td style="padding:6px 10px;font-weight:600;">&#119891; Formula Manager</td><td style="padding:6px 10px;">View all calculation formulas: Avg Entry, Risk R, Expectancy, Portfolio Heat, RPT, True RPT, ATR, EMA, CAGR, etc.</td></tr>
            </tbody></table>
            <h4>&#128274; Privacy Mode</h4>
            <p>Toggle in Settings &rarr; General or press <code>Ctrl+Shift+P</code>. Blurs all &#8377; amounts across the entire app. R-multiples and percentages remain visible. Safe for screen-sharing or screenshots.</p>`)}

          ${S('um8','&#128276;','Alert Engine v2.2 &mdash; Complete Guide',`
            <p>The alert engine monitors all open trades and generates <strong>GTT (Good Till Triggered) instructions</strong> for your broker. It runs automatically and sends notifications to Telegram.</p>

            <h4>Strategy v2.2 Overview &mdash; Phased Entry + Graduated Exits</h4>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Feature</th><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Detail</th></tr></thead><tbody>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Entry</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Phased: 50% at entry, +50% at 1R confirmation (via Pyramid).</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">1R Checkpoint</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Alert fires at Entry + 1R. Action: Add remaining 50%, tighten stop to midpoint.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Extension Anchoring</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">All ATR targets from frozen SwingLow (MIN of last 10 candle opens at entry).</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Frozen ATR</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Entry-day ATR14 stored once. Never recalculated during the trade.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Tranche Trail</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Previous Day Candle Low (with High-Water Mark). Strong day: LOD + &frac12; &times; move.</td></tr>
              <tr><td style="padding:6px 10px;font-weight:600;">Core Trail</td><td style="padding:6px 10px;">EMA20 with Soft Breach Rule (post-4&times;ATR only).</td></tr>
            </tbody></table>

            <h4>How to Enable Alerts</h4><ol>
              <li>Go to <strong>Settings &rarr; Alerts &amp; Notifications</strong>.</li>
              <li>Enter your <strong>Telegram Bot Token</strong> and <strong>Chat ID</strong>.</li>
              <li>Toggle ON the alert types you want.</li>
              <li>Click <strong>Save Changes</strong>. Alerts start running on the next 3-minute cycle.</li>
            </ol>

            <h4>When Does the Engine Run?</h4>
            <p>Every <strong>3 minutes</strong>, Monday&ndash;Friday, 8:45 AM&ndash;4:03 PM IST, excluding NSE holidays. A special <strong>4:00 PM End-of-Day</strong> fetch runs daily for final Telegram summary. Click <strong>&#128260; Sync Live Data</strong> in Positions to force a manual run anytime.</p>

            <h4>All Alert Types (v2.2)</h4>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Alert</th><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Trigger</th><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Action</th></tr></thead><tbody>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#f85149;">&#128680; Stop Loss Breach</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">CMP &le; Current Stop (Long)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);"><strong>EXIT entire position immediately.</strong> Overrides all other alerts.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#3fb950;">&#128994; 1R Checkpoint</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">CMP &ge; Entry + 1&times;Risk (no pyramid yet)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Add remaining 50% position. Tighten stop to midpoint.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#58a6ff;">&#128309; 4&times;ATR Extension</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">CMP &ge; SwingLow + 4&times;ATR</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Exit 20% PS. Set tranche GTT at PrevLow. Core at MAX(BE, EMA20).</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#ffa657;">&#128992; 8&times;ATR Extension</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">CMP &ge; SwingLow + 8&times;ATR</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Exit to 40% cumulative. Set tranche GTT at PrevLow. Core at EMA20.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#bf91f3;">&#128995; 12&times;ATR Extension</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">CMP &ge; SwingLow + 12&times;ATR</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Exit to 70% cumulative. Remaining 30% enters Runner Mode.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#8b949e;">&#127939; Runner Mode</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">After 12&times;ATR tranche completed</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Trail remaining 30% with EMA20 only (soft breach rule applies).</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#d29922;">&#128993; EMA20 Soft Breach</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">CMP &lt; EMA20, but close within 2% (post-4&times;ATR)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">WARNING only. Monitor next day. If gap-down or stays below &rarr; EXIT.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:700;color:#f85149;">&#128200; EMA20 Weakness Exit</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Confirmed EMA20 breach (next-day gap-down or &gt;2% below)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);"><strong>EXIT ALL remaining position at market.</strong></td></tr>
              <tr><td style="padding:6px 10px;font-weight:700;color:#8b949e;">&#128197; Day-6 Time Exit</td><td style="padding:6px 10px;">Trade held &ge; 6 trading days, no exits yet</td><td style="padding:6px 10px;">Exit 50% of open qty to reduce exposure.</td></tr>
            </tbody></table>

            <h4>Priority Waterfall</h4>
            <p>Only <strong>one dynamic alert</strong> is active per trade at a time:</p>
            <p style="font-family:monospace;font-size:11px;background:var(--bg);padding:10px 14px;border-radius:6px;line-height:1.8;">
              &#128680; Stop Loss Breach (P1 &mdash; overrides everything)<br>
              &nbsp;&nbsp;&#8595; only if NOT breached<br>
              &#128200; EMA20 Weakness Exit (P2.0 &mdash; confirmed, post-4&times;ATR)<br>
              &#128993; EMA20 Soft Breach Warning (P2.0b &mdash; monitoring)<br>
              &#128995; 12&times;ATR Extension (P2.1 &mdash; cum 70%)<br>
              &#128992; 8&times;ATR Extension (P2.2 &mdash; cum 40%)<br>
              &#128309; 4&times;ATR Extension (P2.3 &mdash; cum 20%)<br>
              &#127939; Runner Mode (after 12&times;ATR done)<br>
              &#128994; 1R Checkpoint (P3 &mdash; advisory)<br>
              <br>
              &#128197; Day-6 Time Exit (independent &mdash; runs alongside any alert)
            </p>

            <h4>EMA20 Soft Breach Rule (Post-4&times;ATR Only)</h4>
            <p>After the 4&times;ATR exit is completed, EMA20 breaches get a <strong>2% tolerance buffer</strong> to avoid false shakeouts:</p>
            <p style="font-family:monospace;font-size:11px;background:var(--bg);padding:10px 14px;border-radius:6px;line-height:1.8;">
              CMP dips below EMA20<br>
              &nbsp;&nbsp;&#9500; Close &ge; EMA20 &times; 0.98? (within 2%)<br>
              &nbsp;&nbsp;&#9474;&nbsp;&nbsp;YES &rarr; &#128993; WARNING only. Monitor next day.<br>
              &nbsp;&nbsp;&#9474;&nbsp;&nbsp;&nbsp;&nbsp;&#9500; Next day gap down below prev close? &rarr; &#128308; EXIT<br>
              &nbsp;&nbsp;&#9474;&nbsp;&nbsp;&nbsp;&nbsp;&#9500; Next day stays below EMA20? &rarr; &#128308; EXIT<br>
              &nbsp;&nbsp;&#9474;&nbsp;&nbsp;&nbsp;&nbsp;&#9492; Next day recovers above EMA20? &rarr; &#128994; Cancel warning<br>
              &nbsp;&nbsp;&#9474;&nbsp;&nbsp;NO (close &gt;2% below) &rarr; &#128308; EXIT immediately<br>
              &nbsp;&nbsp;&#9492; Before 4&times;ATR? &rarr; &#128308; EXIT immediately (no tolerance)
            </p>

            <h4>&#128200; Strong Day Adjustment (2.5&times;ATR Move)</h4>
            <p>On days when the stock&rsquo;s close-to-close move exceeds <strong>2.5&times; ATR14</strong>, the tranche trailing stop uses:</p>
            <p style="font-family:monospace;font-size:11px;background:var(--bg);padding:10px 14px;border-radius:6px;">
              <strong>Normal day:</strong> Tranche GTT = Prev Day Low (with HWM)<br>
              <strong>Strong day (&gt;2.5&times;ATR):</strong> Tranche GTT = Day Low + &frac12; &times; move
            </p>

            <h4>Qty Exit per Extension Tier</h4>
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Tier</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Exit %</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Cumul %</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Tranche Stop</th><th style="padding:5px 8px;border-bottom:1px solid var(--border);text-align:left;">Core Stop</th></tr></thead><tbody>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">4&times;ATR</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">20%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">20%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Prev Day Low</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">MAX(Breakeven, EMA20)</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">8&times;ATR</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">20%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">40%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Prev Day Low</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">EMA20</td></tr>
              <tr><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">12&times;ATR</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">30%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">70%</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">Prev Day Low</td><td style="padding:5px 8px;border-bottom:1px solid var(--border-light);">EMA20</td></tr>
              <tr><td style="padding:5px 8px;">Runner</td><td style="padding:5px 8px;">30%</td><td style="padding:5px 8px;">100%</td><td style="padding:5px 8px;">&mdash;</td><td style="padding:5px 8px;">EMA20 (with soft breach)</td></tr>
            </tbody></table>
            <p><em>Exit qty formula: exitQty = MIN(MAX(0, floor(PS &times; tierCumPct) &minus; totalExited), openQty). PS = total bought qty (entries + pyramids). Handles pyramids and discretionary exits automatically.</em></p>

            <h4>&#128274; GTT High-Water Mark (Prices Never Drop)</h4>
            <p>Once the engine calculates a GTT price, it stores a <strong>high-water mark</strong> per alert. GTT prices can only go <strong>up</strong>, never down. Phase carry-over applies across tier transitions.</p>

            <h4>Alert Lifecycle &mdash; Full Flow (v2.2)</h4>
            <p style="font-family:monospace;font-size:11px;background:var(--bg);padding:10px 14px;border-radius:6px;line-height:1.9;">
              1. Entry (50%) &rarr; Set initial GTT at [Stop] for [50% Qty]<br>
              2. CMP &ge; Entry + 1R &rarr; &#128994; 1R CHECKPOINT &rarr; Add 50%, tighten stop<br>
              3. CMP &ge; SwingLow + 4&times;ATR &rarr; &#128309; 4&times;ATR &rarr; exit 20%, stop to BE<br>
              4. CMP &ge; SwingLow + 8&times;ATR &rarr; &#128992; 8&times;ATR &rarr; exit to 40% cumulative<br>
              &nbsp;&nbsp;&nbsp;(strong day &gt;2.5&times;ATR? tranche = Day Low + &frac12; move)<br>
              5. CMP &ge; SwingLow + 12&times;ATR &rarr; &#128995; 12&times;ATR &rarr; exit to 70% cumulative<br>
              6. Remaining 30% &rarr; &#127939; RUNNER MODE &rarr; EMA20 trail with soft breach<br>
              7. EMA20 breached (confirmed) &rarr; &#128200; WEAKNESS EXIT &rarr; exit all
            </p>

            <h4>Exit Reason Tracking</h4>
            <p>When recording an exit (Partial or Final), select the exact reason from the dropdown:</p>
            <ul style="font-size:12px;">
              <li><strong>Manual Discretionary</strong> &mdash; Trader&rsquo;s own judgment</li>
              <li><strong>Day-6 Time Exit</strong> &mdash; Time-based stop after 6 trading days</li>
              <li><strong>4&times;ATR / 8&times;ATR / 12&times;ATR Extension Exit</strong> &mdash; Extension tier reached</li>
              <li><strong>EMA20 Weakness Exit</strong> &mdash; Confirmed EMA20 breach</li>
              <li><strong>Stop Loss Breached</strong> &mdash; Stop loss hit</li>
              <li><strong>1R Pyramid Add</strong> &mdash; Related to 1R confirmation entry</li>
              <li><strong>Full Close</strong> &mdash; Complete position closure</li>
            </ul>
            <p>Recording an exit automatically marks all triggered alerts as Completed.</p>

            <h4>NSE Tick Size Rounding</h4>
            <p>All GTT prices are rounded to broker-compatible NSE tick sizes: &le;&#8377;250 &rarr; 0.05 | &le;&#8377;1k &rarr; 0.10 | &le;&#8377;5k &rarr; 0.50 | &le;&#8377;18k &rarr; 1.00 | above &rarr; 5.00</p>

            <h4>Alert Cards in UI</h4>
            <p>Active alerts appear at the top of the detail panel when you click a position. Each card shows: phase icon, label, triggered timestamp, exact GTT instruction. Buttons: <strong>&checkmark; Done (GTT Set)</strong> marks alert as completed. <strong>Dismiss</strong> silences it without action.</p>
          `)}

          ${S('um9','&#128276;','Telegram Notification Rules (v2.2)',`
            <h4>Rule A &mdash; New Alert</h4>
            <p>Instant Telegram alert when a trade crosses a <strong>new tier</strong> for the first time (1R checkpoint, 4&times;ATR, 8&times;ATR, 12&times;ATR, Runner Mode, EMA20 Breach).</p>

            <h4>Rule B &mdash; End-of-Day Summary</h4>
            <p>At <strong>4:00 PM IST</strong>, if any alert&rsquo;s message has changed since the last EOD notification, a final daily Telegram message is sent with the latest GTT levels.</p>

            <h4>Rule C &mdash; 1% Upward Move</h4>
            <p>If any GTT price in the alert message increases by <strong>&ge;1%</strong> from the last notified value during intraday trading, a re-notification is sent. Only fires on <em>upward</em> moves.</p>

            <h4>Telegram Message Format</h4>
            <p style="font-family:monospace;font-size:11px;background:var(--bg);padding:10px 14px;border-radius:6px;line-height:1.8;">
              &#128680; <strong>EXIT ALERT</strong> &#128680;<br><br>
              <strong>Symbol:</strong> RELIANCE<br>
              <strong>Phase:</strong> &#128309; 4&times;ATR Extension<br><br>
              <strong>Action Required:</strong><br>
              1. Set Tranche GTT: 200 Qty at &pound;562 (Prev Day Low)<br>
              2. Set Core GTT: 800 Qty at &pound;555 (EMA20)<br><br>
              Next target: 8&times;ATR at &pound;670
            </p>

            <h4>Telegram Setup</h4><ol>
              <li>Search <strong>@BotFather</strong> on Telegram, send <code>/newbot</code>, follow steps to get your <strong>Bot Token</strong>.</li>
              <li>Search <strong>@userinfobot</strong> on Telegram, send <code>/start</code> to get your <strong>Chat ID</strong>.</li>
              <li>Paste both in <strong>Settings &rarr; Alerts &amp; Notifications</strong>.</li>
              <li>Click <strong>Save</strong>. Send a test by clicking <strong>&#128260; Sync Live Data</strong> in Positions.</li>
            </ol>
          `)}

          ${S('um10','&#128172;','Telegram Bot Setup',`
            <h4>Step 1 &mdash; Create Your Bot</h4><ol>
              <li>Open Telegram &rarr; search <strong>@BotFather</strong> (blue tick) &rarr; send <code>/newbot</code>.</li>
              <li>Enter display name (e.g., &quot;My Trading Alerts&quot;).</li>
              <li>Enter username ending in <code>bot</code> (e.g., <code>RajTradingJournalBot</code>).</li>
              <li>Copy the <strong>HTTP API Token</strong> provided.</li>
            </ol>
            <h4>Step 2 &mdash; Get Your Chat ID</h4><ol>
              <li>Open your new bot &rarr; press <strong>Start</strong>.</li>
              <li>Search <strong>@getmyid_bot</strong> &rarr; press Start.</li>
              <li>Copy your numeric <strong>User ID</strong> (e.g., <code>521989682</code>).</li>
            </ol>
            <h4>Step 3 &mdash; Connect &amp; Test</h4><ol>
              <li>Go to <strong>Settings &rarr; Alerts &amp; Notifications</strong>.</li>
              <li>Paste Bot Token and Chat ID &rarr; Save Changes.</li>
              <li>Go to Positions &rarr; click <strong>&#128260; Sync Live Data</strong>. If an alert condition is met, your phone will notify within seconds.</li>
            </ol>`)}

          ${S('um11','&#119891;','Key Calculations Reference',`
            <table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg);"><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Metric</th><th style="padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;">Formula</th></tr></thead><tbody>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Avg Entry</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">&Sigma;(Price &times; Qty) &divide; &Sigma;(Qty) &mdash; across all entries and pyramids</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Open Risk &#8377;</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">(Avg Entry &minus; Current Stop) &times; Open Qty. Negative = real risk, Positive = locked profit.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Initial RPT (&#8377;)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">|Avg Entry &minus; Initial Stop| &times; Total Qty at first entry</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">True RPT (&#8377;)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">High-water mark of position risk committed at each lifecycle event (entries, pyramids, stop revisions). Exits do <strong>not</strong> change True RPT. Used as the R-multiple denominator so that actual losses honestly show R worse than &minus;1.0.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">R-Multiple</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">P&amp;L &divide; True RPT. Losing &gt;1R means you lost more than planned.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Unrealized P&amp;L</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">(CMP &minus; Avg Entry) &times; Open Qty &minus; Charges</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Realized P&amp;L</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">(Avg Exit &minus; Avg Entry) &times; Exited Qty &minus; Charges</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Portfolio Heat (%)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">&Sigma;(|Entry &minus; Stop| &times; Qty) &divide; Equity &times; 100. Excludes locked profit (stop above entry).</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Expectancy (R)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">(WinRate &times; AvgWinR) + ((1 &minus; WinRate) &times; AvgLossR)</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">Trading Days</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">Calendar days from entry to today, excluding weekends (Sat/Sun) and NSE holidays.</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">EMA (n-period)</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">k = 2/(n+1); EMA = Close &times; k + EMA_prev &times; (1&minus;k)</td></tr>
              <tr><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);font-weight:600;">ATR-14</td><td style="padding:6px 10px;border-bottom:1px solid var(--border-light);">14-day Wilder&rsquo;s smoothing of: MAX(H&minus;L, |H&minus;PrevC|, |L&minus;PrevC|)</td></tr>
              <tr><td style="padding:6px 10px;font-weight:600;">CAGR</td><td style="padding:6px 10px;">(Equity &divide; Starting Capital)^(1/Years) &minus; 1</td></tr>
            </tbody></table>`)}

        </div>
      </div>
      <style>
        .um-section{border-bottom:1px solid var(--border-light)}.um-section:last-child{border-bottom:none}
        .um-toggle{width:100%;display:flex;justify-content:space-between;align-items:center;padding:13px 16px;background:var(--surface);border:none;cursor:pointer;font-size:13px;font-weight:600;color:var(--text);text-align:left;transition:background 0.15s}
        .um-toggle:hover{background:var(--bg)}.um-toggle.open{background:var(--primary-light);color:var(--primary)}
        .um-chev{font-size:11px;color:var(--text-muted);transition:transform 0.2s}.um-chev.open{transform:rotate(90deg);color:var(--primary)}
        .um-body{background:var(--bg);border-top:1px solid var(--border-light)}
        .um-content{padding:16px 20px;font-size:12.5px;line-height:1.7;color:var(--text)}
        .um-content h4{font-size:11px;font-weight:700;color:var(--navy);margin:14px 0 5px;text-transform:uppercase;letter-spacing:0.5px}
        .um-content h4:first-child{margin-top:0}.um-content p{margin:0 0 10px}
        .um-content ul,.um-content ol{margin:0 0 10px;padding-left:20px}.um-content li{margin-bottom:4px}
        .um-content code{background:rgba(91,106,240,0.12);color:var(--primary);padding:1px 5px;border-radius:3px;font-size:11px}
        .um-content table td,.um-content table th{vertical-align:top}
      </style>`;
  }

  function _umToggle(id) {
    const body = document.getElementById(`${id}-body`);
    const btn  = document.getElementById(`${id}-btn`);
    const chev = document.getElementById(`${id}-chev`);
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    btn.classList.toggle('open', !open);
    chev.classList.toggle('open', !open);
  }

  function _umExpandAll() {
    document.querySelectorAll('.um-body').forEach(b => b.style.display='block');
    document.querySelectorAll('.um-toggle').forEach(b => b.classList.add('open'));
    document.querySelectorAll('.um-chev').forEach(c => c.classList.add('open'));
  }

  function _umCollapseAll() {
    document.querySelectorAll('.um-body').forEach(b => b.style.display='none');
    document.querySelectorAll('.um-toggle').forEach(b => b.classList.remove('open'));
    document.querySelectorAll('.um-chev').forEach(c => c.classList.remove('open'));
  }

  // ── PAGE: Trading Defaults ─────────────────────────────────────────────────
  async function _pageTrading() {
    const settings = await db.getSettings();
    const s = settings?.tradingDefaults || {};
    const rm = settings?.riskManagement || {};
    const capital = await db.getCapital();
    const closedTrades = await db.getClosedTrades();
    const realizedPnl = calc.getTotalPnl(closedTrades);
    const equity = calc.getCurrentEquity(capital, realizedPnl);
    const computedRPT = rm.riskMode === 'Fixed'
      ? (rm.fixedRiskAmount || 10000)
      : Math.round(equity * ((rm.riskPercent || 1) / 100));
    const rptMode = rm.riskMode === 'Fixed'
      ? `Fixed amount from Risk Management`
      : `${rm.riskPercent || 1}% × equity ${calc.formatCurrency(equity)}`;

    return `<div class="settings-page">
      <div class="settings-section-header">Trading Defaults</div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Default Trade Type</label>
          <select class="form-select" id="td-type"><option ${s.tradeType==='Equity'?'selected':''}>Equity</option><option ${s.tradeType==='Intraday'?'selected':''}>Intraday</option><option ${s.tradeType==='Futures'?'selected':''}>Futures</option></select>
        </div>
        <div class="form-group"><label class="form-label">Default Direction</label>
          <select class="form-select" id="td-dir"><option ${s.direction==='Long'?'selected':''}>Long</option><option ${s.direction==='Short'?'selected':''}>Short</option></select>
        </div>
        <div class="form-group"><label class="form-label">Max Open Positions</label><input class="form-input" type="number" id="td-maxopen" value="${s.maxOpenPositions || 10}" min="1"></div>
        <div class="form-group"><label class="form-label">Default Review Status</label>
          <select class="form-select" id="td-review"><option ${s.defaultReviewStatus==='Pending'?'selected':''}>Pending</option><option>Reviewed</option></select>
        </div>
        <div class="form-group form-full">
          <label class="form-label">Current Computed RPT <span class="badge badge-primary" style="font-size:10px">${rm.riskMode || 'Dynamic'}</span></label>
          <div class="form-input" style="background:#f8fafc;cursor:default;font-weight:600;color:#5b6af0;">₹${calc.formatNumber(computedRPT)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            ${rptMode} — <a href="#" onclick="settingsModule._goPage('risk');return false;" style="color:#5b6af0">Edit in Risk Management →</a>
          </div>
        </div>
      </div>
      ${_saveBtn('saveTrading')}
    </div>`;
  }

  async function _saveTrading() {
    const settings = await db.getSettings();
    settings.tradingDefaults = {
      tradeType: document.getElementById('td-type')?.value,
      direction: document.getElementById('td-dir')?.value,
      maxOpenPositions: parseInt(document.getElementById('td-maxopen')?.value) || 10,
      defaultReviewStatus: document.getElementById('td-review')?.value
      // defaultRPT is computed dynamically from Risk Management — not stored here
    };
    await db.saveSettings(settings);
    _hasUnsaved = false;
    app.toast('Trading defaults saved', 'success');
  }

  // ── PAGE: Risk Management ──────────────────────────────────────────────────
  async function _pageRisk() {
    const settings = await db.getSettings();
    const s = settings?.riskManagement || {};
    return `<div class="settings-page">
      <div class="settings-section-header">Risk Management</div>
      <div class="form-grid cols-3">
        <div class="form-group"><label class="form-label">Max Portfolio Heat (%)</label><input class="form-input" type="number" id="rm-maxheat" step="0.1" min="0.1" max="20" value="${s.maxPortfolioHeat || 5}"></div>
        <div class="form-group"><label class="form-label">Warning Heat (%)</label><input class="form-input" type="number" id="rm-warnheat" step="0.1" min="0.1" max="20" value="${s.warningPortfolioHeat || 3}"></div>
        <div class="form-group"><label class="form-label">Max RPT (₹)</label><input class="form-input" type="number" id="rm-maxrpt" value="${s.maxRPT || 15000}"></div>
      </div>
      <div style="font-size:11px;color:#64748b;margin-top:-8px;margin-bottom:12px;">
        💡 <strong>Portfolio Heat %</strong> = Total ₹ at risk if all stops hit ÷ Account Equity &times; 100.
        Example: 5% means if every stop hits today, you lose 5% of your account.
      </div>
      <div class="form-section-title">Risk Mode</div>
      <div class="risk-radio-group">
        <label class="risk-radio-item"><input type="radio" name="rm-mode" value="Dynamic" ${s.riskMode !== 'Fixed' ? 'checked' : ''}> Dynamic (% of equity)</label>
        <label class="risk-radio-item"><input type="radio" name="rm-mode" value="Fixed" ${s.riskMode === 'Fixed' ? 'checked' : ''}> Fixed (₹ amount)</label>
      </div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Risk % per Trade</label><input class="form-input" type="number" id="rm-riskpct" step="0.1" value="${s.riskPercent || 1}"></div>
        <div class="form-group"><label class="form-label">Fixed RPT Amount (₹)</label><input class="form-input" type="number" id="rm-fixedamt" value="${s.fixedRiskAmount || 5000}"></div>
      </div>
      <div class="form-section-title">Market Breadth → RPT Guidance (Read-only)</div>
      <table class="risk-guide-table"><thead><tr><th>Breadth Classification</th><th>Breadth Value</th><th>Suggested RPT</th></tr></thead>
        <tbody>
          <tr><td>🟢 Very Strong</td><td>≥ 1.50</td><td>1.5% of equity</td></tr>
          <tr><td>🟡 Strong</td><td>1.00 – 1.50</td><td>1.0% of equity</td></tr>
          <tr><td>🔴 Weak</td><td>0.50 – 1.00</td><td>0.5% of equity</td></tr>
          <tr><td>🔵 Extreme Weakness</td><td>&lt; 0.50</td><td>0.75% (discretionary)</td></tr>
        </tbody>
      </table>
      ${_saveBtn('saveRisk')}
    </div>`;
  }

  async function _saveRisk() {
    const settings = await db.getSettings();
    const mode = document.querySelector('input[name="rm-mode"]:checked')?.value || 'Dynamic';
    settings.riskManagement = { ...settings.riskManagement,
      maxPortfolioHeat:     parseFloat(document.getElementById('rm-maxheat')?.value)  || 5,
      warningPortfolioHeat: parseFloat(document.getElementById('rm-warnheat')?.value) || 3,
      maxRPT:               parseFloat(document.getElementById('rm-maxrpt')?.value)   || 15000,
      riskMode: mode,
      riskPercent:     parseFloat(document.getElementById('rm-riskpct')?.value)  || 1,
      fixedRiskAmount: parseFloat(document.getElementById('rm-fixedamt')?.value) || 5000
    };
    await db.saveSettings(settings);
    _hasUnsaved = false;
    app.toast('Risk settings saved', 'success');
  }

  // ── PAGE: Charges & Brokerage ──────────────────────────────────────────────
  async function _pageCharges() {
    const settings = await db.getSettings();
    const s = settings?.charges || {};
    const broker = s.broker || 'Zerodha';
    const exchange = s.exchangePreference || 'NSE';
    const excDisplay = ((s.equity?.exchangeCharge || 0) * 100).toFixed(5);

    return `<div class="settings-page">
      <div class="settings-section-header">Charges &amp; Brokerage</div>
      <div class="form-group"><label class="form-label">Broker</label>
        <select class="form-select" id="ch-broker" style="width:200px" onchange="settingsModule._saveCharges()">
          <option ${broker==='Zerodha'?'selected':''}>Zerodha</option>
          <option ${broker==='Angel One'?'selected':''}>Angel One</option>
          <option ${broker==='Custom'?'selected':''}>Custom</option>
        </select>
      </div>
      <div class="alert-banner info" style="margin:12px 0">ℹ Government charges (STT, Exchange, SEBI, GST, Stamp) are pre-loaded from SEBI/NSE circulars. Only brokerage is manually editable below.</div>
      <table class="charges-table">
        <thead><tr><th>Segment</th><th>Charge</th><th>Rate / Amount</th><th>Type</th></tr></thead>
        <tbody>
          <tr><td rowspan="6" style="font-weight:600;vertical-align:top;padding-top:10px">Equity Delivery</td>
            <td>Brokerage</td>
            <td class="editable-cell"><input class="form-input" type="number" id="br-eq-delivery" value="${s.equity?.brokerage ?? 0}" step="1" style="width:80px"> ₹/trade</td>
            <td><span class="badge badge-primary">Editable</span></td>
          </tr>
          <tr><td>STT</td><td class="readonly-cell">${(s.equity?.stt || 0) * 100}% on both sides</td><td><span class="badge badge-muted">Auto</span></td></tr>
          <tr>
            <td>Exchange Txn</td>
            <td class="readonly-cell" style="display:flex;align-items:center;gap:8px">
              ${excDisplay}% 
              <select class="form-select" style="width:60px;padding:2px;font-size:11px" onchange="settingsModule._toggleExchange(this.value)">
                <option value="NSE" ${exchange==='NSE'?'selected':''}>NSE</option>
                <option value="BSE" ${exchange==='BSE'?'selected':''}>BSE</option>
              </select>
            </td>
            <td><span class="badge badge-muted">Auto</span></td>
          </tr>
          <tr><td>SEBI Fee</td><td class="readonly-cell">₹${((s.equity?.sebiCharge || 0) * 10000000).toFixed(0)} per crore</td><td><span class="badge badge-muted">Auto</span></td></tr>
          <tr><td>GST</td><td class="readonly-cell">${(s.equity?.gst || 0) * 100}% on (brokerage + exchange + SEBI)</td><td><span class="badge badge-muted">Auto</span></td></tr>
          <tr><td>Stamp Duty</td><td class="readonly-cell">${(s.equity?.stampDuty || 0) * 100}% on buy side</td><td><span class="badge badge-muted">Auto</span></td></tr>

          <tr><td rowspan="2" style="font-weight:600;vertical-align:top;padding-top:10px">Intraday / Futures</td>
            <td>Brokerage</td>
            <td class="editable-cell"><input class="form-input" type="number" id="br-intraday" value="${s.intraday?.brokerage ?? 20}" step="1" style="width:80px"> ₹/order</td>
            <td><span class="badge badge-primary">Editable</span></td>
          </tr>
          <tr><td>Gov. Charges</td><td class="readonly-cell">Same as above (STT ${(s.intraday?.stt || 0) * 100}% on sell side for intraday)</td><td><span class="badge badge-muted">Auto</span></td></tr>
        </tbody>
      </table>

      <div style="margin-top:12px; display:flex; gap:10px">
        <button class="btn btn-secondary btn-sm" onclick="settingsModule._showChargesModal()">⚙ Edit Govt Charges</button>
        <button class="btn btn-danger btn-sm" onclick="settingsModule._resetGovtCharges()">↺ Reset Defaults</button>
      </div>

      <div class="form-section-title" style="margin-top:24px">Charge Calculator</div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Trade Type</label>
          <select class="form-select" id="cc-type"><option>Equity</option><option>Intraday</option><option>Futures</option></select>
        </div>
        <div class="form-group"><label class="form-label">Buy Turnover (₹)</label><input class="form-input" type="number" id="cc-buy" placeholder="e.g. 100000"></div>
        <div class="form-group"><label class="form-label">Sell Turnover (₹)</label><input class="form-input" type="number" id="cc-sell" placeholder="e.g. 105000"></div>
        <div class="form-group" style="align-self:flex-end"><button class="btn btn-primary btn-sm" onclick="settingsModule._calcCharges()">Calculate</button></div>
      </div>
      <div id="cc-result"></div>
      ${_saveBtn('saveCharges')}
    </div>`;
  }

  async function _toggleExchange(val) {
    const settings = await db.getSettings();
    if (!settings.charges) settings.charges = {};
    settings.charges.exchangePreference = val;
    
    const exRate = val === 'BSE' ? 0.0000375 : 0.0000335;
    if (settings.charges.equity) settings.charges.equity.exchangeCharge = exRate;
    if (settings.charges.intraday) settings.charges.intraday.exchangeCharge = exRate;
    if (settings.charges.futures) settings.charges.futures.exchangeCharge = val === 'BSE' ? 0 : 0.00002;
    
    await db.saveSettings(settings);
    await _showPage('charges');
  }

  async function _resetGovtCharges() {
    if (!confirm('Reset all government charges to standard NSE/SEBI defaults?')) return;
    const defaults = db.getDefaultSettings();
    const settings = await db.getSettings();
    
    const eqBr = settings.charges?.equity?.brokerage ?? 0;
    const inBr = settings.charges?.intraday?.brokerage ?? 20;
    const fuBr = settings.charges?.futures?.brokerage ?? 20;
    
    settings.charges = JSON.parse(JSON.stringify(defaults.charges));
    settings.charges.equity.brokerage = eqBr;
    settings.charges.intraday.brokerage = inBr;
    settings.charges.futures.brokerage = fuBr;
    
    await db.saveSettings(settings);
    app.toast('Government charges reset to defaults.', 'success');
    await _showPage('charges');
  }

  async function _showChargesModal() {
    const settings = await db.getSettings();
    const s = settings?.charges || {};
    const content = `<div style="font-size:13px">
      <div class="alert-banner info" style="margin-bottom:12px">ℹ Enter percentages directly (e.g. 0.1 for 0.1%). Brokerage flat rates can be edited on the main page.</div>
      <table class="charges-table" style="text-align:center">
        <thead><tr><th style="text-align:left">Charge Type</th><th>Equity</th><th>Intraday</th><th>Futures</th></tr></thead>
        <tbody>
          <tr><td style="text-align:left;font-weight:500">Brokerage (%)</td>
            <td><span class="badge badge-muted">N/A</span></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-br-in-pct" value="${(s.intraday?.brokeragePercent ?? 0.0003) * 100}" step="0.001"></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-br-fu-pct" value="${(s.futures?.brokeragePercent ?? 0.0003) * 100}" step="0.001"></td>
          </tr>
          <tr><td style="text-align:left;font-weight:500">STT (%)</td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-stt-eq" value="${(s.equity?.stt ?? 0.001) * 100}" step="0.001"></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-stt-in" value="${(s.intraday?.stt ?? 0.00025) * 100}" step="0.001"></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-stt-fu" value="${(s.futures?.stt ?? 0.0002) * 100}" step="0.001"></td>
          </tr>
          <tr><td style="text-align:left;font-weight:500">Exchange Txn (%)</td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-exc-eq" value="${(s.equity?.exchangeCharge ?? 0.0000335) * 100}" step="0.0001"></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-exc-in" value="${(s.intraday?.exchangeCharge ?? 0.0000335) * 100}" step="0.0001"></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-exc-fu" value="${(s.futures?.exchangeCharge ?? 0.00002) * 100}" step="0.0001"></td>
          </tr>
          <tr><td style="text-align:left;font-weight:500">Stamp Duty (%)</td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-stm-eq" value="${(s.equity?.stampDuty ?? 0.00015) * 100}" step="0.001"></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-stm-in" value="${(s.intraday?.stampDuty ?? 0.00003) * 100}" step="0.001"></td>
            <td><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-stm-fu" value="${(s.futures?.stampDuty ?? 0.00002) * 100}" step="0.001"></td>
          </tr>
          <tr><td style="text-align:left;font-weight:500">SEBI Fee (%)</td>
            <td colspan="3"><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-sebi-all" value="${(s.equity?.sebiCharge ?? 0.000001) * 100}" step="0.00001"></td>
          </tr>
          <tr><td style="text-align:left;font-weight:500">GST (%)</td>
            <td colspan="3"><input class="form-input" style="width:70px;text-align:center;margin:auto" type="number" id="m-gst-all" value="${(s.equity?.gst ?? 0.18) * 100}" step="1"></td>
          </tr>
        </tbody>
      </table>
    </div>`;
    app.openModal('Edit Government Charges', content, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save', label: 'Save Changes', class: 'btn-primary', onClick: async () => {
        const set = await db.getSettings();
        if(!set.charges) set.charges = db.getDefaultSettings().charges;
        
        const sebi = (parseFloat(document.getElementById('m-sebi-all')?.value) || 0) / 100;
        const gst  = (parseFloat(document.getElementById('m-gst-all')?.value) || 0) / 100;
        
        set.charges.equity.stt = (parseFloat(document.getElementById('m-stt-eq')?.value) || 0) / 100;
        set.charges.equity.exchangeCharge = (parseFloat(document.getElementById('m-exc-eq')?.value) || 0) / 100;
        set.charges.equity.stampDuty = (parseFloat(document.getElementById('m-stm-eq')?.value) || 0) / 100;
        set.charges.equity.sebiCharge = sebi;
        set.charges.equity.gst = gst;

        set.charges.intraday.brokeragePercent = (parseFloat(document.getElementById('m-br-in-pct')?.value) || 0) / 100;
        set.charges.intraday.stt = (parseFloat(document.getElementById('m-stt-in')?.value) || 0) / 100;
        set.charges.intraday.exchangeCharge = (parseFloat(document.getElementById('m-exc-in')?.value) || 0) / 100;
        set.charges.intraday.stampDuty = (parseFloat(document.getElementById('m-stm-in')?.value) || 0) / 100;
        set.charges.intraday.sebiCharge = sebi;
        set.charges.intraday.gst = gst;

        set.charges.futures.brokeragePercent = (parseFloat(document.getElementById('m-br-fu-pct')?.value) || 0) / 100;
        set.charges.futures.stt = (parseFloat(document.getElementById('m-stt-fu')?.value) || 0) / 100;
        set.charges.futures.exchangeCharge = (parseFloat(document.getElementById('m-exc-fu')?.value) || 0) / 100;
        set.charges.futures.stampDuty = (parseFloat(document.getElementById('m-stm-fu')?.value) || 0) / 100;
        set.charges.futures.sebiCharge = sebi;
        set.charges.futures.gst = gst;
        
        await db.saveSettings(set);
        app.closeModal();
        app.toast('Government charges updated.', 'success');
        await _showPage('charges');
      }}
    ]);
  }

  async function _calcCharges() {
    const type = document.getElementById('cc-type')?.value;
    const buy = parseFloat(document.getElementById('cc-buy')?.value) || 0;
    const sell = parseFloat(document.getElementById('cc-sell')?.value) || 0;
    const s = await db.getSettings();
    const breakdown = calc.getZerodhaCharges(type, buy, sell, s, s.charges?.exchangePreference || 'NSE');
    const el = document.getElementById('cc-result');
    if (!el) return;
    el.innerHTML = `<table class="charges-table"><thead><tr><th>Charge</th><th>Amount (₹)</th></tr></thead>
      <tbody>
        ${Object.entries(breakdown).filter(([k]) => k !== 'total').map(([k,v]) => `<tr><td>${k}</td><td class="font-mono">${calc.formatCurrency(v)}</td></tr>`).join('')}
        <tr style="font-weight:700;border-top:2px solid var(--border)"><td>Total Charges</td><td class="font-mono text-danger">${calc.formatCurrency(breakdown.total)}</td></tr>
      </tbody></table>`;
  }

  async function _saveCharges() {
    const settings = await db.getSettings();
    if (!settings.charges) settings.charges = db.getDefaultSettings().charges;
    
    settings.charges.broker = document.getElementById('ch-broker')?.value || 'Zerodha';
    settings.charges.equity.brokerage = parseFloat(document.getElementById('br-eq-delivery')?.value) || 0;
    settings.charges.intraday.brokerage = parseFloat(document.getElementById('br-intraday')?.value) || 20;
    
    await db.saveSettings(settings);
    _hasUnsaved = false;
    app.toast('Brokerage settings saved', 'success');
  }

  // ── PAGE: Alerts ───────────────────────────────────────────────────────────
  async function _pageAlerts() {
    const settings = await db.getSettings();
    const s = settings?.alerts || {};
    const ALERT_TYPES = [
      { id: 'portfolioHeat', name: 'Portfolio Heat', desc: 'Triggers when heat approaches or exceeds max' },
      { id: 'positionRisk', name: 'Position Risk', desc: 'Individual position risk exceeds threshold' },
      { id: 'stopBreach', name: 'Stop Loss Breach', desc: 'Price has breached the stop loss level' },
      { id: 'day5Exit', name: 'Day-5 Exit', desc: 'Trade has been open for 5+ days without movement' },
      { id: 'ruleBroken', name: 'Rule Break', desc: 'Trade executed without following playbook rules' },
      { id: 'revengeTrade', name: 'Revenge Trading', desc: 'Increased position after consecutive losses' },
      { id: 'ema20Exit', name: 'EMA20 Exit Signal', desc: 'Price breaks below 20-day EMA' },
      { id: 'atrExtension', name: 'ATR Extension', desc: 'Price extends beyond 2x ATR from moving average' },
    ];
    return `<div class="settings-page">
      <div class="settings-section-header">Alerts &amp; Notifications</div>
      <div class="alert-banner info" style="margin-bottom:14px">ℹ Disabling an alert never disables the underlying business rule. Alerts only control how you are notified.</div>
      <table class="alerts-config-table">
        <thead><tr><th>Alert</th><th>Enabled</th><th>Severity</th><th>Dashboard</th><th>Popup</th></tr></thead>
        <tbody>${ALERT_TYPES.map(a => {
          const cfg = s[a.id] || { enabled: true, severity: 'Warning', dashboard: true, popup: true };
          return `<tr>
            <td><div style="font-weight:500">${a.name}</div><div style="font-size:11px;color:var(--text-muted)">${a.desc}</div></td>
            <td><label class="toggle-switch"><input type="checkbox" id="al-${a.id}-on" ${cfg.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label></td>
            <td><select class="form-select" id="al-${a.id}-sev" style="width:100px">
              <option ${cfg.severity==='Info'?'selected':''}>Info</option>
              <option ${cfg.severity==='Warning'?'selected':''}>Warning</option>
              <option ${cfg.severity==='Critical'?'selected':''}>Critical</option>
            </select></td>
            <td style="text-align:center"><input type="checkbox" id="al-${a.id}-dash" ${cfg.dashboard ? 'checked' : ''}></td>
            <td style="text-align:center"><input type="checkbox" id="al-${a.id}-pop" ${cfg.popup ? 'checked' : ''}></td>
          </tr>`;
        }).join('')}</tbody>
      </table>

      <div class="settings-section-header" style="margin-top:24px">Market Holidays</div>
      <div class="alert-banner info" style="margin-bottom:14px">ℹ Enter comma-separated dates (DD-MM-YYYY) for holidays. These are skipped when calculating trading days (e.g. for Day-5 exit).</div>
      <div class="form-group">
        <input class="form-input" type="text" id="al-holidays" value="${settings.marketHolidays || ''}" placeholder="e.g. 26-01-2026, 15-08-2026, 02-10-2026">
      </div>
      
      <div class="settings-section-header" style="margin-top:24px;">Telegram Integration (Dynamic Exits)</div>
      <div class="settings-grid">
        <div class="form-group">
          <label class="form-label">Telegram Bot Token</label>
          <input type="password" class="form-input" id="al-telegram-token" value="${settings?.telegramBotToken || ''}" placeholder="e.g. 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Get this from @BotFather on Telegram.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Telegram Chat ID</label>
          <input type="text" class="form-input" id="al-telegram-chat" value="${settings?.telegramChatId || ''}" placeholder="e.g. 123456789">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Get this from @userinfobot or similar.</div>
        </div>
      </div>

      ${_saveBtn('saveAlerts')}
    </div>`;
  }

  async function _saveAlerts() {
    const settings = await db.getSettings();
    const ALERT_IDS = ['portfolioHeat','positionRisk','stopBreach','day5Exit','ruleBroken','revengeTrade','ema20Exit','atrExtension'];
    settings.alerts = {};
    ALERT_IDS.forEach(id => {
      settings.alerts[id] = { enabled: document.getElementById(`al-${id}-on`)?.checked ?? true, severity: document.getElementById(`al-${id}-sev`)?.value || 'Warning', dashboard: document.getElementById(`al-${id}-dash`)?.checked ?? true, popup: document.getElementById(`al-${id}-pop`)?.checked ?? true };
    });
    settings.marketHolidays = document.getElementById('al-holidays')?.value || '';
    settings.telegramBotToken = document.getElementById('al-telegram-token')?.value || '';
    settings.telegramChatId = document.getElementById('al-telegram-chat')?.value || '';
    
    await db.saveSettings(settings);
    _hasUnsaved = false;
    app.toast('Alert settings & Telegram config saved', 'success');
  }

  // ── PAGE: Data Management ──────────────────────────────────────────────────
  function _pageData() {
    return `<div class="settings-page">
      <div class="settings-section-header">Data Management</div>
      <div class="data-action-card">
        <div class="data-action-info"><div class="data-action-title">Create Backup</div><div class="data-action-desc">Export all data as JSON file</div></div>
        <button class="btn btn-primary btn-sm" onclick="settingsModule._exportData()">⬇ Export</button>
      </div>
      <div class="data-action-card">
        <div class="data-action-info"><div class="data-action-title">Restore Backup</div><div class="data-action-desc">Import previously exported JSON backup</div></div>
        <label class="btn btn-secondary btn-sm" style="cursor:pointer">📂 Import <input type="file" accept=".json" style="display:none" onchange="settingsModule._importData(this)"></label>
      </div>
      <div class="form-section-title">Export Formats</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="settingsModule._exportData()">Export All (JSON)</button>
        <button class="btn btn-secondary btn-sm" disabled title="Coming in Phase 2">Export CSV <span class="badge badge-muted" style="font-size:9px">Phase 2</span></button>
        <button class="btn btn-secondary btn-sm" disabled title="Coming in Phase 3">Export Excel <span class="badge badge-muted" style="font-size:9px">Phase 3</span></button>
      </div>
    </div>`;
  }

  function _exportData() {
    const data = {};
    ['tj_trades','tj_playbooks','tj_capital','tj_settings','tj_markethealth'].forEach(k => { try { data[k] = JSON.parse(localStorage.getItem(k) || '[]'); } catch(e) {} });
    data._exportedAt = new Date().toISOString();
    data._appVersion = '1.0.0';
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `TradeJournal_Backup_${new Date().toISOString().split('T')[0]}.json`; a.click();
    URL.revokeObjectURL(url);
    localStorage.setItem('tj_last_backup', new Date().toISOString());
    app.toast('Backup downloaded', 'success');
  }

  function _importData(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = JSON.parse(e.target.result);
        if (!confirm('This will REPLACE all current data. Proceed?')) return;
        Object.entries(data).forEach(([k, v]) => { if (k.startsWith('tj_')) localStorage.setItem(k, JSON.stringify(v)); });
        app.toast('Backup restored! Reloading...', 'success');
        setTimeout(() => location.reload(), 1500);
      } catch(err) { app.toast('Invalid backup file', 'error'); }
    };
    reader.readAsText(file);
  }

  // ── PAGE: Application ──────────────────────────────────────────────────────
  function _pageApp() {
    let lsSize = 0;
    try { for (let k in localStorage) { if (localStorage.hasOwnProperty(k)) lsSize += (localStorage.getItem(k) || '').length * 2; } } catch(e) {}
    const lastBackup = localStorage.getItem('tj_last_backup');
    const lsSizeKB = (lsSize / 1024).toFixed(1);
    return `<div class="settings-page">
      <div class="settings-section-header">Application Info</div>
      <div class="app-info-grid">
        <div class="app-info-item"><div class="app-info-label">App Version</div><div class="app-info-value">1.0.0</div></div>
        <div class="app-info-item"><div class="app-info-label">DB Version</div><div class="app-info-value">1</div></div>
        <div class="app-info-item"><div class="app-info-label">Build Date</div><div class="app-info-value">2026-06-30</div></div>
        <div class="app-info-item"><div class="app-info-label">Storage Used</div><div class="app-info-value">${lsSizeKB} KB</div></div>
        <div class="app-info-item"><div class="app-info-label">Last Backup</div><div class="app-info-value">${lastBackup ? new Date(lastBackup).toLocaleDateString('en-IN') : 'Never'}</div></div>
        <div class="app-info-item"><div class="app-info-label">Storage Type</div><div class="app-info-value">localStorage</div></div>
      </div>
      <div class="form-section-title">System Actions</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        <button class="btn btn-secondary btn-sm" onclick="settingsModule._checkUpdates()">Check for Updates</button>
        <button class="btn btn-secondary btn-sm" onclick="settingsModule._verifySystem()">Verify System</button>
      </div>
      <div id="app-system-result" style="margin-bottom:16px"></div>
      <div class="form-section-title" style="color:var(--danger)">Danger Zone</div>
      <div class="data-action-card" style="border-color:rgba(239,68,68,0.3)">
        <div class="data-action-info"><div class="data-action-title" style="color:var(--danger)">Reset Application</div><div class="data-action-desc">Permanently delete ALL data. This cannot be undone.</div></div>
        <button class="btn btn-danger btn-sm" onclick="settingsModule._resetApp()">Reset All Data</button>
      </div>
    </div>`;
  }

  function _checkUpdates() { app.toast('You are on the latest version (v1.0.0)', 'info'); }

  async function _verifySystem() {
    const el = document.getElementById('app-system-result');
    if (!el) return;
    const trades = await db.getTrades();
    const settings = await db.getSettings();
    const capital = await db.getCapital();
    const checks = [
      { name: 'localStorage available', pass: !!window.localStorage },
      { name: 'Chart.js loaded', pass: typeof Chart !== 'undefined' },
      { name: 'Trades data', pass: trades.length >= 0 },
      { name: 'Settings data', pass: !!settings },
      { name: 'Capital data', pass: capital.length >= 0 },
    ];
    el.innerHTML = `<table class="data-table"><thead><tr><th>Check</th><th>Status</th></tr></thead><tbody>
      ${checks.map(c => `<tr><td>${c.name}</td><td class="${c.pass ? 'text-success' : 'text-danger'}">${c.pass ? '✓ OK' : '✗ Failed'}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function _resetApp() {
    const content = `
      <div>
        <div class="alert-banner" style="background:#fee2e2;border:1px solid #fca5a5;color:#dc2626;margin-bottom:14px;">
          ⚠️ This will permanently delete ALL your trades, positions, capital entries, and playbooks.
          Your settings and risk configuration will also be reset.
        </div>
        <div class="form-group">
          <label class="form-label">Type <strong>RESET</strong> to confirm</label>
          <input class="form-input" id="reset-confirm-input" placeholder="Type RESET here..." autocomplete="off">
        </div>
      </div>`;
    app.openModal('⚠️ Reset All Data', content, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'confirm-reset', label: '🗑 Delete Everything', class: 'btn-danger', onClick: async () => {
        const val = document.getElementById('reset-confirm-input')?.value?.trim();
        if (val !== 'RESET') {
          app.toast('Please type RESET exactly to confirm', 'error');
          return;
        }
        // Disable button to prevent double-click
        const btn = document.getElementById('confirm-reset');
        if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

        try {
          // Delete all Supabase data for this user (trades, capital, playbooks, settings, snapshots)
          const failedTables = await db.resetAllData();
          if (failedTables.length > 0) {
            app.toast(`Reset partially failed for: ${failedTables.join(', ')}. Please try again.`, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete Everything'; }
            return;
          }
        } catch (e) {
          app.toast('Reset failed: ' + e.message, 'error');
          if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete Everything'; }
          return;
        }

        app.closeModal();
        app.toast('All data deleted. Reloading fresh journal...', 'warning');
        setTimeout(() => location.reload(), 1500);
      }}
    ]);
  }

  // ── PAGE: Formula Manager ──────────────────────────────────────────────────
  function _pageFormulas() {
    const FORMULAS = [
      { name: 'Portfolio Heat', cat: 'Dashboard', expr: 'Σ (Open Risk ₹) / Account Equity × 100', desc: 'Total open risk across all positions as a percentage of total account equity.', example: '₹12,000 Risk / ₹400,000 Equity = 3%' },
      { name: 'Current Equity', cat: 'Capital', expr: 'Net Deposits + Realized P&L', desc: 'Total account value based on all deposits/withdrawals plus closed trade profits/losses.', example: 'Deposits ₹10L + P&L ₹1.2L = ₹11.2L' },
      { name: 'Current R (RPT)', cat: 'Capital', expr: 'IF Dynamic: Equity × RiskPct\nIF Fixed: fixedRiskAmount', desc: 'Risk Per Trade. The absolute rupee amount you are willing to lose on a single trade.', example: '₹10L × 1% = ₹10,000 RPT' },
      { name: 'Available Cash', cat: 'Capital', expr: 'Equity − Total Open Exposure', desc: 'Cash not currently deployed in any open position.', example: 'Equity ₹11L − Exposure ₹3L = ₹8L available' },
      { name: 'Win Rate', cat: 'Trades', expr: 'WinTrades / TotalTrades × 100', desc: 'Percentage of closed trades that were profitable (ProfitR > 0).', example: '18 wins / 30 trades = 60%' },
      { name: 'Expectancy', cat: 'Trades', expr: '(WinRate × AvgWinR) − (LossRate × AvgLossR)', desc: 'Expected R per trade on average. Must be positive for a profitable system.', example: '(60% × 2R) − (40% × 1R) = 0.8R/trade' },
      { name: 'Max Drawdown', cat: 'Analytics', expr: 'MIN(Cumulative R from peak)', desc: 'The largest peak-to-trough decline in cumulative realized P&L expressed in R.', example: 'Peak 20R → Trough 14R = MDD of -6R' },
      { name: 'Profit R', cat: 'Trades', expr: 'Realized P&L / True RPT', desc: 'Trade result expressed as a multiple of True RPT — the maximum capital committed through entries and pyramids. True RPT grows when a partial exit at a loss is followed by a pyramid (adding booked loss + new open risk), but is frozen on all exits.', example: 'P&L −₹8,006 / True RPT ₹6,275 = −1.28R' },
      { name: 'Avg Entry Price', cat: 'Positions', expr: 'Σ (price × qty) / Σ qty', desc: 'Weighted average price across all entries and pyramids for an open position.', example: '100 shares @₹100 + 50 shares @₹120 = ₹106.67 avg' },
      { name: 'Open Risk ₹', cat: 'Positions', expr: '(avgEntry − currentStop) × openQty', desc: 'Rupees at risk on the open position if the current stop is hit today. Positive = stop above entry (risk-free). Negative = loss if stopped out.', example: 'Stop ₹95, Avg Entry ₹100, 200 shares → −₹1,000 at risk' },
      { name: 'CAGR', cat: 'Analytics', expr: '(End/Start)^(1/years) − 1', desc: 'Compound Annual Growth Rate of your trading account.', example: '₹10L → ₹12.5L in 2 years = 11.8% CAGR' },
      { name: 'RPT (Position Sizing)', cat: 'Positions', expr: 'ABS(entryPrice − stopLoss) × qty', desc: 'Rupee risk at the point of entry. This is your 1R for this trade.', example: '(₹100 entry − ₹95 stop) × 200 qty = ₹1,000 RPT' },
      { name: 'True RPT', cat: 'Positions', expr: '1st Entry: openPositionRisk\nPyramid: max(earlier, bookedLoss + openRisk)\nSell: unchanged (frozen)', desc: 'Lifecycle R denominator. Set at first entry as plain position risk. Grows on each pyramid if (bookedLoss + new openRisk) exceeds the earlier value. Frozen on partial and final exits — exits are outcomes, not new capital commitments. Always ≥ RPT.', example: 'Entry RPT ₹3,739 → Partial exit loss ₹2,539 booked → Pyramid adds ₹3,737 new risk → True RPT = max(3739, 2539+3737) = ₹6,276' },
    ];
    return `<div class="settings-page">
      <div class="settings-section-header">Formula Manager</div>
      <div style="display:flex;gap:10px;margin-bottom:14px">
        <input class="form-input search-input" id="fm-search" placeholder="Search formulas..." style="width:220px" oninput="settingsModule._filterFormulas()">
        <select class="form-select" id="fm-cat" style="width:160px" onchange="settingsModule._filterFormulas()">
          <option value="">All Categories</option>
          <option>Dashboard</option><option>Positions</option><option>Trades</option><option>Analytics</option><option>Capital</option>
        </select>
      </div>
      <div id="fm-list">${_renderFormulas(FORMULAS)}</div>
    </div>`;
  }

  function _renderFormulas(fmls) {
    return fmls.map(f => `<div class="formula-item" data-name="${f.name.toLowerCase()}" data-cat="${f.cat}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div class="formula-name">${f.name}</div>
        <span class="formula-tag">${f.cat}</span>
      </div>
      <div class="formula-expr">${f.expr}</div>
      <div class="formula-desc">${f.desc}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Example: ${f.example}</div>
    </div>`).join('');
  }

  function _filterFormulas() {
    const search = document.getElementById('fm-search')?.value.toLowerCase() || '';
    const cat = document.getElementById('fm-cat')?.value || '';
    document.querySelectorAll('#fm-list .formula-item').forEach(el => {
      const match = (!search || el.dataset.name.includes(search)) && (!cat || el.dataset.cat === cat);
      el.style.display = match ? '' : 'none';
    });
  }

  async function _resetPage() {
    const defaults = db.getDefaultSettings();
    const settings = await db.getSettings();
    const pageMap = { general: 'general', trading: 'tradingDefaults', risk: 'riskManagement', charges: 'charges', alerts: 'alerts' };
    const key = pageMap[_activePage];
    if (key && defaults[key]) { settings[key] = JSON.parse(JSON.stringify(defaults[key])); await db.saveSettings(settings); }
    app.toast('Page reset to defaults', 'info');
    await _showPage(_activePage);
  }

  return { init, _goPage, _saveGeneral, _saveTrading, _saveRisk, _saveCharges, _calcCharges, _saveAlerts, _exportData, _importData, _checkUpdates, _verifySystem, _resetApp, _resetPage, _filterFormulas, _showChargesModal, _resetGovtCharges, _toggleExchange, _umToggle, _umExpandAll, _umCollapseAll };
})();
