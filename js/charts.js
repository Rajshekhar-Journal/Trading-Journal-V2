/**
 * charts.js — Chart.js helper wrappers
 */
const charts = (() => {
  const _instances = {};

  const COLORS = {
    primary: '#5b6af0', success: '#22c55e', danger: '#ef4444',
    warning: '#f59e0b', navy: '#1a1f36', muted: '#94a3b8',
    successBg: 'rgba(34,197,94,0.12)', dangerBg: 'rgba(239,68,68,0.12)',
    primaryBg: 'rgba(91,106,240,0.12)', gridLine: 'rgba(0,0,0,0.05)'
  };

  const BASE_FONT = { family: 'Inter, sans-serif', size: 12, color: '#64748b' };

  function _destroy(id) {
    if (_instances[id]) { try { _instances[id].destroy(); } catch(e){} delete _instances[id]; }
  }

  function _baseOptions(overrides = {}) {
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#1a1f36', titleFont: { ...BASE_FONT, size: 13, weight: '600' }, bodyFont: BASE_FONT, padding: 10, cornerRadius: 8 }
      },
      scales: {
        x: { grid: { color: COLORS.gridLine }, ticks: { font: BASE_FONT, color: '#94a3b8' } },
        y: { grid: { color: COLORS.gridLine }, ticks: { font: BASE_FONT, color: '#94a3b8' } }
      },
      ...overrides
    };
  }

  function renderLineChart(canvasId, labels, data, label = '', color = COLORS.primary) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    _instances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label, data, borderColor: color, backgroundColor: color.replace(')', ',0.08)').replace('rgb', 'rgba'),
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.3
        }]
      },
      options: _baseOptions({
        plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (ctx) => ` ${calc.formatCurrency(ctx.raw)}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: BASE_FONT, color: '#94a3b8' } },
          y: { grid: { color: COLORS.gridLine }, ticks: { callback: v => calc.formatCurrency(v), font: BASE_FONT, color: '#94a3b8' } }
        }
      })
    });
  }

  function renderBubbleChart(canvasId, trades) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    const datasets = trades.map(t => {
      const m = calc.getTradeMetrics(t);
      const isWin = m.realizedPnl > 0;
      return {
        label: t.symbol,
        data: [{ x: Math.abs(m.currentRisk || m.initialRPT || 10000), y: m.realizedPnl, r: Math.max(4, Math.min(20, Math.abs(m.profitR) * 3 + 4)) }],
        backgroundColor: isWin ? 'rgba(34,197,94,0.6)' : 'rgba(239,68,68,0.6)',
        borderColor: isWin ? COLORS.success : COLORS.danger, borderWidth: 1
      };
    });
    _instances[canvasId] = new Chart(ctx, {
      type: 'bubble',
      data: { datasets },
      options: _baseOptions({
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: Risk ₹${Math.round(ctx.raw.x).toLocaleString('en-IN')}, P&L ₹${Math.round(ctx.raw.y).toLocaleString('en-IN')}` } } },
        scales: {
          x: { title: { display: true, text: 'Risk (₹)', font: BASE_FONT }, grid: { color: COLORS.gridLine }, ticks: { font: BASE_FONT } },
          y: { title: { display: true, text: 'P&L (₹)', font: BASE_FONT }, grid: { color: COLORS.gridLine }, ticks: { callback: v => calc.formatCurrency(v), font: BASE_FONT } }
        }
      })
    });
  }

  function renderBarChart(canvasId, labels, data, colors, yLabel = '') {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    const bgColors = Array.isArray(colors) ? colors : data.map(v => v >= 0 ? COLORS.successBg : COLORS.dangerBg);
    const borderColors = Array.isArray(colors) && typeof colors[0] === 'string' ? colors : data.map(v => v >= 0 ? COLORS.success : COLORS.danger);
    _instances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: bgColors, borderColor: borderColors, borderWidth: 1.5, borderRadius: 4 }] },
      options: _baseOptions({
        scales: { x: { grid: { display: false }, ticks: { font: BASE_FONT } }, y: { grid: { color: COLORS.gridLine }, ticks: { callback: v => yLabel === '₹' ? calc.formatCurrency(v) : v, font: BASE_FONT } } }
      })
    });
  }

  function renderDoughnutChart(canvasId, labels, data, colors) {
    _destroy(canvasId);
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    _instances[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: BASE_FONT, padding: 12 } } } }
    });
  }

  function renderEquityCurve(canvasId, capitalTxns, closedTrades) {
    const dailyPnl = calc.getDailyPnl(closedTrades);
    const netDep = calc.getNetDeposits(capitalTxns);
    const labels = dailyPnl.map(d => d.date.substring(5));
    const data = dailyPnl.map(d => netDep + d.cumPnl);
    renderLineChart(canvasId, labels, data, 'Equity', COLORS.primary);
  }

  function renderMonthlyHeatmap(containerId, closedTrades) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const monthly = calc.getMonthlyPnl(closedTrades);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const years = [...new Set(Object.keys(monthly).map(k => k.split('-')[0]))].sort();
    let html = `<table class="heatmap-table"><thead><tr><th></th>${months.map(m=>`<th>${m}</th>`).join('')}</tr></thead><tbody>`;
    years.forEach(y => {
      html += `<tr><td class="heatmap-year">${y}</td>`;
      months.forEach((_, mi) => {
        const key = `${y}-${String(mi+1).padStart(2,'0')}`;
        const val = monthly[key]?.pnl || null;
        if (val === null) { html += `<td class="heatmap-cell empty"></td>`; return; }
        const cls = val > 0 ? 'pos' : val < 0 ? 'neg' : 'zero';
        const intensity = Math.min(100, Math.abs(val) / 20000 * 100);
        html += `<td class="heatmap-cell ${cls}" style="--intensity:${intensity}%" title="${calc.formatCurrency(val)}">${calc.formatCurrency(val)}</td>`;
      });
      html += `</tr>`;
    });
    html += `</tbody></table>`;
    container.innerHTML = html;
  }

  function destroyAll() { Object.keys(_instances).forEach(_destroy); }

  return { renderLineChart, renderBubbleChart, renderBarChart, renderDoughnutChart, renderEquityCurve, renderMonthlyHeatmap, destroyAll, COLORS };
})();
