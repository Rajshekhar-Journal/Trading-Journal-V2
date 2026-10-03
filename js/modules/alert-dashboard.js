/**
 * alert-dashboard.js — Alert Dashboard (spec §7).
 * Compact card on the Dashboard with today's alerts; maximise opens a
 * full-screen log of every alert, newest first, with filters and CSV export.
 * Reads only `alert_log`; never runs the rule engine.
 */
const AlertDashboard = (() => {
  const CARD_ID = 'alert-dashboard';
  let _filter = 'all';          // compact card chip filter
  let _full = null;             // full-screen overlay element

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const time = iso => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  const dateStr = iso => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
  const inr = v => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const todayStartIso = () => new Date(Date.parse(TLMIndicators.istDate(Date.now()) + 'T00:00:00+05:30')).toISOString();

  const GROUPS = {
    entry:  a => a.rule_id === 'LC-01',
    target: a => ['LC-02', 'LC-03', 'LC-04', 'LC-05'].includes(a.rule_id),
    exit:   a => a.rule_id === 'LC-07',
    breach: a => a.rule_id === 'LC-09',
    open:   a => a.status === 'New',
  };

  function _typeClass(a) {
    if (a.rule_id === 'LC-09') return 'ad-type ad-critical';
    if (a.rule_id === 'LC-07') return 'ad-type ad-exit';
    if (a.rule_id === 'LC-10') return 'ad-type ad-info';
    return 'ad-type ad-action';
  }

  function _statusCell(a) {
    if (a.mode === 'paper') return '<span class="ad-status ad-done">Auto-executed</span>';
    if (a.status === 'Executed') return '<span class="ad-status ad-done">Executed</span>';
    if (a.status === 'Dismissed') return '<span class="ad-status">Dismissed</span>';
    return `<button class="btn btn-sm btn-primary" data-ad-act="exec" data-id="${a.id}">Mark executed</button>
            <button class="btn btn-sm btn-secondary" data-ad-act="dismiss" data-id="${a.id}">Dismiss</button>`;
  }

  function _row(a, withDate) {
    return `<tr class="${a.rule_id === 'LC-09' && a.status === 'New' ? 'ad-row-critical' : ''}">
      ${withDate ? `<td>${dateStr(a.created_at)}</td>` : ''}
      <td class="font-mono">${time(a.created_at)}</td>
      <td><strong>${esc(a.symbol)}</strong> <span class="ad-mode ad-${a.mode}">${a.mode.toUpperCase()}</span></td>
      <td><span class="${_typeClass(a)}">${esc(a.alert_type)}</span></td>
      <td class="font-mono">${inr(a.cmp)}</td>
      <td>${esc(a.suggestion?.text || '')}</td>
      <td style="white-space:nowrap">${_statusCell(a)}</td>
      ${withDate ? `<td>${esc(a.telegram_status || '—')}</td>` : ''}
    </tr>`;
  }

  function _bindActions(root, refresh) {
    root.querySelectorAll('[data-ad-act]').forEach(btn => btn.addEventListener('click', async e => {
      e.stopPropagation();
      const patch = btn.dataset.adAct === 'exec'
        ? { status: 'Executed', executed_at: new Date().toISOString() }
        : { status: 'Dismissed' };
      await db.updateAlert(btn.dataset.id, patch);
      refresh();
    }));
  }

  // ── Compact card ─────────────────────────────────────────────────────────
  async function render() {
    const el = document.getElementById(CARD_ID);
    if (!el) return;
    const all = await db.getAlerts({ since: todayStartIso(), limit: 500 });
    const counts = Object.fromEntries(Object.entries(GROUPS).map(([k, f]) => [k, all.filter(f).length]));
    const shown = (_filter === 'all' ? all : all.filter(GROUPS[_filter]))
      .sort((a, b) => (b.rule_id === 'LC-09' && b.status === 'New') - (a.rule_id === 'LC-09' && a.status === 'New') || b.created_at.localeCompare(a.created_at));
    const chip = (k, label) => `<button class="filter-btn ${_filter === k ? 'active' : ''}" data-ad-filter="${k}">${label}${k === 'all' ? ` ${all.length}` : ` ${counts[k]}`}</button>`;
    const last = TLMRunner.lastRun();
    const srv = TLMRunner.serverStatus?.();
    const engineLine = TLMRunner.host?.() === 'server'
      ? `<span class="ad-host ad-host-server" title="Rules run on the server every minute, even with this app closed">● Server runner${srv?.last_finished_at ? ' · ' + time(srv.last_finished_at) : ''}</span>`
      : `<span class="ad-host ad-host-browser" title="The server runner has not reported in the last 3 minutes, so this browser tab runs the rules (dashboard alerts only, no Telegram)">● Browser fallback${last ? ' · ' + time(new Date(last).toISOString()) : ''}</span>`;

    el.innerHTML = `
      <div class="card-header">
        <span class="card-title">Alert Dashboard — today ${counts.open ? '<span class="ad-dot"></span>' : ''}</span>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="card-subtitle">${engineLine}</span>
          <button class="btn btn-sm btn-secondary" id="ad-sync" title="Run the rule engine now">⟳ Sync now</button>
          <button class="btn btn-sm btn-secondary" id="ad-max" title="Open the full alert log">⛶ Full log</button>
        </div>
      </div>
      <div class="date-filter-group" style="margin:0 0 10px">
        ${chip('all', 'All')}${chip('entry', 'Entries')}${chip('target', 'Targets')}${chip('exit', 'Partial exits')}${chip('breach', 'Stop breaches')}${chip('open', 'Pending')}
      </div>
      <div class="table-wrap" style="max-height:320px;overflow-y:auto">
        <table class="data-table ad-table">
          <thead><tr><th>Time</th><th>Symbol</th><th>Alert type</th><th>CMP</th><th>Suggestion</th><th>Status</th></tr></thead>
          <tbody>${shown.length ? shown.slice(0, 50).map(a => _row(a, false)).join('') : '<tr><td colspan="6" class="no-data" style="padding:24px">No alerts today</td></tr>'}</tbody>
        </table>
      </div>`;

    el.querySelectorAll('[data-ad-filter]').forEach(b => b.addEventListener('click', () => { _filter = b.dataset.adFilter; render(); }));
    el.querySelector('#ad-max').addEventListener('click', openFull);
    el.querySelector('#ad-sync').addEventListener('click', async () => {
      app.toast('Running rule engine…', 'info', 1500);
      try { await TLMRunner.runCycle({ force: true }); } catch (e) { app.toast(e.message, 'error'); }
      render();
    });
    _bindActions(el, render);
  }

  // ── Full-screen log ──────────────────────────────────────────────────────
  async function openFull() {
    closeFull();
    _full = document.createElement('div');
    _full.className = 'ad-full';
    const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    _full.innerHTML = `
      <div class="ad-full-head">
        <h2>Alert log</h2>
        <div class="ad-filters">
          <label>From <input type="date" class="form-input" id="adf-from" value="${from}"></label>
          <label>To <input type="date" class="form-input" id="adf-to" value="${TLMIndicators.istDate(Date.now())}"></label>
          <input class="form-input" id="adf-sym" placeholder="Symbol">
          <select class="form-select" id="adf-mode"><option value="">Real + Paper</option><option value="real">Real</option><option value="paper">Paper</option></select>
          <select class="form-select" id="adf-status"><option value="">Any status</option><option>New</option><option>Executed</option><option>Dismissed</option></select>
          <button class="btn btn-sm btn-secondary" id="adf-csv">⬇ CSV</button>
          <button class="btn btn-sm btn-secondary" id="adf-close" title="Esc">✕ Close</button>
        </div>
      </div>
      <div class="ad-full-body" id="adf-body"></div>`;
    document.body.appendChild(_full);
    _full.querySelectorAll('input,select').forEach(i => i.addEventListener('change', _renderFull));
    _full.querySelector('#adf-sym').addEventListener('input', _renderFull);
    _full.querySelector('#adf-close').addEventListener('click', closeFull);
    _full.querySelector('#adf-csv').addEventListener('click', _exportCsv);
    document.addEventListener('keydown', _esc);
    await _renderFull();
  }

  function _esc(e) { if (e.key === 'Escape') closeFull(); }

  function closeFull() {
    if (_full) _full.remove();
    _full = null;
    document.removeEventListener('keydown', _esc);
  }

  async function _filtered() {
    const v = id => _full.querySelector(id).value;
    const since = new Date(Date.parse(v('#adf-from') + 'T00:00:00+05:30')).toISOString();
    const until = new Date(Date.parse(v('#adf-to') + 'T23:59:59+05:30')).toISOString();
    const sym = v('#adf-sym').trim().toUpperCase(), mode = v('#adf-mode'), status = v('#adf-status');
    return (await db.getAlerts({ since, until, limit: 5000 }))
      .filter(a => (!sym || a.symbol.includes(sym)) && (!mode || a.mode === mode) && (!status || a.status === status));
  }

  async function _renderFull() {
    if (!_full) return;
    const rows = await _filtered();
    const byDay = {};
    rows.forEach(a => (byDay[dateStr(a.created_at)] ||= []).push(a));
    _full.querySelector('#adf-body').innerHTML = rows.length ? `
      <table class="data-table ad-table">
        <thead><tr><th>Date</th><th>Time</th><th>Symbol</th><th>Alert type</th><th>CMP</th><th>Suggestion</th><th>Status</th><th>Telegram</th></tr></thead>
        <tbody>${Object.entries(byDay).map(([d, list]) =>
          `<tr class="ad-day"><td colspan="8">${d} · ${list.length} alert${list.length > 1 ? 's' : ''}</td></tr>` + list.map(a => _row(a, true)).join('')).join('')}</tbody>
      </table>` : '<div class="no-data" style="padding:40px">No alerts match these filters</div>';
    _bindActions(_full, _renderFull);
  }

  async function _exportCsv() {
    const rows = await _filtered();
    const head = ['date', 'time', 'symbol', 'mode', 'rule', 'alert_type', 'cmp', 'suggestion', 'status', 'telegram'];
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [head.join(','), ...rows.map(a => [dateStr(a.created_at), time(a.created_at), a.symbol, a.mode, a.rule_id, a.alert_type, a.cmp, a.suggestion?.text, a.status, a.telegram_status].map(q).join(','))].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = `alert-log-${TLMIndicators.istDate(Date.now())}.csv`;
    link.click();
  }

  // Keep the card live.
  function _autoRefresh() {
    const visible = () => document.getElementById('mod-dashboard')?.classList.contains('active');
    window.addEventListener('tlm:cycle', () => { if (visible()) render(); if (_full) _renderFull(); });
    window.addEventListener('tlm:host', () => { if (visible()) render(); });
  }
  _autoRefresh();

  return { render, openFull, closeFull };
})();
window.AlertDashboard = AlertDashboard;
