/**
 * paper-trades.js — Paper Trades Module
 * Shows all simulated paper trades with split-view detail panel.
 * Mirrors positions.js coding style exactly.
 */
const PaperTradesModule = (() => {
  let _selectedId = null;

  // ── CMP Fetch Helper ─────────────────────────────────────────────────────
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

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    await _renderOverviewCards();
    await _renderTable();
    _selectedId = null;
    // Collapse detail panel on re-init
    const panel = document.getElementById('pt-detail-panel');
    const left  = document.getElementById('pt-table-panel');
    if (panel) panel.classList.add('hidden');
    if (left)  left.classList.remove('panel-open');
  }

  // ── Overview Cards ────────────────────────────────────────────────────────
  async function _renderOverviewCards() {
    const container = document.getElementById('pt-overview-cards');
    if (!container) return;

    const all     = await db.getPaperTrades();
    const open    = all.filter(t => db.getTradeRemainingQty(t) > 0);
    const closed  = all.filter(t => db.getTradeRemainingQty(t) <= 0 && t.entries?.length > 0);
    const winList = closed.filter(t => _simPnl(t) > 0);
    const wr      = closed.length > 0 ? ((winList.length / closed.length) * 100).toFixed(0) : 0;
    const totalPnl = closed.reduce((s, t) => s + _simPnl(t), 0);
    const avgR    = closed.length > 0
      ? (closed.reduce((s, t) => s + _simR(t), 0) / closed.length).toFixed(2)
      : '0.00';

    container.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">Open Simulations</div>
        <div class="stat-value">${open.length}</div>
        <div class="stat-sub">Actively tracked</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Closed Simulations</div>
        <div class="stat-value">${closed.length}</div>
        <div class="stat-sub">Completed exits</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value" style="color:${Number(wr) >= 50 ? '#10b981' : '#ef4444'}">${wr}%</div>
        <div class="stat-sub">${winList.length} wins / ${closed.length - winList.length} losses</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg R (Closed)</div>
        <div class="stat-value" style="color:${Number(avgR) >= 0 ? '#10b981' : '#ef4444'}">${avgR}R</div>
        <div class="stat-sub">Per closed sim</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Sim. P&L</div>
        <div class="stat-value" style="color:${totalPnl >= 0 ? '#10b981' : '#ef4444'}">
          ${totalPnl >= 0 ? '+' : ''}&#8377;${calc.formatNumber(Math.abs(totalPnl))}
        </div>
        <div class="stat-sub">Closed trades only</div>
      </div>`;
  }

  // ── Render Table ──────────────────────────────────────────────────────────
  async function _renderTable() {
    const tbody = document.getElementById('pt-table-body');
    const count = document.getElementById('pt-count');
    if (!tbody) return;

    const all = await db.getPaperTrades();
    if (count) count.textContent = `${all.length} simulation${all.length !== 1 ? 's' : ''}`;

    if (!all.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:48px 0;color:var(--text-muted)">
        <div style="font-size:36px;margin-bottom:10px">&#128196;</div>
        <div style="font-weight:600;margin-bottom:4px">No paper trades yet</div>
        <div style="font-size:12px">Go to <strong>Watchlist</strong> and click <strong>&#128196; Paper</strong> on a triggered stock to start a simulation.</div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = all.map(trade => {
      const m          = calc.getTradeMetrics ? calc.getTradeMetrics(trade) : _fallbackMetrics(trade);
      const entryDate  = trade.entries?.[0]?.date || trade.createdAt || '';
      const entryPrice = trade.entries?.[0]?.price || 0;
      const stop       = trade.initialStop || 0;
      const isOpen     = db.getTradeRemainingQty(trade) > 0;
      const pnl        = _simPnl(trade);
      const r          = _simR(trade);
      const status     = _statusBadge(trade);
      const pnlColor   = pnl > 0 ? '#10b981' : pnl < 0 ? '#ef4444' : 'var(--text-muted)';
      const isSelected = trade.id === _selectedId;

      return `<tr class="${isSelected ? 'row-selected' : ''}" style="cursor:pointer" onclick="PaperTradesModule._onRowClick('${trade.id}')">
        <td><strong>${trade.symbol}</strong></td>
        <td><span class="badge badge-muted" style="font-size:10px">${trade.sector || '—'}</span></td>
        <td>${entryDate}</td>
        <td class="font-mono">&#8377;${calc.formatNumber(entryPrice)}</td>
        <td id="pt-cmp-${trade.id}" class="font-mono" style="color:var(--text-muted);font-size:12px">${isOpen ? '&#8230;' : '<span style="color:var(--text-muted)">Closed</span>'}</td>
        <td class="font-mono">&#8377;${calc.formatNumber(stop)}</td>
        <td class="font-mono">${isOpen ? m.openQty : '<span style="color:var(--text-muted)">—</span>'}</td>
        <td class="font-mono" style="color:${pnlColor};font-weight:600">
          ${pnl !== 0 ? (pnl > 0 ? '+' : '') + '&#8377;' + calc.formatNumber(Math.abs(pnl)) : '&#8212;'}
          ${r !== 0 ? `<span style="font-size:11px;opacity:0.75">&nbsp;(${r > 0 ? '+' : ''}${r.toFixed(2)}R)</span>` : ''}
        </td>
        <td>${status}</td>
      </tr>`;
    }).join('');
  }

  // ── Row Click → Open Detail Panel ─────────────────────────────────────────
  async function _onRowClick(id) {
    _selectedId = id;
    await _renderTable(); // re-render to highlight selected row
    await _renderDetailPanel(id);
  }

  // ── Render Detail Panel ───────────────────────────────────────────────────
  async function _renderDetailPanel(id) {
    const panel  = document.getElementById('pt-detail-panel');
    const left   = document.getElementById('pt-table-panel');
    if (!panel) return;

    const all   = await db.getPaperTrades();
    const trade = all.find(t => t.id === id);
    if (!trade) return;

    panel.classList.remove('hidden');
    left.classList.add('panel-open');

    const m          = calc.getTradeMetrics ? calc.getTradeMetrics(trade) : _fallbackMetrics(trade);
    const entryPrice = trade.entries?.[0]?.price || 0;
    const riskPS     = Math.abs(entryPrice - (trade.initialStop || 0));
    const target1R   = entryPrice + riskPS;
    const isOpen     = db.getTradeRemainingQty(trade) > 0;
    const pnl        = _simPnl(trade);
    const r          = _simR(trade);
    const pnlColor   = pnl > 0 ? '#10b981' : pnl < 0 ? '#ef4444' : 'var(--text-muted)';
    const holdDays   = _holdingDays(trade);

    // Build lifecycle events
    const events = [];
    (trade.entries || []).forEach(e => events.push({ date: e.date, type: 'Entry', detail: `${e.qty} shares @ &#8377;${calc.formatNumber(e.price)}`, color: '#3b82f6' }));
    (trade.stopRevisions || []).forEach(s => events.push({ date: s.date, type: 'Stop Trail', detail: `&#8377;${calc.formatNumber(s.oldStop)} → &#8377;${calc.formatNumber(s.newStop)} (${s.actionSource})`, color: '#f59e0b' }));
    (trade.partialExits || []).forEach(p => events.push({ date: p.date, type: 'Partial Exit', detail: `${p.qty} shares @ &#8377;${calc.formatNumber(p.price)} — <em>${p.actionSource}</em>`, color: '#10b981' }));
    if (trade.finalExit) events.push({ date: trade.finalExit.date, type: 'Final Exit', detail: `${trade.finalExit.qty} shares @ &#8377;${calc.formatNumber(trade.finalExit.price)} — <em>${trade.finalExit.actionSource}</em>`, color: '#ef4444' });
    events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const lifecycleRows = events.map(e => `
      <tr>
        <td style="color:var(--text-muted);font-size:11px">${e.date || '—'}</td>
        <td><span style="color:${e.color};font-weight:600;font-size:12px">${e.type}</span></td>
        <td style="font-size:12px">${e.detail}</td>
      </tr>`).join('');

    // Next targets
    const targets = [];
    if (isOpen) {
      if (!(trade.partialExits || []).some(p => p.actionSource?.includes('1R'))) targets.push({ label: '1R Target', price: target1R, color: '#f59e0b' });
        if (trade.entryATR && trade.swingLow) {
          const atr   = trade.entryATR;
          const isShort = trade.direction === 'Short';
          [[4,'#3b82f6'],[8,'#f97316'],[12,'#a855f7']].forEach(([mult, col]) => {
            const price = isShort
              ? trade.swingLow - mult * atr
              : trade.swingLow + mult * atr;
            if (!(trade.partialExits || []).some(p => p.actionSource?.includes(mult + '×'))) {
              targets.push({ label: `${mult}×ATR Target`, price, color: col });
            }
          });
        }
      targets.push({ label: 'Day-6 Time Stop', price: null, color: '#6b7280', note: `Day ${holdDays} of 6` });
    }

    const targetRows = targets.map(t => `
      <tr>
        <td style="color:${t.color};font-weight:600;font-size:12px">${t.label}</td>
        <td class="font-mono">${t.price ? '&#8377;' + calc.formatNumber(t.price) : '—'}</td>
        <td style="font-size:11px;color:var(--text-muted)">${t.note || (t.price ? 'Pending' : '')}</td>
      </tr>`).join('');

    panel.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;overflow-y:auto">
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:20px 20px 0;margin-bottom:16px">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
              <h2 style="margin:0;font-size:20px;font-weight:700">${trade.symbol}</h2>
              <span class="badge" style="background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.35);padding:2px 8px;border-radius:12px;font-size:11px">&#128196; Paper</span>
              ${_statusBadge(trade)}
            </div>
            <div style="font-size:12px;color:var(--text-muted)">${trade.sector || ''} &bull; ${trade.direction} &bull; Held ${holdDays} day${holdDays !== 1 ? 's' : ''}</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="PaperTradesModule._closePanel()">✕ Close</button>
        </div>

        <!-- Key Metrics -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:0 20px 16px">
          <div class="card" style="padding:12px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Entry Price</div>
            <div style="font-weight:700;font-size:15px">&#8377;${calc.formatNumber(entryPrice)}</div>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Stop Loss</div>
            <div style="font-weight:700;font-size:15px;color:#ef4444">&#8377;${calc.formatNumber(trade.initialStop)}</div>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Risk/Share</div>
            <div style="font-weight:700;font-size:15px">&#8377;${calc.formatNumber(riskPS)}</div>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Current Stop</div>
            <div style="font-weight:700;font-size:15px;color:#f59e0b">&#8377;${calc.formatNumber(m.currentStop)}</div>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Open Qty</div>
            <div style="font-weight:700;font-size:15px">${isOpen ? m.openQty : '—'}</div>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Sim. P&L</div>
            <div style="font-weight:700;font-size:15px;color:${pnlColor}">
              ${pnl !== 0 ? (pnl > 0 ? '+' : '') + '&#8377;' + calc.formatNumber(Math.abs(pnl)) : '—'}
              ${r !== 0 ? `<br><span style="font-size:11px">${r > 0 ? '+' : ''}${r.toFixed(2)}R</span>` : ''}
            </div>
          </div>
        </div>

        <!-- Next Targets (only if open) -->
        ${isOpen && targetRows ? `
        <div style="padding:0 20px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text)">&#127919; Next Auto-Exit Targets</div>
          <div class="card" style="padding:0">
            <table class="data-table" style="font-size:12px">
              <thead><tr><th>Level</th><th>Price</th><th>Status</th></tr></thead>
              <tbody>${targetRows}</tbody>
            </table>
          </div>
        </div>` : ''}

        <!-- Auto-Exit Lifecycle -->
        <div style="padding:0 20px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text)">&#128200; Auto-Exit Lifecycle</div>
          <div class="card" style="padding:0">
            <table class="data-table" style="font-size:12px">
              <thead><tr><th>Date</th><th>Event</th><th>Detail</th></tr></thead>
              <tbody>${lifecycleRows || '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:16px">No events yet — simulation in progress</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <!-- Actions -->
        <div style="padding:0 20px 20px;margin-top:auto">
          <button class="btn btn-secondary" style="width:100%;color:#ef4444;border-color:#ef4444"
            onclick="PaperTradesModule._deleteTrade('${trade.id}')">
            &#128465; Delete Paper Trade
          </button>
        </div>
      </div>`;
  }

  // ── Close Detail Panel ────────────────────────────────────────────────────
  function _closePanel() {
    _selectedId = null;
    const panel = document.getElementById('pt-detail-panel');
    const left  = document.getElementById('pt-table-panel');
    if (panel) panel.classList.add('hidden');
    if (left)  left.classList.remove('panel-open');
    _renderTable();
  }

  // ── Delete Paper Trade ────────────────────────────────────────────────────
  async function _deleteTrade(id) {
    if (!confirm('Delete this paper trade simulation? This cannot be undone.')) return;
    await db.deletePaperTrade(id);
    _closePanel();
    app.toast('Paper trade deleted', 'success');
    await _renderOverviewCards();
    await _renderTable();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _simPnl(trade) {
    const entryPrice = trade.entries?.[0]?.price || 0;
    const isShort    = trade.direction === 'Short';
    let pnl = 0;
    (trade.partialExits || []).forEach(p => {
      pnl += isShort ? (entryPrice - p.price) * p.qty : (p.price - entryPrice) * p.qty;
    });
    if (trade.finalExit) {
      pnl += isShort
        ? (entryPrice - trade.finalExit.price) * trade.finalExit.qty
        : (trade.finalExit.price - entryPrice) * trade.finalExit.qty;
    }
    return pnl;
  }

  function _simR(trade) {
    const riskPS   = Math.abs((trade.entries?.[0]?.price || 0) - (trade.initialStop || 0));
    if (!riskPS) return 0;
    const totalQty = (trade.entries || []).reduce((s, e) => s + e.qty, 0);
    const totalRisk = riskPS * totalQty;
    return totalRisk > 0 ? _simPnl(trade) / totalRisk : 0;
  }

  function _holdingDays(trade) {
    const entry = new Date(trade.entries?.[0]?.date || trade.createdAt || new Date());
    const end   = trade.finalExit?.date ? new Date(trade.finalExit.date) : new Date();
    return Math.max(0, Math.floor((end - entry) / (1000 * 60 * 60 * 24)));
  }

  function _fallbackMetrics(trade) {
    const ins = [...(trade.entries || []), ...(trade.pyramids || [])];
    let tq = 0, tc = 0;
    ins.forEach(e => { tq += e.qty; tc += e.price * e.qty; });
    const outs = (trade.partialExits || []).reduce((s, e) => s + e.qty, 0) + (trade.finalExit?.qty || 0);
    const lastStop = (trade.stopRevisions || []).slice(-1)[0]?.newStop || trade.initialStop;
    return { openQty: Math.max(0, tq - outs), avgEntryPrice: tq > 0 ? tc / tq : 0, currentStop: lastStop };
  }

  function _statusBadge(trade) {
    const isOpen = db.getTradeRemainingQty(trade) > 0;
    if (isOpen) {
      const has1R = (trade.partialExits || []).some(p => p.actionSource?.includes('1R'));
      if (has1R) return `<span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.35);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">&#9989; 1R Hit — Open</span>`;
      return `<span class="badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.35);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">&#9200; Monitoring</span>`;
    }
    const src = trade.finalExit?.actionSource || '';
    if (src.includes('Stop Loss')) return `<span class="badge" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.35);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">&#10060; Stopped Out</span>`;
    if (src.includes('Time Stop'))  return `<span class="badge" style="background:rgba(107,114,128,0.15);color:#9ca3af;border:1px solid rgba(107,114,128,0.35);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">&#8987; Time Exit</span>`;
    return `<span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.35);padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">&#128176; Profit Exit</span>`;
  }

  return { init, _onRowClick, _closePanel, _deleteTrade };
})();

window.PaperTradesModule = PaperTradesModule;
