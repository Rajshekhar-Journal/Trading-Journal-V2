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
    const stratName = rules ? String(s.spec.name).split(' — ')[0] : (TLMStrategies.STRATEGY_A.name);
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
      ${rules ? (() => { const sp = TLMStrategies.normalise(s.spec), lv = r => inr(s.entryPrice + r * s.r), t = TLMStrategies.activeTranche(s); return `<div class="tlm-grid">
        ${sp.add.on ? cell(`${sp.add.atR}R · add`, lv(sp.add.atR), s.stage >= STAGES.R1) : ''}
        ${sp.stopToCost.on ? cell(`${sp.stopToCost.atR}R · stop to cost`, lv(sp.stopToCost.atR), !!s.costDone) : ''}
        ${sp.partial.on ? cell(`${sp.partial.atR}R · ${sp.partial.mode === 'trail' ? `${sp.partial.pct}% tranche` : `sell ${sp.partial.pct}%`}`, lv(sp.partial.atR), !!s.partialDone) : ''}
        ${sp.trail.type !== 'none' ? cell('Trail', sp.trail.type === 'ema' ? (sp.trail.confirm ? `${sp.trail.period} EMA −${sp.trail.deepPct}% / warning` : `${sp.trail.period} EMA −${sp.trail.bufferPct}%`) : `${sp.trail.pct}% below high close`, !sp.trail.afterPartial || !!s.partialDone) : ''}
        ${sp.timeExit.on ? cell(`Time exit · ${sp.timeExit.days} days`, `+${sp.timeExit.minR}R ${lv(sp.timeExit.minR)}`) : ''}
        ${s.protStop ? cell(`Protective trail · ${sp.stopToCost.holdMin} min`, inr(s.protStop), true) : ''}
        ${t ? cell(`Profit-booking stop · ${t.qty} sh`, inr(t.trail), true) : ''}
        ${s.warnLow ? cell('EMA warning low', inr(s.warnLow), true) : ''}
      </div>`; })() : `<div class="tlm-grid">
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

  /** Move an open trade to another strategy; the user ticks what this trade has already done. */
  async function changeStrategy(tradeId) {
    const paper = String(tradeId).startsWith('pt');
    const trade = paper ? await db.getPaperTradeById(tradeId) : await db.getTradeById(tradeId);
    if (!trade) return;
    const settings = await db.getSettings();
    const params = TLMRunner.paramsFrom(settings);
    const cur = TLMStrategies.strategyOf(trade.tlmState);
    const all = TLMStrategies.list(settings);
    const m = calc.getTradeMetrics(trade);
    const first = (trade.entries || [])[0] || {};
    const R1 = Number(first.price) - Number(trade.initialStop);
    const lv = r => R1 > 0 ? ` (${inr(Number(first.price) + r * R1)})` : '';
    const opts = all.map(x => `<option value="${x.id}"${x.id === cur ? ' selected' : ''}>${x.name}</option>`).join('');
    const box = (id, on, label) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:13px"><input type="checkbox" id="sw-${id}" ${on ? 'checked' : ''} style="margin-top:3px" onchange="TLMPanel._swToggle()"> <span>${label}</span></label>`;

    const render = id => {
      const sp = all.find(x => x.id === id);
      const d = TLMStrategies.detectDone(trade, id, settings);
      const info = TLMStrategies.describe(sp, params).map(t => `<li>${t}</li>`).join('');
      let checks;
      if (sp.kind === 'lifecycle') {
        const t = TLMRules.targetPlan(params);
        checks = box('a1', d.stage >= 2, `${t.T1.r}R reached — add done${lv(t.T1.r)}`)
          + box('a2', d.stage >= 3, `${t.T2.r}R reached — stop locked${lv(t.T2.r)}`)
          + box('a3', d.stage >= 4, `${t.T5.r}R reached — first trail started${lv(t.T5.r)}`)
          + box('a4', d.stage >= 5, `${t.T10.r}R reached — second trail started${lv(t.T10.r)}`)
          + '<div style="font-size:11.5px;color:var(--text-muted)">Ticked steps are skipped. Open trails are not carried over; the next target starts a new one.</div>';
      } else {
        const n = TLMStrategies.normalise(sp), trail = n.partial.mode === 'trail';
        checks = (n.add.on ? box('add', d.add, `${n.add.atR}R reached — add done${lv(n.add.atR)}`) : '')
          + (n.stopToCost.on ? box('cost', d.cost, `${n.stopToCost.atR}R reached — stop already at cost${lv(n.stopToCost.atR)}`) : '')
          + (n.partial.on ? box('partial', d.partial, `${n.partial.atR}R reached — ${trail ? 'profit-booking tranche started' : `${n.partial.pct}% already sold`}${lv(n.partial.atR)}`) : '')
          + (n.partial.on && trail ? `<div id="sw-tr" style="margin-left:24px;${d.partial ? '' : 'display:none'}">
              ${box('sold', d.trancheSold, 'Tranche already sold')}
              <div id="sw-tr-in" style="font-size:13px;${d.trancheSold ? 'display:none' : ''}">Tranche qty <input class="form-input" type="number" id="sw-tqty" min="1" value="${Math.floor(m.openQty * n.partial.pct / 100)}" style="width:90px;display:inline-block">
                · profit-booking stop ₹ <input class="form-input" type="number" step="0.05" id="sw-tstop" value="${Number(m.currentStop) || ''}" style="width:110px;display:inline-block"></div></div>` : '')
          + '<div style="font-size:11.5px;color:var(--text-muted)">Ticked steps are skipped. Unticked steps act when price reaches them.</div>';
      }
      document.getElementById('sw-info').innerHTML = info;
      document.getElementById('sw-checks').innerHTML = checks;
    };
    TLMPanel._swRender = () => render(document.getElementById('tlm-strat-pick').value);

    app.openModal(`Change strategy — ${trade.symbol}`, `
      <p style="font-size:13px;color:var(--text-muted);margin-top:0">The position keeps its entries, adds, partial exits and stop (₹${calc.formatNumber(m.currentStop)}, open qty ${m.openQty}). From now on the chosen strategy decides what happens next.</p>
      <div class="form-group"><label class="form-label">Strategy</label><select class="form-select" id="tlm-strat-pick" onchange="TLMPanel._swRender()">${opts}</select></div>
      <ul id="sw-info" style="font-size:12px;color:var(--text-muted);margin:6px 0 10px 18px;padding:0"></ul>
      <div style="font-weight:600;font-size:13px;margin-bottom:2px">Already completed on this trade</div>
      <div id="sw-checks"></div>`, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save', label: 'Switch', class: 'btn-primary', onClick: async () => {
          const id = document.getElementById('tlm-strat-pick').value;
          const sp = all.find(x => x.id === id);
          const c = k => !!document.getElementById('sw-' + k)?.checked;
          let done;
          if (sp.kind === 'lifecycle') done = { stage: 1 + ['a1', 'a2', 'a3', 'a4'].filter(c).length };
          else {
            done = { add: c('add'), cost: c('cost'), partial: c('partial'), trancheSold: c('sold'),
              trancheQty: parseFloat(document.getElementById('sw-tqty')?.value), trancheStop: parseFloat(document.getElementById('sw-tstop')?.value) };
            if (done.partial && TLMStrategies.normalise(sp).partial.mode === 'trail' && !done.trancheSold && !(done.trancheQty > 0 && done.trancheQty < m.openQty && done.trancheStop > 0)) {
              app.toast('Enter the tranche quantity (less than the open quantity) and its stop, or tick "Tranche already sold"', 'error'); return; }
          }
          const state = TLMStrategies.switchState({ trade, strategyId: id, params, settings, now: Date.now(), done });
          if (!state) { app.toast('Cannot switch: entry or initial stop is missing', 'error'); return; }
          await (paper ? db.savePaperTrade({ ...trade, tlmState: state }) : db.saveTrade({ ...trade, tlmState: state }));
          app.closeModal();
          app.toast(`Now following ${sp.name.split(' — ')[0]}`, 'success');
          if (paper) { await PaperTradesModule.init(); PaperTradesModule._open(tradeId); }
          else { await positionsModule.init(); positionsModule._onRowClick(tradeId); }
      }}
    ]);
    render(cur);
  }

  /** Checklist: show the tranche fields only when "tranche started" is ticked and not sold. */
  function _swToggle() {
    const p = document.getElementById('sw-partial'), tr = document.getElementById('sw-tr'), sold = document.getElementById('sw-sold'), inp = document.getElementById('sw-tr-in');
    if (tr) tr.style.display = p && p.checked ? '' : 'none';
    if (inp) inp.style.display = sold && sold.checked ? 'none' : '';
  }

  const _snaps = {};
  function _enlarge(tradeId, i) {
    const sn = _snaps[tradeId]?.[i];
    if (sn) ChartRender.enlarge(sn, `${ChartRender.KIND_LABEL[ChartRender.kindOf(sn)]} chart · ${sn.entry_date}`);
  }

  return { html, loadSnapshots, stateOf, changeStrategy, _swToggle, _swRender: null, _enlarge };
})();
window.TLMPanel = TLMPanel;
