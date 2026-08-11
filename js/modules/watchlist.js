/**
 * watchlist.js — Watchlist Module
 * Mirrors the coding style of positions.js exactly.
 */
const WatchlistModule = (() => {
  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    await _renderTable();
    _setupAddBtn();
  }

  function _setupAddBtn() {
    const btn = document.getElementById('btn-add-watchlist');
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => _showAddModal());
  }

  // ── CMP Fetch Helper (Supabase Edge Function proxy) ─────────────────────
  const _SB_URL = 'https://zopskuwqlbteyiypwnid.supabase.co';
  const _SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvcHNrdXdxbGJ0ZXlpeXB3bmlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMTI3NTksImV4cCI6MjA5OTY4ODc1OX0.gG0TU9Uf3ODJOqUu4SqZs-Uk1CKlUb47DrfULVg6vHY';

  async function _fetchCmp(symbol) {
    try {
      const ticker = symbol.includes('.') ? encodeURIComponent(symbol) : `${encodeURIComponent(symbol)}.NS`;
      const resp = await fetch(`${_SB_URL}/functions/v1/yahoo-finance?ticker=${ticker}`,
        { headers: { 'Authorization': `Bearer ${_SB_KEY}` } });
      const data = await resp.json();
      return data?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
    } catch { return null; }
  }

  // ── Render Table ──────────────────────────────────────────────────────────
  async function _renderTable() {
    const tbody = document.getElementById('watchlist-tbody');
    if (!tbody) return;

    const watchlist    = await db.getWatchlist();
    const settings     = await db.getSettings();
    const riskPct      = settings?.riskPerTrade || 1.0;
    const capList      = await db.getCapital();
    const closedTrades = await db.getClosedTrades();
    const realPnl      = calc.getTotalPnl(closedTrades);
    const totalCap     = capList.reduce((s, c) => s + (c.amount || 0), 0) || 100000;
    const equity       = calc.getCurrentEquity(capList, realPnl) || totalCap;
    const rpt          = equity * (riskPct / 100);

    if (!watchlist || !watchlist.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px 0;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:8px">&#128065;</div>
        <div style="font-weight:600;margin-bottom:4px">No stocks in Watchlist</div>
        <div style="font-size:12px">Click <strong>+ Add to Watchlist</strong> to track your next setup.</div>
      </td></tr>`;
      return;
    }

    // Render immediately with loading spinners for CMP
    tbody.innerHTML = watchlist.map(item => {
      const trigger      = Number(item.trigger_price) || 0;
      const sl           = Number(item.stop_loss)     || 0;
      const riskPerShare = Math.abs(trigger - sl);
      const totalQty     = riskPerShare > 0 ? Math.floor(rpt / riskPerShare) : 0;
      const initialQty   = Math.floor(totalQty / 2);

      let statusCell, actionsCell;

      if (item.status === 'executed') {
        statusCell  = `<span class="badge" style="background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.4);padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600">&#10003; Executed</span>`;
        actionsCell = `<button class="btn btn-secondary btn-sm" onclick="WatchlistModule._deleteItem('${item.id}')" title="Remove">&#128465;</button>`;
      } else if (item.status === 'triggered') {
        statusCell  = `<span class="badge" style="background:rgba(245,158,11,0.18);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600">&#9889; Triggered</span>`;
        actionsCell = `
          <button class="btn btn-primary btn-sm" onclick="WatchlistModule._showExecuteModal('${item.id}')" title="Execute as real trade" style="margin-right:4px">&#9654; Execute</button>
          <button class="btn btn-secondary btn-sm" onclick="WatchlistModule._createPaperTrade('${item.id}')" title="Simulate as paper trade" style="margin-right:4px">&#128196; Paper</button>
          <button class="btn btn-secondary btn-sm" onclick="WatchlistModule._deleteItem('${item.id}')" title="Remove">&#128465;</button>`;
      } else {
        statusCell  = `<span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.35);padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600">&#128065; Monitoring</span>`;
        actionsCell = `<button class="btn btn-secondary btn-sm" onclick="WatchlistModule._deleteItem('${item.id}')" title="Remove">&#128465;</button>`;
      }

      return `<tr>
        <td><strong>${item.symbol}</strong>${item.sector ? ` <span class="badge badge-muted" style="font-size:10px">${item.sector}</span>` : ''}</td>
        <td class="font-mono">&#8377;${calc.formatNumber(trigger)}</td>
        <td id="wl-cmp-${item.id}" class="font-mono" style="color:var(--text-muted);font-size:12px">&#8230;</td>
        <td class="font-mono">&#8377;${calc.formatNumber(sl)}</td>
        <td class="font-mono">&#8377;${calc.formatNumber(riskPerShare)}</td>
        <td class="font-mono">${initialQty} <span style="font-size:11px;color:var(--text-muted)">(50% of ${totalQty})</span></td>
        <td>${statusCell}</td>
        <td style="text-align:right;white-space:nowrap">${actionsCell}</td>
      </tr>`;
    }).join('');

    // Fetch CMPs in parallel and fill them in
    watchlist.forEach(async item => {
      const cell = document.getElementById(`wl-cmp-${item.id}`);
      if (!cell) return;
      const trigger = Number(item.trigger_price) || 0;
      const cmp = await _fetchCmp(item.symbol);
      if (cmp === null) { cell.textContent = '—'; return; }
      const above   = cmp >= trigger;
      const pctDiff = trigger > 0 ? (((cmp - trigger) / trigger) * 100).toFixed(1) : 0;
      const sign    = pctDiff >= 0 ? '+' : '';
      const color   = above ? '#f59e0b' : '#10b981'; // amber if at/above trigger, green if below (safe)
      cell.innerHTML = `<span style="color:${color};font-weight:600">&#8377;${calc.formatNumber(cmp)}</span>
        <span style="font-size:10px;color:${color};opacity:0.8">&nbsp;${sign}${pctDiff}%</span>`;
    });
  }

  // ── Add to Watchlist Modal ────────────────────────────────────────────────
  async function _showAddModal() {
    const settings     = await db.getSettings();
    const capList      = await db.getCapital();
    const closedTrades = await db.getClosedTrades();
    const realPnl      = calc.getTotalPnl(closedTrades);
    const totalCap     = capList.reduce((s, c) => s + (c.amount || 0), 0) || 100000;
    const equity       = calc.getCurrentEquity(capList, realPnl) || totalCap;
    const riskPct      = settings?.riskPerTrade || 1.0;
    const defRPT       = (equity * riskPct / 100).toFixed(0);

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Symbol *</label>
        <input class="form-input" id="wl-symbol" placeholder="E.G. RELIANCE" style="text-transform:uppercase"
          oninput="this.value=this.value.toUpperCase();WatchlistModule._calcQty()"></div>
      <div class="form-group"><label class="form-label">Sector</label>
        <select class="form-select" id="wl-sector">
          <option>Banking</option><option>IT</option><option>Energy</option><option>Pharma</option>
          <option>FMCG</option><option>Auto</option><option>Telecom</option><option>Chemicals</option>
          <option>NBFC</option><option>Consumer</option><option>Cement</option><option>Other</option>
        </select></div>
      <div class="form-group"><label class="form-label">Trigger Buy Price (&#8377;) *</label>
        <input class="form-input" type="number" id="wl-trigger" step="0.05" placeholder="e.g. 1500"
          oninput="WatchlistModule._calcQty()"></div>
      <div class="form-group"><label class="form-label">Pre-defined Stop Loss (&#8377;) *</label>
        <input class="form-input" type="number" id="wl-stop" step="0.05" placeholder="e.g. 1380"
          oninput="WatchlistModule._calcQty()"></div>
      <div class="form-group"><label class="form-label">Risk/Share <span id="wl-rps-lbl" style="color:var(--text-muted);font-weight:400">&#8212; auto</span></label>
        <input class="form-input" id="wl-rps" disabled placeholder="Auto-calculated" style="opacity:0.7"></div>
      <div class="form-group"><label class="form-label">Initial Qty (50%) <span style="color:var(--text-muted);font-weight:400">RPT = &#8377;${Number(defRPT).toLocaleString('en-IN')}</span></label>
        <input class="form-input" id="wl-qty" disabled placeholder="Auto-calculated" style="opacity:0.7"></div>
      <div class="form-group form-full"><label class="form-label">Notes (Setup / Thesis)</label>
        <input class="form-input" id="wl-notes" placeholder="Pattern, catalyst, confluence..."></div>
    </div>`;

    app.openModal('Add to Watchlist', content, [
      { id: 'cancel', label: 'Cancel',            class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save',   label: 'Save to Watchlist', class: 'btn-primary',   onClick: async () => {
          const symbol  = (document.getElementById('wl-symbol')?.value || '').trim().toUpperCase();
          const trigger = parseFloat(document.getElementById('wl-trigger')?.value);
          const stop    = parseFloat(document.getElementById('wl-stop')?.value);
          const sector  = document.getElementById('wl-sector')?.value;
          const notes   = document.getElementById('wl-notes')?.value;
          if (!symbol)                  { app.toast('Symbol is required', 'error'); return; }
          if (!trigger || trigger <= 0) { app.toast('Trigger Buy Price is required', 'error'); return; }
          if (!stop    || stop    <= 0) { app.toast('Stop Loss is required', 'error'); return; }
          if (stop >= trigger)          { app.toast('Stop Loss must be below Trigger price', 'error'); return; }
          await db.saveWatchlistItem({ symbol, sector, trigger_price: trigger, stop_loss: stop, notes, status: 'monitoring' });
          app.closeModal();
          app.toast(`${symbol} added to Watchlist`, 'success');
          await _renderTable();
      }}
    ]);
  }

  // ── Execute Real Trade (pre-fills the New Trade modal) ────────────────────
  async function _showExecuteModal(itemId) {
    const watchlist = await db.getWatchlist();
    const item = watchlist.find(w => w.id === itemId);
    if (!item) return;

    const playbooks = (await db.getPlaybooks()).filter(p => p.status === 'Active');
    const today     = new Date().toISOString().split('T')[0];
    const settings  = await db.getSettings();
    const capList   = await db.getCapital();
    const closedT   = await db.getClosedTrades();
    const realPnl   = calc.getTotalPnl(closedT);
    const equity    = calc.getCurrentEquity(capList, realPnl);
    const defRPT    = calc.getCurrentR(equity, settings);

    const trigger      = Number(item.trigger_price) || 0;
    const sl           = Number(item.stop_loss)     || 0;
    const riskPerShare = Math.abs(trigger - sl);
    const totalQty     = riskPerShare > 0 ? Math.floor(defRPT / riskPerShare) : 0;
    const initialQty   = Math.floor(totalQty / 2);

    // Mirror _showNewTradeModal but with pre-filled values from watchlist item
    const sectorOptions = ['Banking','IT','Energy','Pharma','FMCG','Auto','Telecom','Chemicals','NBFC','Consumer','Cement','Other']
      .map(s => `<option${s === item.sector ? ' selected' : ''}>${s}</option>`).join('');

    const content = `
      <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#fbbf24">
        &#9889; <strong>Watchlist Triggered:</strong> ${item.symbol} — Pre-filled from your watchlist setup. Review and confirm.
      </div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label">Symbol *</label>
          <input class="form-input" id="nt-symbol" value="${item.symbol}" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()"></div>
        <div class="form-group"><label class="form-label">Sector</label>
          <select class="form-select" id="nt-sector">${sectorOptions}</select></div>
        <div class="form-group"><label class="form-label">Trade Type</label>
          <select class="form-select" id="nt-type" onchange="positionsModule._autoCalcTrade('type')">
            <option>Equity</option><option>Intraday</option><option>Futures</option></select></div>
        <div class="form-group"><label class="form-label">Direction</label>
          <select class="form-select" id="nt-direction"><option>Long</option><option>Short</option></select></div>
        <div class="form-group"><label class="form-label">Exchange</label>
          <select class="form-select" id="nt-exchange"><option value="NSE" selected>NSE</option><option value="BSE">BSE</option></select></div>
        <div class="form-group"><label class="form-label">Playbook</label>
          <select class="form-select" id="nt-playbook">
            <option value="">&#8212; None &#8212;</option>
            ${playbooks.map(p => `<option value="${p.id}">${p.name} (v${p.currentVersion})</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Entry Date *</label>
          <input class="form-input" type="date" id="nt-date" value="${today}"></div>
        <div class="form-group"><label class="form-label">Entry Price (&#8377;) *</label>
          <input class="form-input" type="number" id="nt-price" step="0.05" value="${trigger}" oninput="positionsModule._autoCalcTrade('price')"></div>
        <div class="form-group"><label class="form-label">Initial Stop Loss (&#8377;) *</label>
          <input class="form-input" type="number" id="nt-stop" step="0.05" value="${sl}" oninput="positionsModule._autoCalcTrade('stop')"></div>
        <div class="form-group"><label class="form-label">Qty *</label>
          <input class="form-input" type="number" id="nt-qty" min="1" value="${initialQty}" oninput="positionsModule._autoCalcTrade('qty')"></div>
        <div class="form-group"><label class="form-label">RPT (&#8377;) <span style="color:var(--text-muted);font-weight:400">(auto / default: ${calc.formatCurrency(defRPT)})</span></label>
          <input class="form-input" type="number" id="nt-rpt" placeholder="${defRPT.toFixed(0)}" oninput="positionsModule._autoCalcTrade('rpt')"></div>
        <div class="form-group"><label class="form-label">Charges (&#8377;)</label>
          <input class="form-input" type="number" id="nt-charges" value="0"></div>
        <div class="form-group"><label class="form-label">CMP <span style="font-size:11px;color:var(--text-muted);font-weight:400">&#8212; auto-fetched on save</span></label>
          <input class="form-input" type="number" id="nt-cmp" step="0.05" placeholder="${trigger}"></div>
      </div>`;

    // Reuse positions module's save logic by caching settings
    positionsModule._cachedSettings  = settings;
    positionsModule._cachedDefRPT    = defRPT;

    app.openModal(`Execute Trade &#8212; ${item.symbol}`, content, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save',   label: '&#9654; Confirm Trade', class: 'btn-primary', onClick: async () => {
          const sym     = document.getElementById('nt-symbol').value.trim().toUpperCase();
          const sector  = document.getElementById('nt-sector').value;
          const ttType  = document.getElementById('nt-type').value;
          const dir     = document.getElementById('nt-direction').value;
          const exch    = document.getElementById('nt-exchange').value;
          const pbId    = document.getElementById('nt-playbook').value;
          const date    = document.getElementById('nt-date').value;
          const price   = parseFloat(document.getElementById('nt-price').value);
          const qty     = parseInt(document.getElementById('nt-qty').value);
          const stop    = parseFloat(document.getElementById('nt-stop').value);
          const rpt     = parseFloat(document.getElementById('nt-rpt').value) || Math.abs((price - stop) * qty) || defRPT;
          const charges = parseFloat(document.getElementById('nt-charges').value) || 0;
          const cmp     = parseFloat(document.getElementById('nt-cmp').value) || price;

          if (!sym || !date || !price || !qty || !stop) { app.toast('Please fill all required (*) fields', 'error'); return; }

          const pb = pbId ? await db.getPlaybookById(pbId) : null;
          const trade = {
            id: db.generateId('tr'), symbol: sym, sector, tradeType: ttType, direction: dir, exchange: exch,
            playbookId: pbId, playbookVersion: pbId ? pb?.currentVersion || '1.0' : '',
            initialStop: stop, currentStop: stop, rpt,
            entryATR: null, swingLow: null,
            entries:      [{ id: db.generateId('en'), date, price, qty, charges, notes: `From Watchlist: ${item.symbol}` }],
            pyramids: [], stopRevisions: [{ id: db.generateId('sr'), date, oldStop: 0, newStop: stop, actionSource: 'Manual', notes: 'Initial stop from Watchlist trigger' }],
            partialExits: [], finalExit: null, notes: [], alerts: [],
            ruleFollowed: true, reviewStatus: 'Pending', rating: 0,
            chartLink: `https://www.tradingview.com/chart/?symbol=${exch}:${sym}`, tags: [sector],
            cmp, createdAt: date, closedAt: null
          };
          await db.saveTrade(trade);
          // Mark watchlist item as executed
          await db.saveWatchlistItem({ ...item, status: 'executed' });
          app.closeModal();
          app.toast(`Trade executed: ${sym}`, 'success');
          await _renderTable();
      }}
    ]);
  }

  // ── Create Paper Trade (no modal — instant simulation record) ────────────
  async function _createPaperTrade(itemId) {
    const watchlist = await db.getWatchlist();
    const item = watchlist.find(w => w.id === itemId);
    if (!item) return;

    const settings     = await db.getSettings();
    const capList      = await db.getCapital();
    const closedT      = await db.getClosedTrades();
    const realPnl      = calc.getTotalPnl(closedT);
    const equity       = calc.getCurrentEquity(capList, realPnl);
    const defRPT       = calc.getCurrentR(equity, settings);
    const trigger      = Number(item.trigger_price) || 0;
    const sl           = Number(item.stop_loss)     || 0;
    const riskPerShare = Math.abs(trigger - sl);
    const totalQty     = riskPerShare > 0 ? Math.floor(defRPT / riskPerShare) : 0;
    const initialQty   = Math.floor(totalQty / 2);
    const today        = new Date().toISOString().split('T')[0];

    if (initialQty <= 0) { app.toast('Cannot compute position size — check RPT and price levels', 'error'); return; }

    const paperTrade = {
      id: db.generateId('pt'), symbol: item.symbol, sector: item.sector || 'Other',
      tradeType: 'Equity', direction: 'Long', exchange: 'NSE',
      playbookId: '', playbookVersion: '',
      initialStop: sl, currentStop: sl, rpt: defRPT,
      entryATR: null, swingLow: null,
      entries:      [{ id: db.generateId('en'), date: today, price: trigger, qty: initialQty, charges: 0, notes: `Paper trade from Watchlist: ${item.symbol}` }],
      pyramids: [], stopRevisions: [{ id: db.generateId('sr'), date: today, oldStop: 0, newStop: sl, actionSource: 'Auto', notes: 'Auto-created from Watchlist trigger' }],
      partialExits: [], finalExit: null, notes: [], alerts: [],
      ruleFollowed: true, reviewStatus: 'Paper', rating: 0,
      chartLink: `https://www.tradingview.com/chart/?symbol=NSE:${item.symbol}`, tags: [item.sector || 'Other'],
      cmp: trigger, createdAt: today, closedAt: null
    };

    await db.savePaperTrade(paperTrade);
    // Mark watchlist item as executed
    await db.saveWatchlistItem({ ...item, status: 'executed' });
    app.toast(`&#128196; Paper trade created for ${item.symbol} — simulation running`, 'success');
    await _renderTable();
  }

  // ── Live Qty Calculator ───────────────────────────────────────────────────
  async function _calcQty() {
    const trigger = parseFloat(document.getElementById('wl-trigger')?.value) || 0;
    const stop    = parseFloat(document.getElementById('wl-stop')?.value)    || 0;
    if (!trigger || !stop || stop >= trigger) return;

    const rps          = trigger - stop;
    const settings     = await db.getSettings();
    const capList      = await db.getCapital();
    const closedTrades = await db.getClosedTrades();
    const realPnl      = calc.getTotalPnl(closedTrades);
    const totalCap     = capList.reduce((s, c) => s + (c.amount || 0), 0) || 100000;
    const equity       = calc.getCurrentEquity(capList, realPnl) || totalCap;
    const riskPct      = settings?.riskPerTrade || 1.0;
    const rpt          = equity * riskPct / 100;
    const totalQty     = Math.floor(rpt / rps);
    const initQty      = Math.floor(totalQty / 2);

    const rpsEl = document.getElementById('wl-rps');
    const qtyEl = document.getElementById('wl-qty');
    const lbl   = document.getElementById('wl-rps-lbl');
    if (rpsEl) rpsEl.value = '\u20b9' + rps.toFixed(2);
    if (qtyEl) qtyEl.value = initQty + ' shares  (full: ' + totalQty + ')';
    if (lbl)   lbl.textContent = '= \u20b9' + rps.toFixed(2);
  }

  // ── Delete Item ───────────────────────────────────────────────────────────
  async function _deleteItem(id) {
    if (!confirm('Remove this stock from your Watchlist?')) return;
    await db.deleteWatchlistItem(id);
    app.toast('Removed from Watchlist', 'success');
    await _renderTable();
  }

  return { init, _renderTable, _showAddModal, _showExecuteModal, _createPaperTrade, _calcQty, _deleteItem };
})();

window.WatchlistModule = WatchlistModule;
