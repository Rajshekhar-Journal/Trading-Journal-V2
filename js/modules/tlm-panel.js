/**
 * tlm-panel.js — shared Trade Lifecycle panel for Positions (real) and Paper Trades.
 * Shows stage, targets, hard stop, tranches and the entry-day chart snapshots.
 */
const TLMPanel = (() => {
  const { STAGES } = TLMRules;
  const inr = v => v ? '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  /** Lifecycle state of a trade (stored, or derived for trades opened before v3.0). */
  function stateOf(trade) {
    if (trade.tlmState) return trade.tlmState;
    const m = calc.getTradeMetrics(trade);
    return TLMEngine.stateFromTrade(trade, m.currentStop, TLMRunner.cachedParams());
  }

  function html(trade) {
    const s = stateOf(trade);
    if (!s) return '<div class="no-data" style="padding:12px">No lifecycle state — entry or initial stop missing.</div>';
    const rules = TLMStrategies.isRules(s);
    const pl = TLMRules.planOf(s);
    const cell = (k, v, hit) => `<div class="tlm-cell ${hit ? 'hit' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const stratName = rules ? s.spec.name : (TLMStrategies.STRATEGY_A.name);
    const stratHtml = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0 4px">
        <div style="font-size:12px"><span style="color:var(--text-muted)">Strategy</span> <strong>${stratName}</strong></div>
        <button class="btn btn-secondary btn-sm" onclick="TLMPanel.changeStrategy('${trade.id}')">Change strategy</button></div>`
      + (rules ? `<ul style="margin:4px 0 8px 18px;padding:0;font-size:12px;color:var(--text-muted)">${TLMStrategies.describe(s.spec).map(t => `<li>${t}</li>`).join('')}</ul>` : '');
    const tr = (s.tranches || []).map(t =>
      `<tr><td>${pl[t.id] ? pl[t.id].r + 'R' : t.id} tranche</td><td class="font-mono">${t.qty}</td><td class="font-mono">${inr(t.trail)}</td><td>${t.status}</td></tr>`).join('');
    return `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:13px;font-weight:600">Trade lifecycle <span class="tlm-stage">${TLMRules.stageLabel(s)}</span></div>
        <div style="font-size:11px;color:var(--text-muted)">Rules v${s.rulesVersion} · 1R = ${inr(s.r)}</div>
      </div>
      ${stratHtml}
      ${rules ? `<div class="tlm-grid">
        ${s.spec.add.on ? cell(`${s.spec.add.atR}R · add`, inr(s.entryPrice + s.spec.add.atR * s.r), s.stage >= STAGES.R1) : ''}
        ${s.spec.partial.on ? cell(`${s.spec.partial.atR}R · sell ${s.spec.partial.pct}%`, inr(s.entryPrice + s.spec.partial.atR * s.r), !!s.partialDone) : ''}
        ${s.spec.timeExit.on ? cell(`Time exit · ${s.spec.timeExit.days} days`, `+${s.spec.timeExit.minR}R ${inr(s.entryPrice + s.spec.timeExit.minR * s.r)}`) : ''}
        ${s.spec.trail.type !== 'none' ? cell('Trail', s.spec.trail.type === 'ema' ? `${s.spec.trail.period} EMA −${s.spec.trail.bufferPct}%` : `${s.spec.trail.pct}% below high close`, !s.spec.trail.afterPartial || !!s.partialDone) : ''}
      </div>` : `<div class="tlm-grid">
        ${cell(`${pl.T1.r}R · ${pl.T1.on ? 'add' : 'off'}`, inr(s.targets.T1), s.stage >= STAGES.R1)}
        ${cell(`${pl.T2.r}R · ${pl.T2.on ? 'lock' : 'off'}`, inr(s.targets.T2), s.stage >= STAGES.R2)}
        ${cell(`${pl.T5.r}R · ${pl.T5.on ? pl.T5.pct + '% trail' : 'off'}`, inr(s.targets.T5), s.stage >= STAGES.R5)}
        ${cell(`${pl.T10.r}R · ${pl.T10.on ? pl.T10.pct + '% trail' : 'off'}`, inr(s.targets.T10), s.stage >= STAGES.R10)}
      </div>`}
      <div class="tlm-grid">
        ${cell('Hard stop', inr(s.hardStop))}
        ${cell('Initial stop', inr(s.initialStop))}
        ${cell('Entry fill', inr(s.entryPrice))}
        ${cell('Qty per leg', s.firstQty)}
      </div>
      ${tr ? `<table class="data-table" style="font-size:12px;margin-top:6px"><thead><tr><th>Trail</th><th>Qty</th><th>Trail stop</th><th>Status</th></tr></thead><tbody>${tr}</tbody></table>` : ''}
      <div style="font-size:13px;font-weight:600;margin:14px 0 6px">Trade charts</div>
      <div id="tlm-snaps-${trade.id}" style="font-size:12px;color:var(--text-muted)">Loading…</div>`;
  }

  /** Render the trade's saved charts (entry, 1R add, exit) — same renderer as the Chartbook. */
  async function loadSnapshots(trade) {
    const box = document.getElementById(`tlm-snaps-${trade.id}`);
    if (!box) return;
    const order = { entry: 0, add: 1, exit: 2 };
    const snaps = (await db.getSnapshots(trade.id))
      .sort((a, b) => (order[ChartRender.kindOf(a)] - order[ChartRender.kindOf(b)]) || String(a.entry_date).localeCompare(String(b.entry_date)));
    if (!snaps.length) {
      box.innerHTML = 'No chart yet — the server saves one on the next cycle after an entry, and the final chart after the close. Older trades: Chartbook → <strong>Build missing charts</strong>.';
      return;
    }
    _snaps[trade.id] = snaps;
    box.innerHTML = snaps.map((sn, i) => {
      const lv = sn.levels || {};
      const kind = ChartRender.kindOf(sn);
      const what = kind === 'exit'
        ? `Exit · ${sn.entry_date}${lv.result ? ` · ${calc.formatR(lv.result.r)}` : ''}`
        : `${ChartRender.KIND_LABEL[kind]} · ${sn.entry_date} · fill ${inr(lv.fill)} × ${lv.qty ?? ''}`;
      return `<div class="cr-block">
        <div class="cr-head"><span>${what}${sn.final ? '' : ' <span class="cr-prov" title="Taken during the session; replaced by the final chart after the close">provisional</span>'}</span>
          <span><button class="btn btn-secondary btn-sm" onclick="TLMPanel._enlarge('${trade.id}', ${i})">⤢ Enlarge${(sn.intraday || []).length ? ' / 1-min' : ''}</button></span></div>
        <div id="snap-${trade.id}-${i}" class="cr-chart"></div>${ChartRender.legendHtml(sn)}
      </div>`;
    }).join('');
    if (!window.LightweightCharts) return;
    snaps.forEach((sn, i) => {
      const el = document.getElementById(`snap-${trade.id}-${i}`);
      if (el) ChartRender.daily(el, sn, { height: 360 });
    });
  }

  /** Move an open trade to another strategy; what already happened (adds, partial exits, stop) is kept. */
  async function changeStrategy(tradeId) {
    const paper = String(tradeId).startsWith('pt');
    const trade = paper ? await db.getPaperTradeById(tradeId) : await db.getTradeById(tradeId);
    if (!trade) return;
    const settings = await db.getSettings();
    const cur = TLMStrategies.strategyOf(trade.tlmState);
    const all = TLMStrategies.list(settings);
    const opts = all.map(x => `<option value="${x.id}"${x.id === cur ? ' selected' : ''}>${x.name}</option>`).join('');
    const info = id => (TLMStrategies.describe(all.find(x => x.id === id)) || []).map(t => `<li>${t}</li>`).join('');
    window._tlmStratInfo = id => { const el = document.getElementById('tlm-strat-info'); if (el) el.innerHTML = info(id); };
    app.openModal(`Change strategy — ${trade.symbol}`, `
      <p style="font-size:13px;color:var(--text-muted);margin-top:0">The position keeps its entries, adds, partial exits and stop. From now on the new strategy's rules decide what happens next. Strategy A tranche trails that were open are not carried over.</p>
      <div class="form-group"><label class="form-label">Strategy</label><select class="form-select" id="tlm-strat-pick" onchange="_tlmStratInfo(this.value)">${opts}</select></div>
      <ul id="tlm-strat-info" style="font-size:12px;color:var(--text-muted);margin:6px 0 0 18px;padding:0">${info(cur)}</ul>`, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save', label: 'Switch', class: 'btn-primary', onClick: async () => {
          const id = document.getElementById('tlm-strat-pick').value;
          if (id === cur) { app.closeModal(); return; }
          const m = calc.getTradeMetrics(trade);
          const state = TLMStrategies.switchState({ trade, strategyId: id, params: TLMRunner.paramsFrom(settings), settings, now: Date.now() });
          if (!state) { app.toast('Cannot switch: entry or initial stop is missing', 'error'); return; }
          const updated = { ...trade, tlmState: state };
          await (paper ? db.savePaperTrade(updated) : db.saveTrade(updated));
          app.closeModal();
          app.toast(`Now following ${all.find(x => x.id === id).name}`, 'success');
          if (paper) { await PaperTradesModule.init(); PaperTradesModule._open(tradeId); }
          else { await positionsModule.init(); positionsModule._onRowClick(tradeId); }
      }}
    ]);
  }

  const _snaps = {};
  function _enlarge(tradeId, i) {
    const sn = _snaps[tradeId]?.[i];
    if (sn) ChartRender.enlarge(sn, `${ChartRender.KIND_LABEL[ChartRender.kindOf(sn)]} chart · ${sn.entry_date}`);
  }

  return { html, loadSnapshots, stateOf, changeStrategy, _enlarge };
})();
window.TLMPanel = TLMPanel;
