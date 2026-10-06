/**
 * chartbook.js — Chartbook page: every trade (real and paper) as a card with its entry and exit charts,
 * key numbers, lifecycle timeline and your notes & lessons. Filters, "Build missing charts" and
 * PDF / Word export (js/export/*). Charts are saved by the server rule runner (engine/chartbook.js).
 */
const ChartbookModule = (() => {
  const PAGE = 20;
  let _items = [], _notes = {}, _playbooks = {}, _shown = PAGE, _selected = new Set();
  let _observer = null, _snapCache = {}, _bound = false;
  const _f = { mode: 'all', result: 'all', from: '', to: '', playbook: '', rmin: '', rmax: '', q: '' };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => `${v >= 0 ? '+' : '-'}₹${calc.formatNumber(Math.abs(v))}`;
  const tone = v => v > 0 ? '#059669' : v < 0 ? '#dc2626' : 'var(--text-muted)';

  // ── Data ─────────────────────────────────────────────────────────────────
  function _summary(t, mode) {
    const m = calc.getTradeMetrics(t);
    const open = m.openQty > 0;
    const unreal = open ? calc.getUnrealizedPnl(t, t.cmp || m.avgEntryPrice) : 0;
    const pnl = m.realizedPnl + unreal;
    const r = m.trueRPT > 0 ? pnl / m.trueRPT : (m.profitR || 0);
    return {
      t, mode, m, pnl, r,
      status: open ? 'Open' : (m.realizedPnl > 0 ? 'Win' : 'Loss'),
      entryDate: String(t.entries?.[0]?.date || '').slice(0, 10),
      exitDate: TLMChartbook.exitDate(t),
      playbook: _playbooks[t.playbookId] || '',
      notes: _notes[t.id] || '',
    };
  }

  async function _load() {
    const [real, paper, pbs, notes] = await Promise.all([db.getTrades(), db.getPaperTrades(), db.getPlaybooks(), db.getChartbookNotes()]);
    _playbooks = Object.fromEntries((pbs || []).map(p => [p.id, p.name]));
    _notes = notes || {};
    _items = [...(real || []).map(t => [t, 'real']), ...(paper || []).map(t => [t, 'paper'])]
      .filter(([t]) => (t.entries || []).length)
      .map(([t, mode]) => _summary(t, mode))
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate));
  }

  function _filtered() {
    const q = _f.q.trim().toUpperCase();
    return _items.filter(it =>
      (_f.mode === 'all' || it.mode === _f.mode) &&
      (_f.result === 'all' || it.status.toLowerCase() === _f.result) &&
      (!_f.from || it.entryDate >= _f.from) && (!_f.to || it.entryDate <= _f.to) &&
      (!_f.playbook || it.t.playbookId === _f.playbook) &&
      (_f.rmin === '' || it.r >= Number(_f.rmin)) && (_f.rmax === '' || it.r <= Number(_f.rmax)) &&
      (!q || it.t.symbol.toUpperCase().includes(q)));
  }

  // ── Page ─────────────────────────────────────────────────────────────────
  async function init() {
    const root = document.getElementById('chartbook-root');
    if (!root) return;
    root.innerHTML = '<div class="no-data" style="padding:40px">Loading Chartbook…</div>';
    _shown = PAGE; _selected.clear(); _snapCache = {};
    await _load();
    _renderShell();
    _renderList();
    if (!_bound) {
      _bound = true;
      db.on('charts', () => { _snapCache = {}; });
    }
  }

  function _renderShell() {
    const root = document.getElementById('chartbook-root');
    const pbOpts = Object.entries(_playbooks).map(([id, n]) => `<option value="${esc(id)}" ${_f.playbook === id ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const chip = (key, val, label) => `<button class="filter-btn ${_f[key] === val ? 'active' : ''}" data-cb-chip="${key}:${val}">${label}</button>`;
    root.innerHTML = `
      <div class="card cb-toolbar">
        <div class="cb-row">
          <div class="date-filter-group">${chip('mode', 'all', 'All')}${chip('mode', 'real', 'Real')}${chip('mode', 'paper', 'Paper')}</div>
          <div class="date-filter-group">${chip('result', 'all', 'Any result')}${chip('result', 'win', 'Wins')}${chip('result', 'loss', 'Losses')}${chip('result', 'open', 'Open')}</div>
          <input class="form-input cb-in" id="cb-q" placeholder="Search symbol" value="${esc(_f.q)}">
        </div>
        <div class="cb-row">
          <label class="cb-lbl">Entry from <input type="date" class="form-input cb-in" id="cb-from" value="${_f.from}"></label>
          <label class="cb-lbl">to <input type="date" class="form-input cb-in" id="cb-to" value="${_f.to}"></label>
          <label class="cb-lbl">Playbook <select class="form-select cb-in" id="cb-pb"><option value="">All</option>${pbOpts}</select></label>
          <label class="cb-lbl">R from <input type="number" step="0.5" class="form-input cb-in cb-r" id="cb-rmin" value="${_f.rmin}"></label>
          <label class="cb-lbl">to <input type="number" step="0.5" class="form-input cb-in cb-r" id="cb-rmax" value="${_f.rmax}"></label>
          <span style="flex:1"></span>
          <button class="btn btn-secondary btn-sm" id="cb-build" title="Take charts for trades that have none (uses the server runner)">🛠 Build missing charts</button>
          <button class="btn btn-secondary btn-sm" id="cb-rebuild" title="Take every chart again with the latest layout (1 year of daily history)">↻ Rebuild all</button>
          <button class="btn btn-secondary btn-sm" id="cb-pdf">⬇ Export PDF</button>
          <button class="btn btn-secondary btn-sm" id="cb-docx">⬇ Export Word</button>
        </div>
        <div class="cb-row cb-meta"><span id="cb-count"></span><span id="cb-progress"></span></div>
      </div>
      <div id="cb-list"></div>`;
    root.querySelectorAll('[data-cb-chip]').forEach(b => b.addEventListener('click', () => {
      const [k, v] = b.dataset.cbChip.split(':'); _f[k] = v; _shown = PAGE; _renderShell(); _renderList();
    }));
    const bind = (id, key) => document.getElementById(id)?.addEventListener(id === 'cb-q' ? 'input' : 'change', e => { _f[key] = e.target.value; _shown = PAGE; _renderList(); });
    bind('cb-q', 'q'); bind('cb-from', 'from'); bind('cb-to', 'to'); bind('cb-pb', 'playbook'); bind('cb-rmin', 'rmin'); bind('cb-rmax', 'rmax');
    document.getElementById('cb-build').addEventListener('click', () => _buildMissing(false));
    document.getElementById('cb-rebuild').addEventListener('click', () => {
      if (confirm('Take every saved chart again? Existing charts are replaced; 1-min candles older than a few days cannot be re-fetched.')) _buildMissing(true);
    });
    document.getElementById('cb-pdf').addEventListener('click', () => _export('pdf'));
    document.getElementById('cb-docx').addEventListener('click', () => _export('docx'));
  }

  function _renderList() {
    const list = document.getElementById('cb-list');
    if (!list) return;
    const items = _filtered();
    const wins = items.filter(i => i.status === 'Win').length, losses = items.filter(i => i.status === 'Loss').length;
    const closed = items.filter(i => i.status !== 'Open');
    const avgR = closed.length ? closed.reduce((s, i) => s + i.r, 0) / closed.length : 0;
    document.getElementById('cb-count').innerHTML = `${items.length} trade${items.length === 1 ? '' : 's'} · ${wins} wins / ${losses} losses · avg ${calc.formatR(avgR)} (closed)` +
      (_selected.size ? ` · <strong>${_selected.size} ticked for export</strong> <a href="#" id="cb-clear">clear</a>` : ' · tick cards to export only those');
    document.getElementById('cb-clear')?.addEventListener('click', e => { e.preventDefault(); _selected.clear(); _renderList(); });
    if (!items.length) {
      list.innerHTML = `<div class="card no-data" style="padding:40px;text-align:center">No trades match these filters.</div>`;
      return;
    }
    list.innerHTML = items.slice(0, _shown).map(_card).join('') +
      (items.length > _shown ? `<div style="text-align:center;margin:16px"><button class="btn btn-secondary" id="cb-more">Show ${Math.min(PAGE, items.length - _shown)} more</button></div>` : '');
    document.getElementById('cb-more')?.addEventListener('click', () => { _shown += PAGE; _renderList(); });
    list.querySelectorAll('[data-cb-sel]').forEach(cb => cb.addEventListener('change', () => {
      cb.checked ? _selected.add(cb.dataset.cbSel) : _selected.delete(cb.dataset.cbSel);
      _renderList();
    }));
    list.querySelectorAll('textarea[data-cb-note]').forEach(ta => ta.addEventListener('blur', () => _saveNote(ta)));
    _observe(list);
  }

  function _card(it) {
    const t = it.t, m = it.m;
    const statusCls = it.status === 'Win' ? 'cb-win' : it.status === 'Loss' ? 'cb-loss' : 'cb-open';
    const tl = ChartbookExport.timeline(t).map(([d, e, det]) => `<div class="cb-tl"><span class="font-mono">${d}</span><strong>${esc(e)}</strong><span>${esc(det.replace(/Rs /g, '₹').replace(/->/g, '→'))}</span></div>`).join('');
    return `<div class="card cb-card" data-cb-id="${t.id}">
      <div class="cb-card-head">
        <label class="cb-check"><input type="checkbox" data-cb-sel="${t.id}" ${_selected.has(t.id) ? 'checked' : ''}></label>
        <div style="flex:1;min-width:0">
          <div class="cb-title"><strong>${esc(t.symbol)}</strong>
            <span class="ad-mode ad-${it.mode}">${it.mode.toUpperCase()}</span>
            <span class="cb-status ${statusCls}">${it.status}</span>
            ${it.playbook ? `<span class="badge badge-muted" style="font-size:10px">${esc(it.playbook)}</span>` : ''}</div>
          <div class="cb-sub">${it.entryDate} → ${it.exitDate || 'open'} · ${m.holdingDays ?? 0} days · ${esc(t.sector || '')}</div>
        </div>
        <div class="cb-nums"><div style="color:${tone(it.r)}">${calc.formatR(it.r)}</div><div style="color:${tone(it.pnl)};font-size:12px">${money(it.pnl)}</div></div>
      </div>
      <div class="cb-charts">
        <div><div class="cb-chart-head"><span>Entry chart</span><span data-cb-act="entry"></span></div><div class="cr-chart cb-slot" data-cb-slot="entry">Loading…</div></div>
        <div><div class="cb-chart-head"><span>Exit chart</span><span data-cb-act="exit"></span></div><div class="cr-chart cb-slot" data-cb-slot="exit">${it.status === 'Open' ? 'Saved automatically after the trade closes' : 'Loading…'}</div></div>
      </div>
      <div class="cb-extra"><span data-cb-adds></span></div>
      <div class="cb-bottom">
        <div class="cb-timeline"><div class="cb-h">Lifecycle</div>${tl || '<div class="cb-tl">—</div>'}</div>
        <div class="cb-notes"><div class="cb-h">Notes &amp; lessons</div>
          <textarea class="form-input" rows="4" data-cb-note="${t.id}" data-cb-mode="${it.mode}" placeholder="Why you took it, what went right or wrong, what to repeat…">${esc(it.notes)}</textarea>
          <div class="cb-saved" data-cb-saved="${t.id}"></div></div>
      </div>
    </div>`;
  }

  /** Draw a card's charts when it scrolls into view. */
  function _observe(list) {
    _observer?.disconnect();
    _observer = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      _observer.unobserve(e.target);
      _drawCard(e.target).catch(err => console.error('chartbook card', err));
    }), { rootMargin: '300px' });
    list.querySelectorAll('.cb-card').forEach(c => _observer.observe(c));
  }

  async function _snaps(tradeId) {
    if (!_snapCache[tradeId]) _snapCache[tradeId] = await db.getSnapshots(tradeId);
    return _snapCache[tradeId];
  }

  async function _drawCard(card) {
    const id = card.dataset.cbId;
    const it = _items.find(i => i.t.id === id);
    const snaps = await _snaps(id);
    const kind = ChartRender.kindOf;
    const entry = snaps.filter(s => kind(s) === 'entry').sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)))[0];
    const exit = snaps.find(s => kind(s) === 'exit');
    const adds = snaps.filter(s => kind(s) === 'add');
    for (const [slotName, sn] of [['entry', entry], ['exit', exit]]) {
      const slot = card.querySelector(`[data-cb-slot="${slotName}"]`);
      const act = card.querySelector(`[data-cb-act="${slotName}"]`);
      if (!slot) continue;
      if (!sn) {
        if (slotName === 'exit' && it?.status === 'Open') continue;
        slot.innerHTML = '<div class="cb-empty">No chart yet — use <strong>Build missing charts</strong></div>';
        continue;
      }
      slot.innerHTML = '';
      if (window.LightweightCharts) ChartRender.daily(slot, sn, { height: 380 });
      const i = snaps.indexOf(sn);
      act.innerHTML = `${sn.final ? '' : '<span class="cr-prov">provisional</span> '}<a href="#" data-cb-big="${i}">⤢ Enlarge${(sn.intraday || []).length ? ' / 1-min' : ''}</a>`;
    }
    card.querySelector('[data-cb-adds]').innerHTML = adds.map(a => `<a href="#" data-cb-big="${snaps.indexOf(a)}">1R add chart · ${a.entry_date}</a>`).join(' · ');
    card.querySelectorAll('[data-cb-big]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      const sn = snaps[Number(a.dataset.cbBig)];
      ChartRender.enlarge(sn, `${it?.t.symbol || ''} · ${ChartRender.KIND_LABEL[kind(sn)]} chart · ${sn.entry_date}`);
    }));
  }

  async function _saveNote(ta) {
    const id = ta.dataset.cbNote, text = ta.value.trim();
    if ((_notes[id] || '') === text) return;
    await db.saveChartbookNote(id, ta.dataset.cbMode, text);
    _notes[id] = text;
    const it = _items.find(i => i.t.id === id);
    if (it) it.notes = text;
    const s = document.querySelector(`[data-cb-saved="${id}"]`);
    if (s) { s.textContent = '✓ saved'; setTimeout(() => { s.textContent = ''; }, 2000); }
  }

  // ── Build missing charts (server runner, in batches) ──────────────────────
  async function _buildMissing(rebuild) {
    const btn = document.getElementById(rebuild ? 'cb-rebuild' : 'cb-build'), prog = document.getElementById('cb-progress');
    const rebuildBefore = rebuild ? new Date().toISOString() : undefined;
    btn.disabled = true;
    let total = 0, failed = 0;
    try {
      for (let round = 0; round < 60; round++) {
        prog.textContent = ` · building charts… ${total} saved`;
        const r = await fetch(`${APP_CONFIG.SUPABASE_URL}/functions/v1/tlm-runner`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'chartbook-backfill', rebuildBefore }),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `server runner ${r.status}`);
        total += out.saved || 0; failed += out.failed || 0;
        if (!out.remaining || (!out.saved && out.failed)) break;
      }
      app.toast(`Charts saved: ${total}${failed ? ` · ${failed} could not be built (no price data)` : ''}`, failed ? 'info' : 'success', 5000);
    } catch (e) {
      app.toast('Build missing charts: ' + e.message + (/404/.test(e.message) ? ' — deploy the latest functions first' : ''), 'error', 7000);
    } finally {
      btn.disabled = false; prog.textContent = '';
      _snapCache = {};
      _renderList();
    }
  }

  // ── Export ───────────────────────────────────────────────────────────────
  async function _export(format) {
    const all = _filtered();
    const items = _selected.size ? all.filter(i => _selected.has(i.t.id)) : all;
    if (!items.length) { app.toast('No trades to export', 'error'); return; }
    if (items.length > 60 && !confirm(`Export ${items.length} trades? This can take a minute. Tick cards to export fewer.`)) return;
    const prog = document.getElementById('cb-progress');
    const btns = ['cb-pdf', 'cb-docx'].map(id => document.getElementById(id));
    btns.forEach(b => { if (b) b.disabled = true; });
    try {
      const closed = items.filter(i => i.status !== 'Open');
      const wins = closed.filter(i => i.status === 'Win').length;
      const avgR = closed.length ? closed.reduce((s, i) => s + i.r, 0) / closed.length : 0;
      const dates = items.map(i => i.entryDate).sort();
      const meta = {
        subtitle: `${_f.mode === 'all' ? 'Real + paper' : _f.mode === 'real' ? 'Real trades' : 'Paper trades'} · entries ${dates[0]} to ${dates.at(-1)}`,
        summary: [['Trades', String(items.length)], ['Closed', `${closed.length} (${wins} wins / ${closed.length - wins} losses)`],
                  ['Average R (closed)', `${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`], ['Open', String(items.length - closed.length)]],
        generated: new Date().toLocaleDateString('en-GB'),
      };
      const res = await ChartbookExport.run(items, format, { meta, onProgress: (i, n) => { prog.textContent = ` · preparing ${Math.min(i + 1, n)} / ${n}…`; } });
      app.toast(`Downloaded ${res.name}`, 'success');
    } catch (e) {
      console.error('export', e);
      app.toast('Export failed: ' + e.message, 'error', 6000);
    } finally {
      btns.forEach(b => { if (b) b.disabled = false; });
      prog.textContent = '';
    }
  }

  return { init };
})();
window.ChartbookModule = ChartbookModule;
