/**
 * paper-trades.js — Paper Trades module.
 * Paper trades are created and managed automatically by the Trade Lifecycle
 * rule engine (js/engine/*) with the same rules as real trades; this page only
 * displays them. All maths come from calc.getTradeMetrics, like real trades.
 */
const PaperTradesModule = (() => {
  let _selectedId = null;
  let _listening = false;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = v => `${v >= 0 ? '+' : '-'}₹${calc.formatNumber(Math.abs(v))}`;
  const color = v => v > 0 ? '#10b981' : v < 0 ? '#ef4444' : 'var(--text-muted)';

  async function init() {
    _selectedId = null;
    document.getElementById('pt-detail-panel')?.classList.add('hidden');
    document.getElementById('pt-table-panel')?.classList.remove('panel-open');
    if (!_listening) {
      _listening = true;
      window.addEventListener('tlm:cycle', () => {
        if (document.getElementById('mod-paper')?.classList.contains('active')) _refresh();
      });
    }
    await _refresh();
  }

  async function _refresh() {
    const all = await db.getPaperTrades();
    _renderCards(all);
    _renderTable(all);
    if (_selectedId) await _renderDetail(_selectedId, all);
  }

  /** Realized + unrealized P&L and R for a paper trade (same maths as real trades). */
  function _pnl(trade) {
    const m = calc.getTradeMetrics(trade);
    const unreal = m.openQty > 0 ? calc.getUnrealizedPnl(trade, trade.cmp || m.avgEntryPrice) : 0;
    const total = m.realizedPnl + unreal;
    return { m, unreal, total, r: m.trueRPT > 0 ? total / m.trueRPT : 0 };
  }

  function _renderCards(all) {
    const box = document.getElementById('pt-overview-cards');
    if (!box) return;
    const open = all.filter(t => db.getTradeRemainingQty(t) > 0);
    const closed = all.filter(t => db.getTradeRemainingQty(t) <= 0 && t.entries?.length);
    const cm = closed.map(t => calc.getTradeMetrics(t));
    const wins = cm.filter(m => m.realizedPnl > 0).length;
    const booked = cm.reduce((s, m) => s + m.realizedPnl, 0);
    const avgR = cm.length ? cm.reduce((s, m) => s + m.profitR, 0) / cm.length : 0;
    const openPnl = open.reduce((s, t) => s + _pnl(t).unreal, 0);
    const card = (label, value, sub, c) => `<div class="stat-card"><div class="stat-card-label">${label}</div><div class="stat-card-value" ${c ? `style="color:${c}"` : ''}>${value}</div><div class="stat-card-sub">${sub}</div></div>`;
    box.innerHTML =
      card('Open', open.length, 'Auto-managed now') +
      card('Closed', closed.length, 'Completed lifecycles') +
      card('Win rate', closed.length ? Math.round(wins / closed.length * 100) + '%' : '—', `${wins} wins / ${closed.length - wins} losses`) +
      card('Avg R (closed)', calc.formatR(avgR), 'True-RPT based', color(avgR)) +
      card('Booked P&L', money(booked), `Open: ${money(openPnl)}`, color(booked));
  }

  function _renderTable(all) {
    const tbody = document.getElementById('pt-table-body');
    const count = document.getElementById('pt-count');
    if (!tbody) return;
    if (count) count.textContent = `${all.length} paper trade${all.length !== 1 ? 's' : ''}`;
    if (!all.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:48px 0;color:var(--text-muted)">
        <div style="font-weight:600;margin-bottom:4px">No paper trades yet</div>
        <div style="font-size:12px">Add a stock to the <strong>Watchlist</strong> in <strong>Real + Paper</strong> or <strong>Paper</strong> mode. The engine enters automatically once price holds above the trigger.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = all.map(t => {
      const { m, total, r } = _pnl(t);
      const s = TLMPanel.stateOf(t);
      const stage = m.openQty > 0 ? TLMRules.stageLabel(s) : 'Closed';
      return `<tr class="${t.id === _selectedId ? 'row-selected' : ''}" style="cursor:pointer" onclick="PaperTradesModule._open('${t.id}')">
        <td><strong>${esc(t.symbol)}</strong></td>
        <td><span class="badge badge-muted" style="font-size:10px">${esc(t.sector || '—')}</span></td>
        <td>${t.entries?.[0]?.date || '—'}</td>
        <td class="font-mono">₹${calc.formatNumber(m.avgEntryPrice)}</td>
        <td class="font-mono">${m.openQty > 0 && t.cmp ? '₹' + calc.formatNumber(t.cmp) : '—'}</td>
        <td class="font-mono">₹${calc.formatNumber(s?.hardStop || m.currentStop)}</td>
        <td class="font-mono">${m.openQty > 0 ? m.openQty : '—'}</td>
        <td class="font-mono" style="color:${color(total)};font-weight:600;white-space:nowrap">${money(total)} <span style="font-size:11px;opacity:.75">(${calc.formatR(r)})</span></td>
        <td><span class="tlm-stage">${stage}</span></td>
      </tr>`;
    }).join('');
  }

  async function _open(id) {
    _selectedId = id;
    await _refresh();
  }

  async function _renderDetail(id, all) {
    const panel = document.getElementById('pt-detail-panel');
    const trade = all.find(t => t.id === id);
    if (!panel || !trade) return;
    panel.classList.remove('hidden');
    document.getElementById('pt-table-panel')?.classList.add('panel-open');
    const { m, total, r } = _pnl(trade);

    const events = [
      ...(trade.entries || []).map(e => ({ date: e.date, type: 'Entry', detail: `Bought ${e.qty} @ ₹${calc.formatNumber(e.price)}` })),
      ...(trade.pyramids || []).map(e => ({ date: e.date, type: e.actionSource || '1R add', detail: `Bought ${e.qty} @ ₹${calc.formatNumber(e.price)}` })),
      ...(trade.stopRevisions || []).map(e => ({ date: e.date, type: e.actionSource || 'Stop', detail: `Stop ₹${calc.formatNumber(e.oldStop)} → ₹${calc.formatNumber(e.newStop)}` })),
      ...(trade.partialExits || []).map(e => ({ date: e.date, type: e.actionSource || 'Partial exit', detail: `Sold ${e.qty} @ ₹${calc.formatNumber(e.price)}` })),
      ...(trade.finalExit ? [{ date: trade.finalExit.date, type: trade.finalExit.actionSource || 'Final exit', detail: `Sold ${trade.finalExit.qty} @ ₹${calc.formatNumber(trade.finalExit.price)}` }] : []),
    ].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;overflow-y:auto;padding:20px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
          <div>
            <h2 style="margin:0;font-size:20px">${esc(trade.symbol)} <span class="ad-mode ad-paper">PAPER</span></h2>
            <div style="font-size:12px;color:var(--text-muted)">${esc(trade.sector || '')} · ${m.holdingDays} days · charges ₹${calc.formatNumber(m.totalCharges)}</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="PaperTradesModule._close()">✕ Close</button>
        </div>
        <div class="tlm-grid">
          <div class="tlm-cell"><div class="k">Avg entry</div><div class="v">₹${calc.formatNumber(m.avgEntryPrice)}</div></div>
          <div class="tlm-cell"><div class="k">Open qty</div><div class="v">${m.openQty}</div></div>
          <div class="tlm-cell"><div class="k">Realized</div><div class="v" style="color:${color(m.realizedPnl)}">${money(m.realizedPnl)}</div></div>
          <div class="tlm-cell"><div class="k">Total (R)</div><div class="v" style="color:${color(total)}">${calc.formatR(r)}</div></div>
        </div>
        <div class="card tlm-card" style="padding:12px;margin:12px 0">${TLMPanel.html(trade)}</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">Auto-executed lifecycle</div>
        <table class="data-table" style="font-size:12px"><thead><tr><th>Date</th><th>Rule</th><th>Detail</th></tr></thead>
          <tbody>${events.map(e => `<tr><td>${e.date || '—'}</td><td>${esc(e.type)}</td><td>${e.detail}</td></tr>`).join('')}</tbody></table>
        <button class="btn btn-secondary" style="margin-top:16px;color:#ef4444;border-color:#ef4444" onclick="PaperTradesModule._delete('${trade.id}')">Delete paper trade</button>
      </div>`;
    TLMPanel.loadSnapshots(trade);
  }

  function _close() {
    _selectedId = null;
    document.getElementById('pt-detail-panel')?.classList.add('hidden');
    document.getElementById('pt-table-panel')?.classList.remove('panel-open');
    _refresh();
  }

  async function _delete(id) {
    if (!confirm('Delete this paper trade? This cannot be undone.')) return;
    await db.deletePaperTrade(id);
    app.toast('Paper trade deleted', 'success');
    _close();
  }

  return { init, _open, _close, _delete };
})();
window.PaperTradesModule = PaperTradesModule;
