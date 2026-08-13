/**
 * mobile.js - TradeJournal Mobile Module v1.1
 * Activated only on screens <= 767px.
 * Works WITH app.navigate() - injects card views into existing module pages.
 */
const MobileModule = (() => {

  const IS_MOBILE = () => window.innerWidth <= 767;

  // Map mobile tab names -> app module IDs
  const TAB_MODULE = {
    positions: 'positions',
    watchlist:  'watchlist',
    paper:      'paper',
    dashboard:  'dashboard'
  };

  let _currentTab = 'positions';

  // â”€â”€ Bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function init(initialTab = 'positions') {
    if (!IS_MOBILE()) return;
    _injectBottomNav();
    _injectBottomSheet();
    switchTab(initialTab);
  }

  // NOTE: Service Worker is registered in index.html on window load.

  // â”€â”€ Bottom Nav â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _injectBottomNav() {
    const nav = document.getElementById('mobile-bottom-nav');
    if (!nav) return;
    nav.innerHTML = `
      <button class="mobile-nav-tab active" id="mnav-positions" onclick="MobileModule.switchTab('positions')">
        <span class="mobile-nav-icon">ðŸ“ˆ</span>
        <span class="mobile-nav-label">Positions</span>
      </button>
      <button class="mobile-nav-tab" id="mnav-watchlist" onclick="MobileModule.switchTab('watchlist')">
        <span class="mobile-nav-icon">ðŸ‘</span>
        <span class="mobile-nav-label">Watchlist</span>
      </button>
      <button class="mobile-nav-tab" id="mnav-paper" onclick="MobileModule.switchTab('paper')">
        <span class="mobile-nav-icon">ðŸ“„</span>
        <span class="mobile-nav-label">Paper</span>
      </button>
      <button class="mobile-nav-tab" id="mnav-dashboard" onclick="MobileModule.switchTab('dashboard')">
        <span class="mobile-nav-icon">ðŸ“Š</span>
        <span class="mobile-nav-label">Summary</span>
        <span class="mobile-nav-badge" id="mobile-alert-badge" style="display:none">0</span>
      </button>`;
  }

  // â”€â”€ Bottom Sheet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _injectBottomSheet() {
    if (document.getElementById('mobile-bottom-sheet')) return;
    const sheet = document.createElement('div');
    sheet.id = 'mobile-bottom-sheet';
    sheet.innerHTML = `<div class="sheet-handle"></div><div id="mobile-sheet-content"></div>`;
    document.body.appendChild(sheet);

    const bd = document.createElement('div');
    bd.id = 'mobile-sheet-backdrop';
    bd.onclick = closeSheet;
    document.body.appendChild(bd);
  }

  function openSheet(html) {
    document.getElementById('mobile-sheet-content').innerHTML = html;
    document.getElementById('mobile-bottom-sheet')?.classList.add('sheet-open');
    document.getElementById('mobile-sheet-backdrop')?.classList.add('active');
  }

  function closeSheet() {
    document.getElementById('mobile-bottom-sheet')?.classList.remove('sheet-open');
    document.getElementById('mobile-sheet-backdrop')?.classList.remove('active');
  }

  // â”€â”€ Tab Switcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function switchTab(tab) {
    if (!IS_MOBILE()) return;
    _currentTab = tab;

    // Update active state on nav tabs
    ['positions','watchlist','paper','dashboard'].forEach(t => {
      document.getElementById(`mnav-${t}`)?.classList.toggle('active', t === tab);
    });

    // Use app.navigate to show the correct desktop page
    // (it handles the .active class on .module-page divs)
    const moduleId = TAB_MODULE[tab];
    if (window.app?.navigate) app.navigate(moduleId);

    closeSheet();

    // After page is active, inject mobile cards into it
    // Small delay to let app.navigate + module.init() run first
    setTimeout(async () => {
      switch(tab) {
        case 'positions':  await _renderPositions();  break;
        case 'watchlist':  await _renderWatchlist();   break;
        case 'paper':      await _renderPaperTrades(); break;
        case 'dashboard':  await _renderDashboard();   break;
      }
    }, 150);
  }

  // â”€â”€ Alert Badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _updateAlertBadge() {
    try {
      const trades = await db.getOpenTrades();
      let count = 0;
      trades.forEach(t => {
        count += (t.alerts || []).filter(a => a.status === 'Triggered').length;
      });
      const badge = document.getElementById('mobile-alert-badge');
      if (!badge) return;
      badge.style.display = count > 0 ? 'flex' : 'none';
      badge.textContent = count > 9 ? '9+' : String(count);
    } catch(e) {}
  }

  // â”€â”€ Card Container helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Finds the table inside parentId and hides it, creates a mobile-cards div
  function _getCardContainer(parentId, cardId) {
    const parent = document.getElementById(parentId);
    if (!parent) return null;
    // Hide the existing desktop table
    const table = parent.querySelector('.data-table, table');
    if (table) table.style.display = 'none';
    // Return existing or create new container
    let container = document.getElementById(cardId);
    if (!container) {
      container = document.createElement('div');
      container.id = cardId;
      container.className = 'mobile-cards';
      parent.appendChild(container);
    }
    return container;
  }

  // â”€â”€ Positions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _renderPositions() {
    const container = _getCardContainer('pos-table-panel', 'mobile-pos-cards');
    if (!container) return;
    container.innerHTML = _loadingHtml();
    await _updateAlertBadge();

    let trades = [];
    try { trades = await db.getOpenTrades(); } catch(e) {}

    if (!trades.length) {
      container.innerHTML = _emptyHtml('ðŸ“ˆ', 'No open positions', 'Open the desktop app to add trades');
      return;
    }
    container.innerHTML = trades.map(t => _tradeCard(t)).join('');
  }

  // â”€â”€ Watchlist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _renderWatchlist() {
    const container = _getCardContainer('watchlist-table-panel', 'mobile-wl-cards');
    if (!container) return;
    container.innerHTML = _loadingHtml();

    let items = [];
    try { items = await db.getWatchlist(); } catch(e) {}

    if (!items.length) {
      container.innerHTML = _emptyHtml('ðŸ‘', 'Watchlist is empty', 'Add setups from the desktop app');
      return;
    }
    container.innerHTML = items.map(item => {
      const cmp     = parseFloat(item.cmp) || 0;
      const trigger = parseFloat(item.trigger_price) || 0;
      const stop    = parseFloat(item.stop_loss) || 0;
      const pct     = trigger > 0 && cmp > 0 ? (((cmp - trigger) / trigger) * 100).toFixed(1) : null;
      const isTrig  = item.status === 'triggered';
      const pctColor = isTrig ? '#f59e0b' : (pct !== null && parseFloat(pct) >= 0 ? '#10b981' : '#ef4444');

      return `<div class="mobile-trade-card ${isTrig ? 'card-triggered' : 'card-neutral'}"
                   onclick="MobileModule.openWatchlistSheet('${item.id}')">
        <div class="mobile-card-top">
          <div>
            <div class="mobile-card-symbol">${item.symbol || ''}</div>
            <div class="mobile-card-sector">${item.sector || 'â€”'}</div>
          </div>
          <span class="badge" style="font-size:11px;background:${isTrig ? 'rgba(245,158,11,0.15)' : 'rgba(99,102,241,0.12)'};color:${isTrig ? '#f59e0b' : '#818cf8'}">
            ${isTrig ? 'âš¡ Triggered' : 'â— Monitoring'}
          </span>
        </div>
        <div class="mobile-card-mid">
          <div class="mobile-card-field"><div class="mobile-card-label">Trigger</div>
            <div class="mobile-card-value">â‚¹${_fmt(trigger)}</div></div>
          <div class="mobile-card-field"><div class="mobile-card-label">CMP</div>
            <div class="mobile-card-value" style="color:${pctColor}">${cmp ? 'â‚¹' + _fmt(cmp) : 'â€”'}</div></div>
          <div class="mobile-card-field"><div class="mobile-card-label">Stop</div>
            <div class="mobile-card-value" style="color:#ef4444">â‚¹${_fmt(stop)}</div></div>
          <div class="mobile-card-field"><div class="mobile-card-label">Gap to Trigger</div>
            <div class="mobile-card-value" style="color:${pctColor}">${pct !== null ? (parseFloat(pct) >= 0 ? '+' : '') + pct + '%' : 'â€”'}</div></div>
        </div>
        ${item.notes ? `<div class="mobile-card-bottom"><span style="font-size:11px;color:var(--text-muted);font-style:italic">"${item.notes.substring(0,60)}${item.notes.length > 60 ? 'â€¦' : ''}"</span></div>` : ''}
      </div>`;
    }).join('');
  }

  // â”€â”€ Paper Trades â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _renderPaperTrades() {
    const container = _getCardContainer('pt-table-panel', 'mobile-pt-cards');
    if (!container) return;
    container.innerHTML = _loadingHtml();

    let trades = [];
    try { trades = (await db.getPaperTrades()) || []; } catch(e) {}

    if (!trades.length) {
      container.innerHTML = _emptyHtml('ðŸ“„', 'No paper trades yet', 'Use the Watchlist to start a simulation');
      return;
    }
    container.innerHTML = trades.map(t => _tradeCard(t, true)).join('');
  }

  // â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function _renderDashboard() {
    // Inject into the dashboard module page directly
    const page = document.getElementById('mod-dashboard');
    if (!page) return;

    let container = document.getElementById('mobile-dash-summary');
    if (!container) {
      container = document.createElement('div');
      container.id = 'mobile-dash-summary';
      page.insertAdjacentElement('afterbegin', container);
    }
    container.innerHTML = _loadingHtml();
    await _updateAlertBadge();

    let openTrades = [], allTrades = [];
    try { openTrades = await db.getOpenTrades(); } catch(e) {}
    try { allTrades  = await db.getTrades();     } catch(e) {}

    const closed = allTrades.filter(t => t.finalExit);
    const wins   = closed.filter(t => {
      const isShort = t.direction === 'Short';
      const ep = t.entries?.[0]?.price || 0;
      const xp = t.finalExit?.price || 0;
      return isShort ? xp < ep : xp > ep;
    });
    const wr = closed.length ? Math.round((wins.length / closed.length) * 100) : 0;

    // Gather all active alerts
    const allAlerts = [];
    openTrades.forEach(t => {
      (t.alerts || []).filter(a => a.status === 'Triggered').forEach(a => {
        allAlerts.push({ symbol: t.symbol, type: a.type, msg: a.message || '' });
      });
    });

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">
        <div class="stat-card" style="text-align:center;padding:14px">
          <div class="stat-label" style="font-size:10px">Open</div>
          <div class="stat-value" style="font-size:22px">${openTrades.length}</div>
        </div>
        <div class="stat-card" style="text-align:center;padding:14px">
          <div class="stat-label" style="font-size:10px">Win Rate</div>
          <div class="stat-value" style="font-size:22px;color:${wr >= 50 ? '#10b981' : '#ef4444'}">${wr}%</div>
        </div>
        <div class="stat-card" style="text-align:center;padding:14px">
          <div class="stat-label" style="font-size:10px">Alerts</div>
          <div class="stat-value" style="font-size:22px;color:${allAlerts.length > 0 ? '#f59e0b' : '#10b981'}">${allAlerts.length}</div>
        </div>
      </div>
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:12px">Active Alerts</div>
      ${allAlerts.length === 0
        ? `<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">âœ… All clear â€” no active alerts</div>`
        : allAlerts.map(a => `
          <div style="background:var(--surface);border:1px solid rgba(245,158,11,0.2);border-radius:12px;padding:12px;margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <strong style="font-size:15px">${a.symbol}</strong>
              <span class="mobile-alert-pill ${a.type.includes('Stop') ? 'alert-stop' : ''}">âš¡ ${_shortLabel(a.type)}</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);line-height:1.6">
              ${a.msg.substring(0, 140)}${a.msg.length > 140 ? 'â€¦' : ''}
            </div>
          </div>`).join('')}`;
  }

  // â”€â”€ Trade Card (positions + paper trades) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _tradeCard(trade, isPaper = false) {
    let m;
    try {
      m = calc?.getTradeMetrics ? calc.getTradeMetrics(trade) : _fallback(trade);
    } catch(e) { m = _fallback(trade); }

    const entry     = m.avgEntryPrice || trade.entries?.[0]?.price || 0;
    const stop      = m.currentStop || trade.initialStop || 0;
    const cmp       = parseFloat(trade.cmp) || entry;
    const isLong    = trade.direction !== 'Short';
    const openQty   = m.openQty || db.getTradeRemainingQty(trade) || 0;
    const pnl       = openQty > 0 ? (isLong ? cmp - entry : entry - cmp) * openQty : 0;
    const risk      = Math.abs(entry - (trade.initialStop || entry));
    const rMult     = risk > 0 && openQty > 0 ? ((isLong ? cmp - entry : entry - cmp) / risk).toFixed(2) : null;
    const pnlPct    = entry > 0 ? (((cmp - entry) / entry) * 100 * (isLong ? 1 : -1)).toFixed(1) : 0;
    const pnlColor  = pnl > 0 ? '#10b981' : pnl < 0 ? '#ef4444' : 'var(--text-muted)';
    const cardClass = pnl > 0 ? 'card-profit' : pnl < 0 ? 'card-loss' : 'card-neutral';
    const isClosed  = openQty <= 0;

    const activeAlert = !isPaper ? (trade.alerts || []).find(a => a.status === 'Triggered') : null;
    const clickFn = isPaper
      ? `MobileModule.openPaperSheet('${trade.id}')`
      : `MobileModule.openTradeSheet('${trade.id}')`;

    return `<div class="mobile-trade-card ${cardClass}" onclick="${clickFn}">
      <div class="mobile-card-top">
        <div>
          <div class="mobile-card-symbol">${trade.symbol || ''}
            ${isPaper ? '<span style="font-size:10px;color:#818cf8;font-weight:500"> Paper</span>' : ''}
            <span style="font-size:11px;font-weight:400;color:var(--text-muted)"> ${trade.direction || 'Long'}</span>
          </div>
          <div class="mobile-card-sector">${trade.sector || 'â€”'} Â· ${trade.entries?.[0]?.date || ''}</div>
        </div>
        <div class="mobile-card-status">
          <span style="font-size:14px;font-weight:700;color:${pnlColor}">${pnl >= 0 ? '+' : ''}â‚¹${_fmt(Math.abs(pnl))}</span>
          ${rMult ? `<span style="font-size:11px;color:${pnlColor}">${parseFloat(rMult) >= 0 ? '+' : ''}${rMult}R</span>` : ''}
        </div>
      </div>
      <div class="mobile-card-mid">
        <div class="mobile-card-field">
          <div class="mobile-card-label">CMP</div>
          <div class="mobile-card-value" style="color:${pnlColor}">â‚¹${_fmt(cmp)}
            <span style="font-size:10px"> ${pnlPct > 0 ? '+' : ''}${pnlPct}%</span>
          </div>
        </div>
        <div class="mobile-card-field">
          <div class="mobile-card-label">Entry</div>
          <div class="mobile-card-value">â‚¹${_fmt(entry)}</div>
        </div>
        <div class="mobile-card-field">
          <div class="mobile-card-label">Stop</div>
          <div class="mobile-card-value" style="color:#ef4444">â‚¹${_fmt(stop)}</div>
        </div>
        <div class="mobile-card-field">
          <div class="mobile-card-label">${isClosed ? 'Status' : 'Open Qty'}</div>
          <div class="mobile-card-value">${isClosed ? '<span style="color:var(--text-muted)">Closed</span>' : openQty}</div>
        </div>
      </div>
      <div class="mobile-card-bottom">
        ${activeAlert
          ? `<span class="mobile-alert-pill ${activeAlert.type.includes('Stop') ? 'alert-stop' : ''}">âš¡ ${_shortLabel(activeAlert.type)}</span>`
          : `<span class="mobile-alert-pill alert-ok">â— ${isClosed ? 'Closed' : 'Monitoring'}</span>`}
        <span style="font-size:11px;color:var(--text-muted)">â†’ Details</span>
      </div>
    </div>`;
  }

  // â”€â”€ Detail Sheets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function openTradeSheet(id) {
    let trade;
    try {
      const trades = await db.getOpenTrades();
      trade = trades.find(t => t.id === id);
    } catch(e) {}
    if (!trade) return;
    openSheet(_tradeSheetHtml(trade));
  }

  async function openPaperSheet(id) {
    let trade;
    try {
      const trades = await db.getPaperTrades();
      trade = trades.find(t => t.id === id);
    } catch(e) {}
    if (!trade) return;
    openSheet(_tradeSheetHtml(trade, true));
  }

  async function openWatchlistSheet(id) {
    let item;
    try {
      const items = await db.getWatchlist();
      item = items.find(i => i.id === id);
    } catch(e) {}
    if (!item) return;

    openSheet(`
      <div class="sheet-title">
        <span>${item.symbol}</span>
        <button class="sheet-close-btn" onclick="MobileModule.closeSheet()">âœ•</button>
      </div>
      <div class="sheet-section">
        <div class="sheet-section-title">Setup Levels</div>
        <div class="sheet-grid">
          <div class="sheet-field"><div class="sheet-field-label">Trigger Price</div><div class="sheet-field-value">â‚¹${_fmt(item.trigger_price)}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Stop Loss</div><div class="sheet-field-value" style="color:#ef4444">â‚¹${_fmt(item.stop_loss)}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Sector</div><div class="sheet-field-value" style="font-size:13px">${item.sector || 'â€”'}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Status</div><div class="sheet-field-value" style="font-size:13px;text-transform:capitalize">${item.status || 'monitoring'}</div></div>
        </div>
      </div>
      ${item.notes ? `<div class="sheet-section"><div class="sheet-section-title">Setup Thesis</div>
        <div class="sheet-alert-box" style="background:rgba(99,102,241,0.05);border-color:rgba(99,102,241,0.2)">${item.notes}</div></div>` : ''}
    `);
  }

  function _tradeSheetHtml(trade, isPaper = false) {
    let m;
    try { m = calc?.getTradeMetrics ? calc.getTradeMetrics(trade) : _fallback(trade); }
    catch(e) { m = _fallback(trade); }

    const entry   = m.avgEntryPrice || trade.entries?.[0]?.price || 0;
    const stop    = m.currentStop || trade.initialStop || 0;
    const cmp     = parseFloat(trade.cmp) || entry;
    const isLong  = trade.direction !== 'Short';
    const openQty = m.openQty || 0;
    const pnl     = openQty > 0 ? (isLong ? cmp - entry : entry - cmp) * openQty : 0;
    const risk    = Math.abs(entry - (trade.initialStop || entry));
    const rMult   = risk > 0 && openQty > 0 ? ((isLong ? cmp - entry : entry - cmp) / risk).toFixed(2) : 'â€”';
    const pnlColor = pnl >= 0 ? '#10b981' : '#ef4444';
    const activeAlert = !isPaper ? (trade.alerts || []).find(a => a.status === 'Triggered') : null;

    return `
      <div class="sheet-title">
        <div>${trade.symbol} <span style="font-size:12px;color:var(--text-muted)">${trade.direction || 'Long'}${isPaper ? ' Â· Paper' : ''}</span></div>
        <button class="sheet-close-btn" onclick="MobileModule.closeSheet()">âœ•</button>
      </div>
      <div class="sheet-section">
        <div class="sheet-section-title">Price Levels</div>
        <div class="sheet-grid">
          <div class="sheet-field"><div class="sheet-field-label">CMP</div>
            <div class="sheet-field-value" style="color:${pnlColor}">â‚¹${_fmt(cmp)}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Avg Entry</div>
            <div class="sheet-field-value">â‚¹${_fmt(entry)}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Stop Loss</div>
            <div class="sheet-field-value" style="color:#ef4444">â‚¹${_fmt(stop)}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Open Qty</div>
            <div class="sheet-field-value">${openQty || 'â€”'}</div></div>
        </div>
      </div>
      <div class="sheet-section">
        <div class="sheet-section-title">Performance</div>
        <div class="sheet-grid">
          <div class="sheet-field"><div class="sheet-field-label">Unrealised P&L</div>
            <div class="sheet-field-value" style="color:${pnlColor}">${pnl >= 0 ? '+' : ''}â‚¹${_fmt(Math.abs(pnl))}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">R Multiple</div>
            <div class="sheet-field-value" style="color:${pnlColor}">${rMult !== 'â€”' ? (parseFloat(rMult) >= 0 ? '+' : '') + rMult + 'R' : 'â€”'}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Entry Date</div>
            <div class="sheet-field-value" style="font-size:13px">${trade.entries?.[0]?.date || 'â€”'}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Sector</div>
            <div class="sheet-field-value" style="font-size:13px">${trade.sector || 'â€”'}</div></div>
        </div>
      </div>
      ${activeAlert ? `
      <div class="sheet-section">
        <div class="sheet-section-title">Alert â€” ${_shortLabel(activeAlert.type)}</div>
        <div class="sheet-alert-box ${activeAlert.type.includes('Stop') ? 'alert-stop' : ''}">${activeAlert.message || ''}</div>
      </div>` : ''}
      ${trade.activeGTT && (trade.activeGTT.tranche?.price > 0 || trade.activeGTT.core?.price > 0) ? `
      <div class="sheet-section">
        <div class="sheet-section-title">Active GTT Levels</div>
        <div class="sheet-grid">
          ${trade.activeGTT.tranche?.price > 0 ? `<div class="sheet-field"><div class="sheet-field-label">Tranche GTT</div><div class="sheet-field-value">â‚¹${_fmt(trade.activeGTT.tranche.price)} Ã— ${trade.activeGTT.tranche.qty}</div></div>` : ''}
          ${trade.activeGTT.core?.price > 0 ? `<div class="sheet-field"><div class="sheet-field-label">Core GTT</div><div class="sheet-field-value">â‚¹${_fmt(trade.activeGTT.core.price)} Ã— ${trade.activeGTT.core.qty}</div></div>` : ''}
        </div>
      </div>` : ''}`;
  }

  // â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _fmt(n) {
    const num = parseFloat(n);
    if (!num && num !== 0) return 'â€”';
    if (calc?.formatNumber) return calc.formatNumber(num);
    return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _shortLabel(type) {
    if (!type) return 'Alert';
    if (type.includes('Stop'))     return 'Stop Breached';
    if (type.includes('12'))       return '12Ã—ATR Exit';
    if (type.includes('8Ã—'))       return '8Ã—ATR Exit';
    if (type.includes('4Ã—'))       return '4Ã—ATR Exit';
    if (type.includes('1R'))       return '1R Checkpoint';
    if (type.includes('Runner'))   return 'Runner Mode';
    if (type.includes('Weakness')) return 'Exit Signal';
    if (type.includes('Soft'))     return 'Soft Breach';
    if (type.includes('Day'))      return 'Day-6 Stop';
    return type.substring(0, 20);
  }

  function _fallback(trade) {
    const ins = [...(trade.entries || []), ...(trade.pyramids || [])];
    let tq = 0, tc = 0;
    ins.forEach(e => { tq += Number(e.qty) || 0; tc += (Number(e.price) || 0) * (Number(e.qty) || 0); });
    const outs = (trade.partialExits || []).reduce((s, e) => s + (Number(e.qty) || 0), 0);
    return {
      openQty: Math.max(0, tq - outs),
      avgEntryPrice: tq > 0 ? tc / tq : 0,
      currentStop: trade.currentStop || trade.initialStop || 0
    };
  }

  function _loadingHtml() {
    return `<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:13px">Loadingâ€¦</div>`;
  }

  function _emptyHtml(icon, title, sub) {
    return `<div class="mobile-empty">
      <div class="mobile-empty-icon">${icon}</div>
      <div class="mobile-empty-title">${title}</div>
      <div class="mobile-empty-sub">${sub}</div>
    </div>`;
  }

  return {
    init, switchTab, closeSheet,
    openTradeSheet, openPaperSheet, openWatchlistSheet
  };

})();

// Auto-boot removed to allow app.js to initialize it after authentication.
