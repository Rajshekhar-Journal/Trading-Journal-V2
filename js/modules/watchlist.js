window.WatchlistModule = (function() {
  const db = window.db;
  const calc = window.calc;
  let _watchlist = [];

  function init() {
    const btnAdd = document.getElementById('btn-add-watchlist');
    if (btnAdd) btnAdd.addEventListener('click', _openModal);

    const btnClose = document.getElementById('btn-close-watchlist-modal');
    const btnCancel = document.getElementById('btn-cancel-watchlist');
    if (btnClose) btnClose.addEventListener('click', _closeModal);
    if (btnCancel) btnCancel.addEventListener('click', _closeModal);

    const form = document.getElementById('watchlist-form');
    if (form) form.addEventListener('submit', _handleSave);

    db.on('watchlist_updated', render);
    db.on('settings_updated', render);
    db.on('capital_updated', render);
  }

  async function render() {
    const tbody = document.getElementById('watchlist-tbody');
    if (!tbody) return;

    _watchlist = await db.getWatchlist();
    const settings = await db.getSettings();
    const riskPct = settings.riskPerTrade || 1.0;
    
    // Quick capital fetch
    const capList = await db.getCapital();
    const totalCap = capList.reduce((s, c) => s + (c.amount || 0), 0) || 100000;
    const totalRiskAmt = totalCap * (riskPct / 100);

    if (_watchlist.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">No items in watchlist.</td></tr>';
      return;
    }

    let html = '';
    for (const item of _watchlist) {
      const trigger = Number(item.trigger_price) || 0;
      const sl = Number(item.stop_loss) || 0;
      const riskPerShare = Math.abs(trigger - sl);
      const totalQty = riskPerShare > 0 ? Math.floor(totalRiskAmt / riskPerShare) : 0;
      const initialQty = Math.floor(totalQty / 2); // 50% initial size

      const statusBadge = item.status === 'triggered' 
        ? `<span class="badge" style="background:rgba(245, 158, 11, 0.2);color:#fbbf24;border:1px solid #f59e0b">Triggered</span>`
        : `<span class="badge" style="background:rgba(16, 185, 129, 0.2);color:#34d399;border:1px solid #10b981">Monitoring</span>`;

      html += `
        <tr>
          <td><strong style="color:var(--text-primary)">${item.symbol}</strong></td>
          <td class="font-mono">₹${calc.formatNumber(trigger)}</td>
          <td class="font-mono">₹${calc.formatNumber(sl)}</td>
          <td class="font-mono">₹${calc.formatNumber(riskPerShare)}</td>
          <td class="font-mono">${initialQty}</td>
          <td>${statusBadge}</td>
          <td style="text-align:right">
            <button class="btn btn-secondary btn-sm" onclick="WatchlistModule.deleteItem('${item.id}')" title="Delete">🗑</button>
          </td>
        </tr>
      `;
    }
    tbody.innerHTML = html;
  }

  function _openModal() {
    document.getElementById('watchlist-form').reset();
    document.getElementById('watchlist-modal').classList.remove('hidden');
  }

  function _closeModal() {
    document.getElementById('watchlist-modal').classList.add('hidden');
  }

  async function _handleSave(e) {
    e.preventDefault();
    const symbol = document.getElementById('wl-symbol').value.trim().toUpperCase();
    const trigger = parseFloat(document.getElementById('wl-trigger').value);
    const stop = parseFloat(document.getElementById('wl-stop').value);

    try {
      await db.saveWatchlistItem({ symbol, trigger_price: trigger, stop_loss: stop, status: 'monitoring' });
      _closeModal();
    } catch (err) {
      alert("Error saving: " + err.message);
    }
  }

  async function deleteItem(id) {
    if (confirm('Remove this item from your watchlist?')) {
      await db.deleteWatchlistItem(id);
    }
  }

  return { init, render, deleteItem };
})();
