/**
 * mobile.js — TradeJournal Mobile Module v1.0
 * Activated only on screens <= 767px.
 * Renders card-based UI for Positions, Watchlist, Paper Trades, Dashboard.
 * All data comes from the same db.* calls as the desktop.
 */
const MobileModule = (() => {

  const IS_MOBILE = () => window.innerWidth <= 767;
  let _currentTab = 'positions';
  let _sheetTradeId = null;

  // ── Bootstrap ───────────────────────────────────────────────────────────
  async function init() {
    if (!IS_MOBILE()) return;
    _injectBottomNav();
    _injectBottomSheet();
    _registerServiceWorker();
    await switchTab('positions');
  }

  // ── Register PWA Service Worker ──────────────────────────────────────────
  function _registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW reg failed:', e));
    }
  }

  // ── Bottom Navigation ────────────────────────────────────────────────────
  function _injectBottomNav() {
    const nav = document.getElementById('mobile-bottom-nav');
    if (!nav) return;
    nav.innerHTML = `
      <button class="mobile-nav-tab active" id="mnav-positions" onclick="MobileModule.switchTab('positions')">
        <span class="mobile-nav-icon">📈</span>
        <span class="mobile-nav-label">Positions</span>
      </button>
      <button class="mobile-nav-tab" id="mnav-watchlist" onclick="MobileModule.switchTab('watchlist')">
        <span class="mobile-nav-icon">👁</span>
        <span class="mobile-nav-label">Watchlist</span>
      </button>
      <button class="mobile-nav-tab" id="mnav-paper" onclick="MobileModule.switchTab('paper')">
        <span class="mobile-nav-icon">📄</span>
        <span class="mobile-nav-label">Paper</span>
      </button>
      <button class="mobile-nav-tab" id="mnav-dashboard" onclick="MobileModule.switchTab('dashboard')">
        <span class="mobile-nav-icon">📊</span>
        <span class="mobile-nav-label">Summary</span>
        <span class="mobile-nav-badge" id="mobile-alert-badge" style="display:none">0</span>
      </button>`;
  }

  // ── Bottom Sheet ─────────────────────────────────────────────────────────
  function _injectBottomSheet() {
    if (document.getElementById('mobile-bottom-sheet')) return;
    const sheet = document.createElement('div');
    sheet.id = 'mobile-bottom-sheet';
    sheet.innerHTML = `<div class="sheet-handle"></div><div id="mobile-sheet-content"></div>`;
    document.body.appendChild(sheet);

    const backdrop = document.createElement('div');
    backdrop.id = 'mobile-sheet-backdrop';
    backdrop.onclick = closeSheet;
    document.body.appendChild(backdrop);
  }

  function openSheet(html) {
    const sheet = document.getElementById('mobile-bottom-sheet');
    const backdrop = document.getElementById('mobile-sheet-backdrop');
    document.getElementById('mobile-sheet-content').innerHTML = html;
    sheet?.classList.add('sheet-open');
    backdrop?.classList.add('active');
  }

  function closeSheet() {
    document.getElementById('mobile-bottom-sheet')?.classList.remove('sheet-open');
    document.getElementById('mobile-sheet-backdrop')?.classList.remove('active');
    _sheetTradeId = null;
  }

  // ── Tab Switcher ─────────────────────────────────────────────────────────
  async function switchTab(tab) {
    if (!IS_MOBILE()) { app.navigate(tab === 'paper' ? 'paper-trades' : tab); return; }
    _currentTab = tab;

    // Update bottom nav active state
    ['positions','watchlist','paper','dashboard'].forEach(t => {
      document.getElementById(`mnav-${t}`)?.classList.toggle('active', t === tab);
    });

    // Hide all module pages, show only the active one's container
    document.querySelectorAll('.module-page').forEach(p => p.classList.add('hidden'));

    const pageMap = { positions: 'mod-positions', watchlist: 'mod-watchlist', paper: 'mod-paper-trades', dashboard: 'mod-dashboard' };
    const pageId = pageMap[tab];
    if (pageId) document.getElementById(pageId)?.classList.remove('hidden');

    closeSheet();

    switch(tab) {
      case 'positions':  await renderPositions();  break;
      case 'watchlist':  await renderWatchlist();   break;
      case 'paper':      await renderPaperTrades(); break;
      case 'dashboard':  await renderDashboard();   break;
    }
  }

  // ── Alert Badge Update ───────────────────────────────────────────────────
  async function _updateAlertBadge() {
    try {
      const trades = await db.getOpenTrades();
      let count = 0;
      trades.forEach(t => {
        const active = (t.alerts || []).filter(a => a.status === 'Triggered').length;
        count += active;
      });
      const badge = document.getElementById('mobile-alert-badge');
      if (!badge) return;
      badge.style.display = count > 0 ? 'flex' : 'none';
      badge.textContent = count > 9 ? '9+' : String(count);
    } catch(e) {}
  }

  // ── Positions Cards ──────────────────────────────────────────────────────
  async function renderPositions() {
    const container = _getOrCreateCardContainer('pos-table-panel', 'mobile-pos-cards');
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Loading…</div>';

    const trades = await db.getOpenTrades();
    await _updateAlertBadge();

    if (!trades.length) {
      container.innerHTML = `<div class="mobile-empty">
        <div class="mobile-empty-icon">📈</div>
        <div class="mobile-empty-title">No open positions</div>
        <div class="mobile-empty-sub">Open the desktop app to add trades</div>
      </div>`; return;
    }

    container.innerHTML = trades.map(trade => _tradeCard(trade)).join('');
  }

  function _tradeCard(trade) {
    const m = calc?.getTradeMetrics ? calc.getTradeMetrics(trade) : _fallback(trade);
    const entry     = m.avgEntryPrice || trade.entries?.[0]?.price || 0;
    const stop      = m.currentStop  || trade.initialStop || 0;
    const cmp       = trade.cmp || entry;
    const isLong    = trade.direction !== 'Short';
    const pnl       = m.openQty > 0 ? (isLong ? (cmp - entry) : (entry - cmp)) * m.openQty : 0;
    const risk      = Math.abs(entry - trade.initialStop || 0);
    const rMult     = risk > 0 ? (pnl / (risk * m.openQty)).toFixed(2) : '—';
    const pnlPct    = entry > 0 ? (((cmp - entry) / entry) * 100 * (isLong ? 1 : -1)).toFixed(1) : 0;
    const pnlColor  = pnl > 0 ? '#10b981' : pnl < 0 ? '#ef4444' : 'var(--text-muted)';
    const cardClass = pnl > 0 ? 'card-profit' : pnl < 0 ? 'card-loss' : 'card-neutral';

    // Active alert
    const activeAlert = (trade.alerts || []).find(a => a.status === 'Triggered');
    const alertType   = activeAlert?.type || '';
    const isStop      = alertType.includes('Stop');
    const alertPillClass = activeAlert ? (isStop ? 'alert-stop' : '') : 'alert-ok';
    const alertLabel  = activeAlert ? _shortAlertLabel(alertType) : 'Monitoring';

    return `<div class="mobile-trade-card ${cardClass}" onclick="MobileModule.openTradeSheet('${trade.id}')">
      <div class="mobile-card-top">
        <div>
          <div class="mobile-card-symbol">${trade.symbol} <span style="font-size:11px;font-weight:400;color:var(--text-muted)">${trade.direction || 'Long'}</span></div>
          <div class="mobile-card-sector">${trade.sector || '—'} · ${trade.entries?.[0]?.date || ''}</div>
        </div>
        <div class="mobile-card-status">
          <span class="badge ${pnl >= 0 ? 'badge-success' : 'badge-danger'}" style="font-size:11px">${pnl >= 0 ? '+' : ''}₹${_fmt(Math.abs(pnl))}</span>
          <span style="font-size:11px;color:${pnlColor}">${rMult !== '—' ? (pnl >= 0 ? '+' : '') + rMult + 'R' : ''}</span>
        </div>
      </div>
      <div class="mobile-card-mid">
        <div class="mobile-card-field">
          <div class="mobile-card-label">CMP</div>
          <div class="mobile-card-value" style="color:${pnlColor}">₹${_fmt(cmp)} <span style="font-size:10px">${pnlPct > 0 ? '+' : ''}${pnlPct}%</span></div>
        </div>
        <div class="mobile-card-field">
          <div class="mobile-card-label">Entry</div>
          <div class="mobile-card-value">₹${_fmt(entry)}</div>
        </div>
        <div class="mobile-card-field">
          <div class="mobile-card-label">Stop</div>
          <div class="mobile-card-value" style="color:#ef4444">₹${_fmt(stop)}</div>
        </div>
        <div class="mobile-card-field">
          <div class="mobile-card-label">Qty</div>
          <div class="mobile-card-value">${m.openQty}</div>
        </div>
      </div>
      <div class="mobile-card-bottom">
        <span class="mobile-alert-pill ${alertPillClass}">⚡ ${alertLabel}</span>
        <span style="font-size:11px;color:var(--text-muted)">→ Details</span>
      </div>
    </div>`;
  }

  // ── Watchlist Cards ──────────────────────────────────────────────────────
  async function renderWatchlist() {
    const container = _getOrCreateCardContainer('watchlist-table-panel', 'mobile-wl-cards');
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Loading…</div>';

    const items = await db.getWatchlist();
    if (!items.length) {
      container.innerHTML = `<div class="mobile-empty">
        <div class="mobile-empty-icon">👁</div>
        <div class="mobile-empty-title">Watchlist is empty</div>
        <div class="mobile-empty-sub">Add setups from the desktop app</div>
      </div>`; return;
    }

    container.innerHTML = items.map(item => {
      const cmp      = item.cmp || 0;
      const trigger  = Number(item.trigger_price) || 0;
      const stop     = Number(item.stop_loss) || 0;
      const pctToTrig = trigger > 0 && cmp > 0 ? (((cmp - trigger) / trigger) * 100).toFixed(1) : null;
      const isTriggered = item.status === 'triggered';
      const cardClass   = isTriggered ? 'card-triggered' : 'card-neutral';
      const trigColor   = isTriggered ? '#f59e0b' : (pctToTrig !== null && parseFloat(pctToTrig) >= 0 ? '#10b981' : '#ef4444');

      return `<div class="mobile-trade-card ${cardClass}" onclick="MobileModule.openWatchlistSheet('${item.id}')">
        <div class="mobile-card-top">
          <div>
            <div class="mobile-card-symbol">${item.symbol}</div>
            <div class="mobile-card-sector">${item.sector || '—'}</div>
          </div>
          <div class="mobile-card-status">
            ${isTriggered
              ? `<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;font-size:11px">⚡ Triggered</span>`
              : `<span class="badge badge-muted" style="font-size:11px">Monitoring</span>`}
          </div>
        </div>
        <div class="mobile-card-mid">
          <div class="mobile-card-field">
            <div class="mobile-card-label">Trigger</div>
            <div class="mobile-card-value">₹${_fmt(trigger)}</div>
          </div>
          <div class="mobile-card-field">
            <div class="mobile-card-label">CMP</div>
            <div class="mobile-card-value" style="color:${trigColor}">${cmp ? '₹' + _fmt(cmp) : '—'}</div>
          </div>
          <div class="mobile-card-field">
            <div class="mobile-card-label">Stop Loss</div>
            <div class="mobile-card-value" style="color:#ef4444">₹${_fmt(stop)}</div>
          </div>
          <div class="mobile-card-field">
            <div class="mobile-card-label">Gap</div>
            <div class="mobile-card-value" style="color:${trigColor}">${pctToTrig !== null ? (parseFloat(pctToTrig) >= 0 ? '+' : '') + pctToTrig + '%' : '—'}</div>
          </div>
        </div>
        ${item.notes ? `<div class="mobile-card-bottom"><span style="font-size:11px;color:var(--text-muted);font-style:italic">"${item.notes.substring(0,60)}${item.notes.length>60?'…':''}"</span></div>` : ''}
      </div>`;
    }).join('');
  }

  // ── Paper Trade Cards (same structure as positions) ──────────────────────
  async function renderPaperTrades() {
    const container = _getOrCreateCardContainer('pt-table-panel', 'mobile-pt-cards');
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Loading…</div>';

    const trades = (await db.getPaperTrades()) || [];
    if (!trades.length) {
      container.innerHTML = `<div class="mobile-empty">
        <div class="mobile-empty-icon">📄</div>
        <div class="mobile-empty-title">No paper trades yet</div>
        <div class="mobile-empty-sub">Use the Watchlist to start a simulation</div>
      </div>`; return;
    }

    container.innerHTML = trades.map(trade => {
      const isOpen = db.getTradeRemainingQty ? db.getTradeRemainingQty(trade) > 0 : true;
      return _tradeCard({ ...trade, _isPaper: true, _isOpen: isOpen });
    }).join('');
  }

  // ── Dashboard Summary ────────────────────────────────────────────────────
  async function renderDashboard() {
    const container = _getOrCreateCardContainer('mod-dashboard', 'mobile-dash-cards');
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Loading…</div>';

    const [trades, allTrades] = await Promise.all([db.getOpenTrades(), db.getTrades ? db.getTrades() : Promise.resolve([])]);
    const closed = (allTrades || []).filter(t => t.finalExit);
    const wins   = closed.filter(t => {
      const e = t.entries?.[0]?.price || 0;
      const x = t.finalExit?.price || 0;
      return t.direction === 'Short' ? x < e : x > e;
    });
    const wr = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;

    // Alert summary
    await _updateAlertBadge();
    const allAlerts = [];
    trades.forEach(t => {
      (t.alerts || []).filter(a => a.status === 'Triggered').forEach(a => {
        allAlerts.push({ symbol: t.symbol, type: a.type, message: a.message });
      });
    });

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
        <div class="stat-card" style="text-align:center">
          <div class="stat-label">Open</div>
          <div class="stat-value">${trades.length}</div>
        </div>
        <div class="stat-card" style="text-align:center">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value" style="color:${Number(wr)>=50?'#10b981':'#ef4444'}">${wr}%</div>
        </div>
        <div class="stat-card" style="text-align:center">
          <div class="stat-label">Alerts</div>
          <div class="stat-value" style="color:${allAlerts.length>0?'#f59e0b':'#10b981'}">${allAlerts.length}</div>
        </div>
      </div>
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);margin-bottom:10px">Active Alerts</div>
      ${allAlerts.length === 0
        ? `<div style="text-align:center;padding:24px;color:var(--text-muted)">✅ No active alerts</div>`
        : allAlerts.map(a => `
          <div style="background:var(--surface);border:1px solid rgba(245,158,11,0.25);border-radius:12px;padding:12px 14px;margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <strong style="font-size:14px">${a.symbol}</strong>
              <span class="mobile-alert-pill ${a.type.includes('Stop') ? 'alert-stop' : ''}">⚡ ${_shortAlertLabel(a.type)}</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);line-height:1.5">${(a.message||'').substring(0,120)}${(a.message||'').length>120?'…':''}</div>
          </div>`).join('')}`;
  }

  // ── Trade Detail Sheet ───────────────────────────────────────────────────
  async function openTradeSheet(id) {
    const trades = await db.getOpenTrades();
    const trade  = trades.find(t => t.id === id);
    if (!trade) return;
    _sheetTradeId = id;

    const m       = calc?.getTradeMetrics ? calc.getTradeMetrics(trade) : _fallback(trade);
    const entry   = m.avgEntryPrice || 0;
    const stop    = m.currentStop   || trade.initialStop || 0;
    const cmp     = trade.cmp || entry;
    const isLong  = trade.direction !== 'Short';
    const pnl     = m.openQty > 0 ? (isLong ? cmp - entry : entry - cmp) * m.openQty : 0;
    const risk    = Math.abs(entry - (trade.initialStop || 0));
    const rMult   = risk > 0 ? ((isLong ? cmp - entry : entry - cmp) / risk).toFixed(2) : '—';
    const pnlColor = pnl >= 0 ? '#10b981' : '#ef4444';

    const activeAlert = (trade.alerts || []).find(a => a.status === 'Triggered');

    openSheet(`
      <div class="sheet-title">
        <div>${trade.symbol} <span style="font-size:13px;color:var(--text-muted)">${trade.direction || 'Long'}</span></div>
        <button class="sheet-close-btn" onclick="MobileModule.closeSheet()">✕</button>
      </div>

      <div class="sheet-section">
        <div class="sheet-section-title">Price Levels</div>
        <div class="sheet-grid">
          <div class="sheet-field">
            <div class="sheet-field-label">CMP</div>
            <div class="sheet-field-value" style="color:${pnlColor}">₹${_fmt(cmp)}</div>
          </div>
          <div class="sheet-field">
            <div class="sheet-field-label">Avg Entry</div>
            <div class="sheet-field-value">₹${_fmt(entry)}</div>
          </div>
          <div class="sheet-field">
            <div class="sheet-field-label">Stop Loss</div>
            <div class="sheet-field-value" style="color:#ef4444">₹${_fmt(stop)}</div>
          </div>
          <div class="sheet-field">
            <div class="sheet-field-label">Open Qty</div>
            <div class="sheet-field-value">${m.openQty}</div>
          </div>
        </div>
      </div>

      <div class="sheet-section">
        <div class="sheet-section-title">Performance</div>
        <div class="sheet-grid">
          <div class="sheet-field">
            <div class="sheet-field-label">Unrealised P&L</div>
            <div class="sheet-field-value" style="color:${pnlColor}">${pnl >= 0 ? '+' : ''}₹${_fmt(Math.abs(pnl))}</div>
          </div>
          <div class="sheet-field">
            <div class="sheet-field-label">R Multiple</div>
            <div class="sheet-field-value" style="color:${pnlColor}">${rMult !== '—' ? (pnl >= 0 ? '+' : '') + rMult + 'R' : '—'}</div>
          </div>
          <div class="sheet-field">
            <div class="sheet-field-label">Entry Date</div>
            <div class="sheet-field-value" style="font-size:13px">${trade.entries?.[0]?.date || '—'}</div>
          </div>
          <div class="sheet-field">
            <div class="sheet-field-label">Sector</div>
            <div class="sheet-field-value" style="font-size:13px">${trade.sector || '—'}</div>
          </div>
        </div>
      </div>

      ${activeAlert ? `
      <div class="sheet-section">
        <div class="sheet-section-title">Active Alert — ${_shortAlertLabel(activeAlert.type)}</div>
        <div class="sheet-alert-box ${activeAlert.type.includes('Stop') ? 'alert-stop' : ''}">${activeAlert.message || ''}</div>
      </div>` : ''}

      ${trade.activeGTT ? `
      <div class="sheet-section">
        <div class="sheet-section-title">GTT Levels</div>
        <div class="sheet-grid">
          ${trade.activeGTT.tranche?.price > 0 ? `<div class="sheet-field"><div class="sheet-field-label">Tranche GTT</div><div class="sheet-field-value">₹${_fmt(trade.activeGTT.tranche.price)}</div></div>` : ''}
          ${trade.activeGTT.core?.price > 0 ? `<div class="sheet-field"><div class="sheet-field-label">Core GTT</div><div class="sheet-field-value">₹${_fmt(trade.activeGTT.core.price)}</div></div>` : ''}
        </div>
      </div>` : ''}
    `);
  }

  async function openWatchlistSheet(id) {
    const items = await db.getWatchlist();
    const item  = items.find(i => i.id === id);
    if (!item) return;

    openSheet(`
      <div class="sheet-title">
        <div>${item.symbol}</div>
        <button class="sheet-close-btn" onclick="MobileModule.closeSheet()">✕</button>
      </div>
      <div class="sheet-section">
        <div class="sheet-grid">
          <div class="sheet-field"><div class="sheet-field-label">Trigger</div><div class="sheet-field-value">₹${_fmt(item.trigger_price)}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Stop Loss</div><div class="sheet-field-value" style="color:#ef4444">₹${_fmt(item.stop_loss)}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Sector</div><div class="sheet-field-value" style="font-size:13px">${item.sector || '—'}</div></div>
          <div class="sheet-field"><div class="sheet-field-label">Status</div><div class="sheet-field-value" style="font-size:13px">${item.status || 'monitoring'}</div></div>
        </div>
      </div>
      ${item.notes ? `<div class="sheet-section"><div class="sheet-section-title">Setup Thesis</div><div class="sheet-alert-box" style="background:var(--surface)">${item.notes}</div></div>` : ''}
    `);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function _getOrCreateCardContainer(parentId, cardId) {
    const parent = document.getElementById(parentId);
    if (!parent) return { innerHTML: '' };
    let container = document.getElementById(cardId);
    if (!container) {
      container = document.createElement('div');
      container.id = cardId;
      container.className = 'mobile-cards';
      parent.appendChild(container);
    }
    return container;
  }

  function _fmt(n) {
    if (!n && n !== 0) return '—';
    return calc?.formatNumber ? calc.formatNumber(Number(n)) : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function _shortAlertLabel(type) {
    if (!type) return 'Alert';
    if (type.includes('Stop'))       return 'Stop Breached';
    if (type.includes('12'))         return '12× ATR';
    if (type.includes('8×'))         return '8× ATR';
    if (type.includes('4×'))         return '4× ATR';
    if (type.includes('1R'))         return '1R Hit';
    if (type.includes('Runner'))     return 'Runner Mode';
    if (type.includes('Weakness'))   return 'Exit Signal';
    if (type.includes('Soft'))       return 'Soft Breach';
    if (type.includes('Day'))        return 'Day-6 Stop';
    return type.substring(0, 18);
  }

  function _fallback(trade) {
    const ins  = [...(trade.entries||[]), ...(trade.pyramids||[])];
    let tq=0, tc=0;
    ins.forEach(e => { tq += e.qty; tc += e.price * e.qty; });
    const outs = (trade.partialExits||[]).reduce((s,e) => s+e.qty, 0);
    return { openQty: tq-outs, avgEntryPrice: tq>0?tc/tq:0, currentStop: trade.currentStop||trade.initialStop };
  }

  return { init, switchTab, openTradeSheet, openWatchlistSheet, closeSheet, renderPositions, renderWatchlist, renderPaperTrades, renderDashboard };

})();

// Auto-init on mobile
if (window.innerWidth <= 767) {
  document.addEventListener('DOMContentLoaded', () => {
    // Wait for auth + db to be ready
    const tryInit = setInterval(() => {
      if (window.db && window.calc && window.auth?.getUser?.()) {
        clearInterval(tryInit);
        MobileModule.init();
      }
    }, 500);
    setTimeout(() => clearInterval(tryInit), 10000);
  });
}
