/**
 * importer.js — Excel / CSV import UI for Watchlist and Positions.
 * Flow: ⬇ Template → fill in Excel → ⬆ Import → preview (✓ / ✗ per row with reasons) → Import valid rows.
 * Parsing/validation lives in js/import/import-rules.js; file reading/writing in js/import/xlsx-lite.js.
 */
const ImportModule = (() => {
  const R = () => window.ImportRules;
  let _ctx = null;   // { kind, rows (validated), onDone }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => (typeof calc !== 'undefined' && calc.formatNumber) ? calc.formatNumber(v) : Number(v).toFixed(2);

  // ── Template download ─────────────────────────────────────────────────────
  function downloadTemplate(kind) {
    const t = R().TEMPLATES[kind];
    const bytes = XlsxLite.writeXlsx(R().templateRows(kind), t.sheet, t.columns.map(c => c.width || 12));
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = t.file;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ── Help text per kind ────────────────────────────────────────────────────
  function _help(kind) {
    if (kind === 'watchlist') return `
      <ul class="imp-help">
        <li><b>Required:</b> Symbol, Trigger, Stop (Stop must be below Trigger).</li>
        <li><b>Optional:</b> Sector, RPT (blank = default RPT from Settings), Mode — <i>Real</i>, <i>Paper</i> or <i>Both</i> (blank = Both), Notes.</li>
        <li>Symbols as on NSE (e.g. <code>RELIANCE</code>); <code>NSE:</code> / <code>.NS</code> are stripped.</li>
        <li>The <code>EXAMPLE</code> row in the template is ignored. Symbols already on the watchlist are skipped unless you tick “update”.</li>
      </ul>`;
    return `
      <ul class="imp-help">
        <li><b>Required:</b> Symbol, Entry Date, Entry Price, Qty, Initial Stop. Long positions only.</li>
        <li><b>Dates:</b> DD-MM-YYYY, DD/MM/YYYY, 05-Sep-2026, YYYY-MM-DD or an Excel date cell.</li>
        <li><b>Stage:</b> <i>Entry</i> (blank), <i>1R</i> (1R add already done — Qty is the total) or <i>2R</i> (stop already locked).
          The stop is raised to at least what that stage's rule sets; later targets (5R, 10R) fire live as usual.</li>
        <li><b>Optional:</b> Current Stop, Exchange (NSE/BSE), Type (Equity/Intraday/Futures), Sector, Playbook (name), Charges (blank = calculated), Notes.</li>
        <li>The <code>EXAMPLE</code> row is ignored. Symbols that are already open positions are skipped.</li>
      </ul>`;
  }

  // ── Open the import dialog ────────────────────────────────────────────────
  /** @param kind 'watchlist' | 'positions'; @param onDone async callback after a successful import */
  function open(kind, onDone) {
    _ctx = { kind, rows: [], onDone };
    const title = kind === 'watchlist' ? 'Import Watchlist from Excel' : 'Import Positions from Excel';
    const content = `
      <div class="imp-wrap">
        ${_help(kind)}
        <div class="imp-pick">
          <input type="file" id="imp-file" accept=".xlsx,.csv" class="form-input">
          <button class="btn btn-secondary btn-sm" type="button" onclick="ImportModule.downloadTemplate('${kind}')">⬇ Template</button>
        </div>
        ${kind === 'watchlist' ? `<label class="imp-opt"><input type="checkbox" id="imp-update"> Update symbols already on the watchlist (instead of skipping)</label>` : ''}
        <div id="imp-preview" class="imp-preview"></div>
      </div>`;
    app.openModal(title, content, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'import', label: 'Import valid rows', class: 'btn-primary', onClick: _commit },
    ]);
    document.getElementById('modal-container')?.classList.add('modal-wide');
    _setImportBtn(0);
    document.getElementById('imp-file')?.addEventListener('change', _onFile);
    document.getElementById('imp-update')?.addEventListener('change', () => _ctx?.sheet && _validate());
  }

  function _setImportBtn(n) {
    const b = document.getElementById('modal-action-import');
    if (!b) return;
    b.disabled = !n;
    b.textContent = n ? `Import ${n} row${n > 1 ? 's' : ''}` : 'Import valid rows';
  }

  async function _onFile(e) {
    const file = e.target.files?.[0];
    const box = document.getElementById('imp-preview');
    if (!file || !box) return;
    box.innerHTML = '<div class="imp-msg">⏳ Reading file…</div>';
    try {
      _ctx.sheet = await XlsxLite.readFile(file);
      await _validate();
    } catch (err) {
      console.error('Import read error:', err);
      _ctx.sheet = null;
      box.innerHTML = `<div class="imp-msg imp-err">✗ ${esc(err.message || 'Could not read the file')}</div>`;
      _setImportBtn(0);
    }
  }

  // ── Validate + preview ────────────────────────────────────────────────────
  async function _validate() {
    const box = document.getElementById('imp-preview');
    if (_ctx.kind === 'watchlist') {
      const existing = await db.getWatchlist();
      const res = R().validateWatchlist(_ctx.sheet, existing, { updateExisting: !!document.getElementById('imp-update')?.checked });
      if (res.error) return _fail(box, res.error);
      _ctx.rows = res.rows;
      const defRpt = await TLMRunner.defaultRpt();
      box.innerHTML = _summary(res) + _table(['Row', '', 'Symbol', 'Trigger', 'Stop', 'RPT', 'Mode', 'Result'], res.rows.map(r => {
        const it = r.item || {};
        return [r.row, _icon(r), esc(r.symbol || '—'),
          it.trigger_price ? num(it.trigger_price) : '', it.stop_loss ? num(it.stop_loss) : '',
          it.symbol ? (it.rpt ? num(it.rpt) : `<span class="imp-muted">${num(defRpt)} (default)</span>`) : '',
          it.mode ? esc(it.mode) : '', _reasons(r)];
      }));
    } else {
      const [open, playbooks, settings] = await Promise.all([db.getOpenTrades(), db.getPlaybooks(), db.getSettings()]);
      const res = R().validatePositions(_ctx.sheet, open, { playbooks: (playbooks || []).filter(p => p.status === 'Active') });
      if (res.error) return _fail(box, res.error);
      const params = TLMRunner.paramsFrom(settings);
      res.rows.forEach(r => {
        if (!r.pos) return;
        const plan = R().planImportState(r.pos, params, Date.now());
        if (!plan.state) { r.ok = false; r.action = 'error'; r.errors.push('Could not build lifecycle state'); return; }
        r.plan = plan;
        if (plan.raised) r.warnings.push(`Stop raised to ₹${num(plan.stop)} by the ${TLMRules.STAGE_LABELS[r.pos.stage]} rule`);
      });
      _ctx.rows = res.rows;
      _ctx.settings = settings;
      box.innerHTML = _summary(res) + _table(['Row', '', 'Symbol', 'Date', 'Entry', 'Qty', 'Stop', 'Stage', 'Result'], res.rows.map(r => {
        const p = r.pos || {};
        return [r.row, _icon(r), esc(r.symbol || '—'), p.date ? `<span class="imp-nowrap">${p.date.split('-').reverse().join('-')}</span>` : '', p.price ? num(p.price) : '', p.qty || '',
          r.plan ? num(r.plan.stop) : '', r.pos ? esc(TLMRules.STAGE_LABELS[p.stage]) : '', _reasons(r)];
      }));
    }
    _setImportBtn(_ctx.rows.filter(r => r.ok).length);
  }

  function _fail(box, msg) {
    _ctx.rows = [];
    box.innerHTML = `<div class="imp-msg imp-err">✗ ${esc(msg)}</div>`;
    _setImportBtn(0);
  }

  const _icon = r => r.ok ? '<span class="imp-ok">✓</span>' : r.action === 'skip' ? '<span class="imp-skip">–</span>' : '<span class="imp-bad">✗</span>';
  const _reasons = r => [...r.errors.map(e => `<div class="imp-bad">${esc(e)}</div>`), ...r.warnings.map(w => `<div class="imp-warn">${esc(w)}</div>`)].join('')
    || `<span class="imp-ok">${r.action === 'update' ? 'Update' : 'Ready'}</span>`;

  function _summary(res) {
    const ok = res.rows.filter(r => r.ok).length, skip = res.rows.filter(r => r.action === 'skip').length;
    const bad = res.rows.filter(r => r.action === 'error').length;
    const unk = (res.unknownColumns || []).length ? `<div class="imp-muted">Ignored columns: ${res.unknownColumns.map(esc).join(', ')}</div>` : '';
    if (!res.rows.length) return `<div class="imp-msg imp-err">No data rows found under the header.</div>${unk}`;
    return `<div class="imp-sum"><span class="imp-ok">✓ ${ok} ready</span><span class="imp-skip">– ${skip} skipped</span><span class="imp-bad">✗ ${bad} with errors</span></div>${unk}`;
  }

  function _table(head, rows) {
    return `<div class="imp-table-wrap"><table class="data-table imp-table"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  // ── Commit ────────────────────────────────────────────────────────────────
  async function _commit() {
    const good = (_ctx?.rows || []).filter(r => r.ok);
    if (!good.length) { app.toast('Nothing to import', 'error'); return; }
    const btn = document.getElementById('modal-action-import');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    let done = 0;
    const failed = [];
    for (const r of good) {
      try {
        if (_ctx.kind === 'watchlist') await db.saveWatchlistItem({ ...r.item });
        else await db.saveTrade(_buildTrade(r.pos, r.plan, _ctx.settings));
        done++;
      } catch (err) { failed.push(`${r.symbol}: ${err.message}`); }
    }
    const onDone = _ctx.onDone;
    app.closeModal();
    document.getElementById('modal-container')?.classList.remove('modal-wide');
    if (failed.length) app.toast(`Imported ${done}; ${failed.length} failed — ${failed[0]}`, 'error');
    else app.toast(`Imported ${done} ${_ctx.kind === 'watchlist' ? 'watchlist item' : 'position'}${done > 1 ? 's' : ''}`, 'success');
    _ctx = null;
    if (onDone) await onDone();
  }

  /** Same trade shape as the New Trade modal (positions.js). */
  function _buildTrade(p, plan, settings) {
    const charges = p.charges !== null ? p.charges
      : Number(calc.getZerodhaCharges(p.tradeType, p.price * p.qty, 0, settings, p.exchange)?.total || 0);
    const stopRevisions = [{ id: db.generateId('sr'), date: p.date, oldStop: 0, newStop: p.initialStop, actionSource: 'Manual', notes: 'Initial stop (imported)' }];
    if (plan.stop > p.initialStop) stopRevisions.push({ id: db.generateId('sr'), date: new Date().toISOString().slice(0, 10), oldStop: p.initialStop, newStop: plan.stop, actionSource: 'Manual', notes: 'Current stop (imported)' });
    const sector = p.sector || 'Other';
    return {
      id: db.generateId('tr'), symbol: p.symbol, sector, tradeType: p.tradeType, direction: 'Long', exchange: p.exchange,
      playbookId: p.playbookId, playbookVersion: p.playbookVersion,
      initialStop: p.initialStop, currentStop: plan.stop, rpt: Math.abs((p.price - p.initialStop) * plan.state.firstQty),
      tlmState: plan.state,
      entries: [{ id: db.generateId('en'), date: p.date, price: p.price, qty: p.qty, charges: Math.round(charges * 100) / 100, notes: p.notes || 'Imported from Excel' }],
      pyramids: [], stopRevisions,
      partialExits: [], finalExit: null, notes: [], alerts: [],
      ruleFollowed: true, reviewStatus: 'Pending', rating: 0,
      chartLink: `https://www.tradingview.com/chart/?symbol=${p.exchange}:${p.symbol}`, tags: [sector],
      cmp: p.price, createdAt: p.date, closedAt: null,
    };
  }

  return { open, downloadTemplate, _buildTrade };
})();
window.ImportModule = ImportModule;
