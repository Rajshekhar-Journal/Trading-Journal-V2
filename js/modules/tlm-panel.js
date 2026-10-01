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
    return TLMEngine.stateFromTrade(trade, m.currentStop, TLMRules.DEFAULT_PARAMS);
  }

  function html(trade) {
    const s = stateOf(trade);
    if (!s) return '<div class="no-data" style="padding:12px">No lifecycle state — entry or initial stop missing.</div>';
    const pl = s.plan || TLMRules.targetPlan();
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
      <div style="font-size:13px;font-weight:600;margin:14px 0 6px">Entry-day charts</div>
      <div id="tlm-snaps-${trade.id}" style="font-size:12px;color:var(--text-muted)">Loading…</div>`;
  }

  /** Render stored entry-day snapshots as small candlestick charts with the trade levels. */
  async function loadSnapshots(trade) {
    const box = document.getElementById(`tlm-snaps-${trade.id}`);
    if (!box) return;
    const snaps = await db.getSnapshots(trade.id);
    if (!snaps.length) { box.textContent = 'No snapshot yet — saved automatically on the next engine cycle after an entry.'; return; }
    box.innerHTML = snaps.map(sn => `<div style="margin-bottom:10px"><div style="margin-bottom:4px">${sn.rule_id === 'LC-01' ? 'Entry' : '1R add'} · ${sn.entry_date} · fill ${inr(sn.levels?.fill)} × ${sn.levels?.qty ?? ''}</div><div id="snap-${sn.id}" style="height:220px"></div></div>`).join('');
    if (!window.LightweightCharts) return;
    for (const sn of snaps) {
      const el = document.getElementById(`snap-${sn.id}`);
      const chart = LightweightCharts.createChart(el, { height: 220, width: el.clientWidth || 400, layout: { background: { color: 'transparent' }, textColor: '#64748b', fontSize: 10 }, grid: { vertLines: { visible: false }, horzLines: { color: '#eef1f5' } }, timeScale: { borderVisible: false }, rightPriceScale: { borderVisible: false } });
      const series = chart.addCandlestickSeries({ upColor: '#10b981', downColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444', borderVisible: false });
      series.setData((sn.daily || []).map(c => ({ time: c.date, open: c.open, high: c.high, low: c.low, close: c.close })));
      const line = (price, color, title) => price && series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
      line(sn.levels?.fill, '#3b82f6', 'Fill');
      line(sn.levels?.initialStop, '#ef4444', 'SL');
      Object.entries(sn.levels?.targets || {}).forEach(([k, v]) => line(v, '#94a3b8', k.replace('T', '') + 'R'));
      chart.timeScale().fitContent();
    }
  }

  return { html, loadSnapshots, stateOf };
})();
window.TLMPanel = TLMPanel;
