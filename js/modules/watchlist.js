window.WatchlistModule = (function() {
  const db   = window.db;
  const calc = window.calc;
  let _watchlist = [];

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    const btnAdd = document.getElementById('btn-add-watchlist');
    if (btnAdd) {
      const fresh = btnAdd.cloneNode(true);
      btnAdd.parentNode.replaceChild(fresh, btnAdd);
      fresh.addEventListener('click', _openModal);
    }
    db.on('watchlist_updated', render);
    db.on('settings_updated',  render);
    db.on('capital_updated',   render);
  }

  // ── Render Table ──────────────────────────────────────────────────────────
  async function render() {
    const tbody = document.getElementById('watchlist-tbody');
    if (!tbody) return;

    _watchlist = await db.getWatchlist();
    const settings      = await db.getSettings();
    const riskPct       = settings?.riskPerTrade || 1.0;
    const capList       = await db.getCapital();
    const closedTrades  = await db.getClosedTrades();
    const realPnl       = calc.getTotalPnl(closedTrades);
    const equity        = calc.getCurrentEquity({ capital: capList }, realPnl) || capList.reduce((s,c) => s+(c.amount||0),0) || 100000;
    const totalRiskAmt  = equity * (riskPct / 100);

    if (!_watchlist.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px 0;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:8px">&#128065;</div>
        <div>No stocks in watchlist.</div>
        <div style="font-size:12px;margin-top:4px">Click <strong>+ Add to Watchlist</strong> to track your next setup.</div>
      </td></tr>`;
      return;
    }

    let html = '';
    for (const item of _watchlist) {
      const trigger      = Number(item.trigger_price) || 0;
      const sl           = Number(item.stop_loss)     || 0;
      const riskPerShare = Math.abs(trigger - sl);
      const totalQty     = riskPerShare > 0 ? Math.floor(totalRiskAmt / riskPerShare) : 0;
      const initialQty   = Math.floor(totalQty / 2);

      const statusBadge = item.status === 'triggered'
        ? `<span class="badge" style="background:rgba(245,158,11,0.18);color:#fbbf24;border:1px solid rgba(245,158,11,0.4);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">&#9889; Triggered</span>`
        : `<span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.35);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">&#128065; Monitoring</span>`;

      html += `
        <tr>
          <td><strong>${item.symbol}</strong> <span class="badge badge-muted" style="font-size:10px">${item.sector||''}</span></td>
          <td class="font-mono">&#8377;${calc.formatNumber(trigger)}</td>
          <td class="font-mono">&#8377;${calc.formatNumber(sl)}</td>
          <td class="font-mono">&#8377;${calc.formatNumber(riskPerShare)}</td>
          <td class="font-mono">${initialQty} <span style="font-size:11px;color:var(--text-muted)">(50% of ${totalQty})</span></td>
          <td>${statusBadge}</td>
          <td style="text-align:right">
            <button class="btn btn-secondary btn-sm" onclick="WatchlistModule.deleteItem('${item.id}')" title="Remove">&#128465;</button>
          </td>
        </tr>
      `;
    }
    tbody.innerHTML = html;
  }

  // ── Add to Watchlist Modal ────────────────────────────────────────────────
  async function _openModal() {
    const settings     = await db.getSettings();
    const capList      = await db.getCapital();
    const closedTrades = await db.getClosedTrades();
    const realPnl      = calc.getTotalPnl(closedTrades);
    const equity       = calc.getCurrentEquity({ capital: capList }, realPnl) || capList.reduce((s,c) => s+(c.amount||0),0) || 100000;
    const riskPct      = settings?.riskPerTrade || 1.0;
    const rpt          = (equity * riskPct / 100).toFixed(0);

    const content = `<div class="form-grid">
      <div class="form-group">
        <label class="form-label">Symbol *</label>
        <input class="form-input" id="wl-symbol" placeholder="E.G. RELIANCE" style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase();WatchlistModule._calcQty()">
      </div>
      <div class="form-group">
        <label class="form-label">Sector</label>
        <select class="form-select" id="wl-sector">
          <option>Banking</option><option>IT</option><option>Energy</option><option>Pharma</option>
          <option>FMCG</option><option>Auto</option><option>Telecom</option><option>Chemicals</option>
          <option>NBFC</option><option>Consumer</option><option>Cement</option><option>Other</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Trigger Buy Price (&#8377;) *</label>
        <input class="form-input" type="number" id="wl-trigger" step="0.05" placeholder="e.g. 1500" oninput="WatchlistModule._calcQty()">
      </div>
      <div class="form-group">
        <label class="form-label">Pre-defined Stop Loss (&#8377;) *</label>
        <input class="form-input" type="number" id="wl-stop" step="0.05" placeholder="e.g. 1380" oninput="WatchlistModule._calcQty()">
      </div>
      <div class="form-group">
        <label class="form-label">Risk/Share <span id="wl-rps-label" style="color:var(--text-muted);font-weight:400">&#8212; auto</span></label>
        <input class="form-input" id="wl-rps" disabled placeholder="Auto-calculated" style="opacity:0.7">
      </div>
      <div class="form-group">
        <label class="form-label">Initial Qty (50%) <span style="color:var(--text-muted);font-weight:400">RPT = &#8377;${Number(rpt).toLocaleString('en-IN')}</span></label>
        <input class="form-input" id="wl-qty" disabled placeholder="Auto-calculated" style="opacity:0.7">
      </div>
      <div class="form-group form-full">
        <label class="form-label">Notes (Setup / Thesis)</label>
        <input class="form-input" id="wl-notes" placeholder="Pattern, catalyst, confluence...">
      </div>
    </div>`;

    app.openModal('Add to Watchlist', content, [
      { id: 'cancel', label: 'Cancel',            class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save',   label: 'Save to Watchlist', class: 'btn-primary',   onClick: async () => {
          const symbol  = document.getElementById('wl-symbol').value.trim().toUpperCase();
          const trigger = parseFloat(document.getElementById('wl-trigger').value);
          const stop    = parseFloat(document.getElementById('wl-stop').value);
          const sector  = document.getElementById('wl-sector').value;
          const notes   = document.getElementById('wl-notes').value;

          if (!symbol)              { app.toast('Symbol is required', 'error'); return; }
          if (!trigger || trigger <= 0) { app.toast('Trigger Buy Price is required', 'error'); return; }
          if (!stop    || stop    <= 0) { app.toast('Stop Loss is required', 'error'); return; }
          if (stop >= trigger)          { app.toast('Stop Loss must be below Trigger Buy Price', 'error'); return; }

          await db.saveWatchlistItem({ symbol, sector, trigger_price: trigger, stop_loss: stop, notes, status: 'monitoring' });
          app.closeModal();
          app.toast(`${symbol} added to Watchlist`, 'success');
      }}
    ]);
  }

  // ── Live Qty Calculator ───────────────────────────────────────────────────
  async function _calcQty() {
    const trigger = parseFloat(document.getElementById('wl-trigger')?.value) || 0;
    const stop    = parseFloat(document.getElementById('wl-stop')?.value)    || 0;
    const rpsEl   = document.getElementById('wl-rps');
    const qtyEl   = document.getElementById('wl-qty');
    if (!rpsEl || !qtyEl) return;

    if (trigger > 0 && stop > 0 && stop < trigger) {
      const rps          = trigger - stop;
      const settings     = await db.getSettings();
      const capList      = await db.getCapital();
      const closedTrades = await db.getClosedTrades();
      const realPnl      = calc.getTotalPnl(closedTrades);
      const equity       = calc.getCurrentEquity({ capital: capList }, realPnl) || capList.reduce((s,c)=>s+(c.amount||0),0) || 100000;
      const riskPct      = settings?.riskPerTrade || 1.0;
      const rpt          = equity * riskPct / 100;
      const totalQty     = Math.floor(rpt / rps);
      const initQty      = Math.floor(totalQty / 2);

      rpsEl.value = '\u20b9' + rps.toFixed(2);
      qtyEl.value = initQty + ' shares  (full: ' + totalQty + ')';
      const lbl = document.getElementById('wl-rps-label');
      if (lbl) lbl.textContent = '= \u20b9' + rps.toFixed(2);
    } else {
      rpsEl.value = '';
      qtyEl.value = '';
    }
  }

  async function deleteItem(id) {
    if (confirm('Remove this stock from your watchlist?')) {
      await db.deleteWatchlistItem(id);
      app.toast('Removed from Watchlist', 'success');
    }
  }

  return { init, render, deleteItem, _calcQty };
})();
