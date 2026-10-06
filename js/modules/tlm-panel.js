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
    const pl = TLMRules.planOf(s);
    const cell = (k, v, hit) => `<div class="tlm-cell ${hit ? 'hit' : ''}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const tr = (s.tranches || []).map(t =>
      `<tr><td>${pl[t.id] ? pl[t.id].r + 'R' : t.id} tranche</td><td class="font-mono">${t.qty}</td><td class="font-mono">${inr(t.trail)}</td><td>${t.status}</td></tr>`).join('');
    return `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:13px;font-weight:600">Trade lifecycle <span class="tlm-stage">${TLMRules.stageLabel(s)}</span></div>
        <div style="font-size:11px;color:var(--text-muted)">Rules v${s.rulesVersion} · 1R = ${inr(s.r)}</div>
      </div>
      <div class="tlm-grid">
        ${cell(`${pl.T1.r}R · ${pl.T1.on ? 'add' : 'off'}`, inr(s.targets.T1), s.stage >= STAGES.R1)}
        ${cell(`${pl.T2.r}R · ${pl.T2.on ? 'lock' : 'off'}`, inr(s.targets.T2), s.stage >= STAGES.R2)}
        ${cell(`${pl.T5.r}R · ${pl.T5.on ? pl.T5.pct + '% trail' : 'off'}`, inr(s.targets.T5), s.stage >= STAGES.R5)}
        ${cell(`${pl.T10.r}R · ${pl.T10.on ? pl.T10.pct + '% trail' : 'off'}`, inr(s.targets.T10), s.stage >= STAGES.R10)}
      </div>
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
      if (el) ChartRender.daily(el, sn, { height: 300 });
    });
  }

  const _snaps = {};
  function _enlarge(tradeId, i) {
    const sn = _snaps[tradeId]?.[i];
    if (sn) ChartRender.enlarge(sn, `${ChartRender.KIND_LABEL[ChartRender.kindOf(sn)]} chart · ${sn.entry_date}`);
  }

  return { html, loadSnapshots, stateOf, _enlarge };
})();
window.TLMPanel = TLMPanel;
