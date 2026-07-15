/**
 * dashboard.js — Module 01: Dashboard
 * Renders the main overview: current state, performance summary, charts,
 * position snapshot, and action centre (alerts).
 */

const dashboardModule = (() => {

  // ── State ────────────────────────────────────────────────────────────────
  let _selectedRange = 'YTD';

  // ── Init ─────────────────────────────────────────────────────────────────
  async function init() {
    // Auto-run alert engine on every dashboard load
    try { alertEngine.checkAllAlerts(await db.getOpenTrades()); } catch(e) {}

    const settings = await db.getSettings();
    _selectedRange = settings?.general?.defaultDateRange || 'YTD';

    const currentActive = document.querySelector('#dash-date-filter .filter-btn.active');
    if (currentActive && currentActive.dataset.range) {
      _selectedRange = currentActive.dataset.range;
    } else {
      const targetBtn = document.querySelector(`#dash-date-filter .filter-btn[data-range="${_selectedRange}"]`);
      if (targetBtn) {
        document.querySelectorAll('#dash-date-filter .filter-btn').forEach(b => b.classList.remove('active'));
        targetBtn.classList.add('active');
      }
    }

    _setupDateFilter();
    await _render();
  }

  // ── Date Filter ───────────────────────────────────────────────────────────
  function _setupDateFilter() {
    const container = document.getElementById('dash-date-filter');
    if (!container) return;
    container.querySelectorAll('.filter-btn').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', async () => {
        container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        fresh.classList.add('active');
        _selectedRange = fresh.dataset.range || 'YTD';
        await _render();
      });
    });
  }

  // ── Master Render ─────────────────────────────────────────────────────────
  async function _render() {
    const allTrades    = await db.getTrades();
    const openTrades   = await db.getOpenTrades();
    const closedTrades = await db.getClosedTrades();
    const capital      = await db.getCapital();
    const settings     = await db.getSettings();
    const marketHealth = await db.getMarketHealth();

    const totalRealizedPnl = calc.getTotalPnl(closedTrades);
    const equity           = calc.getCurrentEquity(capital, totalRealizedPnl);
    const currentR         = calc.getCurrentR(equity, settings);
    const filteredClosed   = calc.filterByDateRange(closedTrades, _selectedRange);

    _renderCurrentState(equity, openTrades, currentR, settings, marketHealth, capital);
    _renderSummaryCards(filteredClosed);
    _renderDailyChart(filteredClosed);
    _renderBubbleChart(filteredClosed);
    _renderPositionSnapshot(openTrades, currentR, settings);
    _renderAlertCentre(openTrades);
  }

  // ── Section A: Current State ──────────────────────────────────────────────
  function _renderCurrentState(equity, openTrades, currentR, settings, marketHealth, capital) {
    const container = document.getElementById('dash-current-state');
    if (!container) return;

    const rm              = settings?.riskManagement || {};
    const maxHeat         = Number(rm.maxPortfolioHeat  || 5);    // now in %
    const warnHeat        = Number(rm.warningPortfolioHeat || 3); // now in %
    const portfolioHeat   = calc.getPortfolioHeat(openTrades, equity);   // returns %
    const heatRs          = calc.getPortfolioHeatRs(openTrades);          // absolute ₹
    const remaining       = Math.max(0, maxHeat - portfolioHeat);         // remaining %
    const remainingRs     = (remaining / 100) * equity;                   // remaining ₹

    // Equity change vs net deposits
    const netDeposits = calc.getNetDeposits(capital);
    const equityDelta = equity - netDeposits;
    const deltaPct    = netDeposits > 0 ? ((equityDelta / netDeposits) * 100) : 0;
    const deltaClass  = equityDelta >= 0 ? 'text-success' : 'text-danger';
    const deltaSign   = equityDelta >= 0 ? '+' : '';

    // Heat bar
    const heatPct = Math.min(100, (portfolioHeat / maxHeat) * 100);
    let heatColor, heatLabel, heatBadge;
    if (portfolioHeat < warnHeat)     { heatColor = '#22c55e'; heatLabel = 'Safe';    heatBadge = 'badge-success'; }
    else if (portfolioHeat < maxHeat) { heatColor = '#f59e0b'; heatLabel = 'Warning'; heatBadge = 'badge-warning'; }
    else                              { heatColor = '#ef4444'; heatLabel = 'Max Hit'; heatBadge = 'badge-danger';  }

    // Remaining capacity hint
    let remHint;
    if (remaining <= 0)         remHint = '🚫 No new positions — heat at max';
    else if (remaining <= 0.5)  remHint = '⚠ Very limited capacity remaining';
    else                        remHint = `~${calc.formatCurrency(remainingRs)} more can be risked`;

    // Market health
    const trendEmoji   = marketHealth.trend === 'Uptrend' ? '🟢' : '🔴';
    const bClass       = marketHealth.breadthClassification;
    let breadthEmoji   = '🟢';
    if (bClass === 'Extreme Weakness') breadthEmoji = '🔵';
    else if (bClass === 'Weak')        breadthEmoji = '🔴';
    else if (bClass === 'Selective')   breadthEmoji = '🟡';

    container.innerHTML = `
      <div class="stat-card">
        <div class="stat-card-label">Account Value</div>
        <div class="stat-card-value">${calc.formatCurrency(equity)}</div>
        <div class="stat-card-sub ${deltaClass}" style="margin-top:4px;">
          ${deltaSign}${calc.formatCurrency(equityDelta)}&nbsp;(${deltaSign}${deltaPct.toFixed(2)}%)
          <span class="text-muted" style="font-size:11px;margin-left:4px;">vs deposits</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-card-label">Portfolio Heat</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
          <span class="stat-card-value" style="margin:0;">${portfolioHeat.toFixed(2)}%</span>
          <span class="badge ${heatBadge}" style="font-size:10px;">${heatLabel}</span>
        </div>
        <div style="margin-top:3px;font-size:11px;color:#64748b;">${calc.formatCurrency(heatRs)} at risk</div>
        <div style="margin-top:8px;">
          <div style="height:6px;border-radius:3px;background:#e2e8f0;overflow:hidden;">
            <div style="height:100%;width:${heatPct}%;background:${heatColor};border-radius:3px;transition:width 0.4s ease;"></div>
          </div>
          <div style="margin-top:5px;font-size:10px;color:#94a3b8;">
            Max Risk Allowed : ${maxHeat}% (<strong style="color:#64748b;">${calc.formatCurrency((maxHeat / 100) * equity)}</strong>)
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-card-label">Remaining Capacity</div>
        <div class="stat-card-value" style="color:${remaining <= 0 ? '#ef4444' : remaining <= 0.5 ? '#f59e0b' : '#22c55e'}">${remaining.toFixed(2)}%</div>
        <div class="stat-card-sub text-muted" style="margin-top:4px;">${remHint}</div>
      </div>

      <div class="stat-card" style="cursor:pointer;" onclick="app.showMarketHealthModal()" title="Click to update market health">
        <div class="stat-card-label">
          Market Health
          <span style="font-size:10px;color:#5b6af0;margin-left:6px;">✎ update</span>
          <a href="https://chartschool.stockcharts.com/table-of-contents/market-analysis/market-breadth"
             target="_blank"
             onclick="event.stopPropagation()"
             title="Learn about Market Breadth"
             style="font-size:10px;color:#94a3b8;margin-left:4px;text-decoration:none;">ℹ</a>
        </div>
        <div class="stat-card-value" style="font-size:20px;margin-top:2px;">
          ${trendEmoji} ${marketHealth.trend || 'Unknown'}
        </div>
        <div class="stat-card-sub" style="margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span>${breadthEmoji} ${bClass || '—'}</span>
          <span class="text-muted">•</span>
          <span style="font-size:12px;color:#5b6af0;font-weight:500;">${marketHealth.guidance || '—'}</span>
        </div>
        ${marketHealth.lastUpdated
          ? `<div style="font-size:10px;color:#94a3b8;margin-top:4px;">Updated ${calc.formatDate(marketHealth.lastUpdated)}</div>`
          : ''}
      </div>
    `;
  }

  // ── Section B: Trading Summary ────────────────────────────────────────────
  function _renderSummaryCards(filteredClosed) {
    const container = document.getElementById('dash-summary-cards');
    if (!container) return;

    if (filteredClosed.length === 0) {
      container.innerHTML = `<div class="no-data" style="grid-column:1/-1;padding:32px;">No closed trades for the selected period.</div>`;
      return;
    }

    const totalPnl    = calc.getTotalPnl(filteredClosed);
    const totalR      = calc.getTotalR(filteredClosed);
    const winRate     = calc.getWinRate(filteredClosed);
    const avgWL       = calc.getAvgWinLoss(filteredClosed);
    const expectancy  = calc.getExpectancy(filteredClosed);
    const maxDD       = calc.getMaxDrawdown(filteredClosed);

    const { avgWinR, avgLossR, winCount, lossCount } = avgWL;
    const rrRatio = avgLossR !== 0 ? (Math.abs(avgWinR / avgLossR)).toFixed(2) : '—';

    const pnlClass = totalPnl >= 0 ? 'text-success' : 'text-danger';
    const rClass   = totalR   >= 0 ? 'text-success' : 'text-danger';
    const expClass = expectancy >= 0 ? 'text-success' : 'text-danger';

    container.innerHTML = `
      <div class="stat-card">
        <div class="stat-card-label">Net P&amp;L <span class="text-muted" style="font-weight:400;">(${_selectedRange})</span></div>
        <div class="stat-card-value ${pnlClass}">${calc.formatCurrency(totalPnl)}</div>
        <div class="stat-card-sub ${rClass}">${calc.formatR(totalR)} &nbsp;|&nbsp; ${filteredClosed.length} trades</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-label">Win Rate</div>
        <div class="stat-card-value">${winRate.toFixed(1)}%</div>
        <div class="stat-card-sub text-muted">${winCount}W&nbsp;/&nbsp;${lossCount}L</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-label">Avg Win / Loss (R)</div>
        <div class="stat-card-value" style="font-size:18px;">
          <span class="text-success">${calc.formatR(avgWinR)}</span>
          <span class="text-muted" style="font-size:14px;"> / </span>
          <span class="text-danger">${calc.formatR(avgLossR)}</span>
        </div>
        <div class="stat-card-sub text-muted">Ratio: ${rrRatio}x</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-label">Expectancy</div>
        <div class="stat-card-value ${expClass}">${calc.formatR(expectancy)}</div>
        <div class="stat-card-sub text-muted">Per trade, in R</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-label">Max Drawdown</div>
        <div class="stat-card-value text-danger">${calc.formatR(maxDD)}</div>
        <div class="stat-card-sub text-muted">Peak-to-trough cumulative R</div>
      </div>
    `;
  }

  // ── Daily Cumulative P&L Chart ────────────────────────────────────────────
  function _renderDailyChart(filteredClosed) {
    const el = document.getElementById('chart-daily-pnl');
    if (!el) return;

    // Always restore canvas visibility first
    el.style.display = '';
    const wrap    = el.closest('[data-chart-wrap]') || el.parentElement;
    const noData  = wrap ? wrap.querySelector('.chart-no-data') : null;
    if (noData) noData.remove();

    const dailyData = calc.getDailyPnl(filteredClosed);

    if (dailyData.length === 0) {
      el.style.display = 'none';
      if (wrap) {
        const msg = document.createElement('div');
        msg.className = 'no-data chart-no-data';
        msg.style.cssText = 'padding:40px 0;text-align:center;color:#94a3b8;';
        msg.textContent = 'No closed trades in selected period';
        wrap.appendChild(msg);
      }
      return;
    }

    const labels = dailyData.map(d => {
      const p = d.date.split('-');
      return p.length === 3 ? `${p[2]}/${p[1]}` : d.date;
    });
    const data  = dailyData.map(d => d.cumPnl);
    const color = (data[data.length - 1] || 0) >= 0 ? charts.COLORS.success : charts.COLORS.danger;

    charts.renderLineChart('chart-daily-pnl', labels, data, 'Cumulative P&L', color);
  }

  // ── Risk:Reward Bubble Chart ──────────────────────────────────────────────
  function _renderBubbleChart(filteredClosed) {
    const el = document.getElementById('chart-rr-bubble');
    if (!el) return;

    const wrap   = el.closest('[data-chart-wrap]') || el.parentElement;
    const noData = wrap ? wrap.querySelector('.bubble-no-data') : null;
    if (noData) noData.remove();

    if (filteredClosed.length === 0) {
      el.style.display = 'none';
      if (wrap) {
        const msg = document.createElement('div');
        msg.className = 'no-data bubble-no-data';
        msg.style.cssText = 'padding:40px 0;text-align:center;color:#94a3b8;';
        msg.textContent = 'No closed trades to display';
        wrap.appendChild(msg);
      }
      return;
    }

    el.style.display = '';
    charts.renderBubbleChart('chart-rr-bubble', filteredClosed);
  }

  // ── Position Snapshot ─────────────────────────────────────────────────────
  function _renderPositionSnapshot(openTrades, currentR, settings) {
    const tbody   = document.getElementById('dash-position-body');
    const counter = document.getElementById('dash-pos-count');
    if (!tbody) return;

    if (counter) {
      counter.textContent = openTrades.length;
      counter.className   = 'badge ' + (openTrades.length > 0 ? 'badge-info' : 'badge-muted');
    }

    if (openTrades.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="no-data" style="padding:24px;">No open positions</td></tr>`;
      return;
    }

    tbody.innerHTML = openTrades.map(trade => {
      const m          = calc.getTradeMetrics(trade);
      const dirBadge   = trade.direction === 'Long'
        ? `<span class="badge badge-success" style="font-size:10px;padding:1px 5px;">L</span>`
        : `<span class="badge badge-danger"  style="font-size:10px;padding:1px 5px;">S</span>`;
      const rClass     = m.currentRiskR < 0 ? 'text-danger' : m.currentRiskR > 0 ? 'text-success' : 'text-muted';
      const dayBadge   = m.holdingDays >= 5 ? 'badge-warning' : 'badge-info';
      const activeAlerts = alertEngine.getActiveAlerts([trade]);
      const alertIcon  = activeAlerts.length > 0 ? ' ⚠' : '';

      return `
        <tr class="clickable-row" data-id="${trade.id}" style="cursor:pointer;" title="Open in Positions">
          <td>
            <div style="display:flex;align-items:center;gap:6px;">
              ${dirBadge}
              <strong style="color:#1a1f36;">${trade.symbol}</strong>
              ${alertIcon ? `<span style="color:#f59e0b;font-size:13px;">${alertIcon}</span>` : ''}
            </div>
            <div style="font-size:11px;color:#94a3b8;">${trade.tradeType || 'Equity'} · ${trade.sector || ''}</div>
          </td>
          <td class="text-right">${calc.formatCurrency(m.exposure)}</td>
          <td class="text-right ${rClass}">${calc.formatR(m.currentRiskR)}</td>
          <td class="text-right"><span class="badge ${dayBadge}">${m.holdingDays}d (T: ${m.tradingDays})</span></td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.clickable-row').forEach(row => {
      row.addEventListener('click', () => app.navigate('positions'));
    });
  }

  // ── Action Centre ─────────────────────────────────────────────────────────
  function _renderAlertCentre(openTrades) {
    const tbody   = document.getElementById('dash-alert-body');
    const counter = document.getElementById('dash-alert-count');
    if (!tbody) return;

    const alerts = alertEngine.getActiveAlerts(openTrades);
    if (counter) {
      counter.textContent = alerts.length;
      counter.className   = 'badge ' + (alerts.length > 0 ? 'badge-danger' : 'badge-muted');
    }

    if (alerts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="no-data" style="padding:24px;">✅ All clear — no active alerts</td></tr>`;
      return;
    }

    function _severity(type) {
      if (type.includes('Stop') || type.includes('Breach')) return 'badge-danger';
      if (type.includes('Day-5') || type.includes('ATR'))   return 'badge-warning';
      return 'badge-info';
    }

    tbody.innerHTML = alerts.map((alert, idx) => `
      <tr>
        <td>
          <strong style="color:#1a1f36;">${alert.symbol}</strong>
          ${alert.entryDate
            ? `<div style="font-size:11px;color:#94a3b8;">${calc.formatDate(alert.entryDate)}</div>`
            : ''}
        </td>
        <td><span class="badge ${_severity(alert.type)}">${alert.type}</span></td>
        <td class="text-right">
          <button
            class="btn btn-secondary btn-sm"
            style="font-size:11px;"
            data-alert-idx="${idx}"
          >Dismiss</button>
        </td>
      </tr>
    `).join('');

    // Attach dismiss handlers separately to avoid inline eval
    tbody.querySelectorAll('[data-alert-idx]').forEach(btn => {
      const idx   = parseInt(btn.dataset.alertIdx, 10);
      const alert = alerts[idx];
      if (!alert) return;
      btn.addEventListener('click', () => {
        alertEngine.dismissAlert(alert.tradeId, alert.type);
        app.toast(`Alert dismissed for ${alert.symbol}`, 'info');
        dashboardModule.init();
      });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return { init };
})();
