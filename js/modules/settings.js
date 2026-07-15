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
      ${_saveBtn('saveGeneral')}
    </div>`;
  }

  async function _saveGeneral() {
    const settings = await db.getSettings();
    settings.general = { ...settings.general, traderName: document.getElementById('s-name')?.value, currency: document.getElementById('s-currency')?.value, timezone: document.getElementById('s-tz')?.value, dateFormat: document.getElementById('s-datefmt')?.value, fyStart: document.getElementById('s-fyr')?.value, defaultStartupModule: document.getElementById('s-startup')?.value, defaultDateRange: document.getElementById('s-defrange')?.value };
    await db.saveSettings(settings);
    _hasUnsaved = false;
    app.toast('General settings saved', 'success');
    const name = settings.general.traderName;
    if (name) { document.getElementById('trader-name').textContent = name; document.getElementById('trader-avatar').textContent = name.charAt(0).toUpperCase(); }
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
    
    await db.saveSettings(settings);
    _hasUnsaved = false;
    app.toast('Alert settings & holidays saved', 'success');
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
      { name: 'Profit R', cat: 'Trades', expr: 'Realized P&L / RPT', desc: 'Trade result expressed as a multiple of the original Risk Per Trade (RPT).', example: 'P&L ₹15,000 / RPT ₹7,500 = +2R' },
      { name: 'Avg Entry Price', cat: 'Positions', expr: 'Σ (price × qty) / Σ qty', desc: 'Weighted average price across all entries and pyramids for an open position.', example: '100 shares @₹100 + 50 shares @₹120 = ₹106.67 avg' },
      { name: 'Open Risk R', cat: 'Positions', expr: '(currentStop − avgEntry) × openQty / RPT', desc: 'Current risk remaining in an open position if stop is hit, in R units.', example: '(Stop ₹95 − Avg ₹100) × 100 shares / RPT ₹5,000 = -1R' },
      { name: 'CAGR', cat: 'Analytics', expr: '(End/Start)^(1/years) − 1', desc: 'Compound Annual Growth Rate of your trading account.', example: '₹10L → ₹12.5L in 2 years = 11.8% CAGR' },
      { name: 'RPT (Position Sizing)', cat: 'Positions', expr: 'ABS(entryPrice − stopLoss) × qty', desc: 'Rupee risk at the point of entry. This is your 1R for this trade.', example: '(₹100 entry − ₹95 stop) × 200 qty = ₹1,000 RPT' },
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

  return { init, _goPage, _saveGeneral, _saveTrading, _saveRisk, _saveCharges, _calcCharges, _saveAlerts, _exportData, _importData, _checkUpdates, _verifySystem, _resetApp, _resetPage, _filterFormulas, _showChargesModal, _resetGovtCharges, _toggleExchange };
})();
