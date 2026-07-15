/**
 * analytics.js — Module 05: Analytics
 * 6-tab performance intelligence dashboard.
 */
const analyticsModule = (() => {
  let _range = 'YTD';
  let _activeTab = 'performance';
  let _charts = [];

  async function init() {
    _setupDateFilter();
    _setupTabBar();
    await _renderTab(_activeTab);
  }

  function _setupDateFilter() {
    document.querySelectorAll('#anl-date-filter .filter-btn').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', async () => {
        document.querySelectorAll('#anl-date-filter .filter-btn').forEach(b => b.classList.remove('active'));
        fresh.classList.add('active');
        _range = fresh.dataset.range;
        await _renderTab(_activeTab);
      });
    });
  }

  function _setupTabBar() {
    document.querySelectorAll('#anl-tab-bar .tab-btn').forEach(btn => {
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', async () => {
        document.querySelectorAll('#anl-tab-bar .tab-btn').forEach(b => b.classList.remove('active'));
        fresh.classList.add('active');
        _activeTab = fresh.dataset.tab;
        await _renderTab(_activeTab);
      });
    });
  }

  async function _renderTab(tab) {
    _charts.forEach(c => { try { c.destroy(); } catch(e) {} });
    _charts = [];
    const el = document.getElementById('anl-content');
    if (!el) return;
    const closedTrades = await db.getClosedTrades();
    const trades = calc.filterByDateRange(closedTrades, _range);
    if (tab === 'performance') await _tabPerformance(el, trades);
    else if (tab === 'trade-analytics') _tabTradeAnalytics(el, trades);
    else if (tab === 'playbook-analytics') await _tabPlaybookAnalytics(el, trades);
    else if (tab === 'risk') await _tabRisk(el, trades);
    else if (tab === 'discipline') _tabDiscipline(el, trades);
    else if (tab === 'simulator') await _tabSimulator(el, trades);
  }

  // ── TAB 1: Performance ─────────────────────────────────────────────────────
  async function _tabPerformance(el, trades) {
    const wr = calc.getWinRate(trades);
    const netPnl = calc.getTotalPnl(trades);
    const netR = calc.getTotalR(trades);
    const exp = calc.getExpectancy(trades);
    const mdd = calc.getMaxDrawdown(trades);
    const ruleBreaks = trades.filter(t => !t.ruleFollowed).length;
    const score = Math.max(0, 100 - (trades.length > 0 ? (ruleBreaks/trades.length)*40 : 0) - (Math.max(0, -mdd) * 5));
    el.innerHTML = `<div class="anl-tab-content">
      <div class="anl-cards-row">
        ${_sCard('Total Trades', trades.length, '')}
        ${_sCard('Win Rate', `${wr.toFixed(1)}%`, '', wr >= 40 ? 'text-success' : 'text-danger')}
        ${_sCard('Net P&L', calc.formatCurrency(netPnl), '', netPnl >= 0 ? 'text-success' : 'text-danger')}
        ${_sCard('Net R', calc.formatR(netR), '', netR >= 0 ? 'text-success' : 'text-danger')}
        ${_sCard('Expectancy', calc.formatR(exp), 'per trade', exp >= 0 ? 'text-success' : 'text-danger')}
        ${_sCard('Max Drawdown', calc.formatR(mdd), '', 'text-danger')}
        ${_sCard('Trading Score', score.toFixed(0), '/100', score >= 70 ? 'text-success' : score >= 40 ? 'text-warning' : 'text-danger')}
      </div>
      <div class="anl-charts-row">
        <div class="card">
          <div class="card-header">
            <span class="card-title" id="anl-pnl-chart-title">Cumulative P&L</span>
            <div style="display:flex;gap:6px;">
              <button class="toggle-btn active" id="btn-cum-pnl" onclick="analyticsModule._switchCumChart('pnl')" style="font-size:11px;padding:3px 8px;">Cum. P&L</button>
              <button class="toggle-btn" id="btn-cum-eq" onclick="analyticsModule._switchCumChart('equity')" style="font-size:11px;padding:3px 8px;">Cum. Equity</button>
            </div>
          </div>
          <div style="padding:12px;height:220px"><canvas id="anl-equity-chart"></canvas></div>
        </div>
        <div class="card"><div class="card-header"><span class="card-title">Drawdown Curve</span></div><div style="padding:12px;height:220px"><canvas id="anl-dd-chart"></canvas></div></div>
      </div>
      <div class="anl-charts-row">
        <div class="card" style="flex:1">
          <div class="card-header"><span class="card-title">Trade P&L Sequence</span><span class="card-subtitle">Chronological Profit/Loss per Trade (₹)</span></div>
          <div style="padding:12px;height:220px"><canvas id="anl-daily-pnl-chart"></canvas></div>
        </div>
      </div>
      <div class="anl-charts-row">
        <div class="card"><div class="card-header"><span class="card-title">Monthly P&L Heatmap</span></div><div style="padding:12px;overflow-x:auto" id="anl-heatmap"></div></div>
        <div class="card"><div class="card-header"><span class="card-title">Rolling 10-Trade Win Rate</span></div><div style="padding:12px;height:220px"><canvas id="anl-rolling-chart"></canvas></div></div>
      </div>
    </div>`;

    // Cumulative P&L chart (default)
    const dailyArr = calc.getDailyPnl(trades);
    const labels = dailyArr.map(d => d.date.slice(5));
    const cumData = dailyArr.map(d => d.cumPnl);
    _charts.push(_makeLineChart('anl-equity-chart', labels, cumData, 'Cumulative P&L', '#5b6af0'));

    // Trade P&L Sequence Chart
    const seqSorted = trades.slice().sort((a,b) => {
      const da = a.finalExit?.date || a.entries?.[0]?.date || '';
      const db = b.finalExit?.date || b.entries?.[0]?.date || '';
      return da.localeCompare(db);
    });
    const seqLabels = seqSorted.map((t, i) => `${t.symbol}`);
    const seqData = seqSorted.map(t => calc.getTradeMetrics(t).realizedPnl);
    _charts.push(_makeBarChart('anl-daily-pnl-chart', seqLabels, seqData, 'Trade P&L'));

    // Drawdown curve
    let peak = 0;
    const ddData = dailyArr.map(d => { if (d.cumPnl > peak) peak = d.cumPnl; return peak > 0 ? ((d.cumPnl - peak) / peak) * 100 : 0; });
    _charts.push(_makeLineChart('anl-dd-chart', labels, ddData, 'Drawdown %', '#ef4444'));

    // Heatmap
    document.getElementById('anl-heatmap').innerHTML = _buildHeatmap(trades);

    // Rolling WR
    const sorted = trades.slice().sort((a,b) => (a.finalExit?.date||'').localeCompare(b.finalExit?.date||''));
    const rolling = sorted.map((_, i) => { if (i < 9) return null; const slice = sorted.slice(i-9, i+1); return calc.getWinRate(slice); }).filter(v => v !== null);
    const rLabels = sorted.slice(9).map((t,i) => `T${i+10}`);
    _charts.push(_makeLineChart('anl-rolling-chart', rLabels, rolling, 'Rolling 10-Trade WR%', '#22c55e'));
  }

  // Chart toggle: Cumulative P&L ↔ Cumulative Equity
  async function _switchCumChart(mode) {
    const btnPnl = document.getElementById('btn-cum-pnl');
    const btnEq  = document.getElementById('btn-cum-eq');
    const titleEl= document.getElementById('anl-pnl-chart-title');
    if (!btnPnl || !btnEq) return;
    btnPnl.classList.toggle('active', mode === 'pnl');
    btnEq.classList.toggle('active', mode === 'equity');

    // Destroy existing chart on that canvas
    const existingIdx = _charts.findIndex(c => c?.canvas?.id === 'anl-equity-chart');
    if (existingIdx >= 0) { try { _charts[existingIdx].destroy(); } catch(e) {} _charts.splice(existingIdx, 1); }

    const closedTrades = await db.getClosedTrades();
    const dailyArr  = calc.getDailyPnl(closedTrades);
    const labels    = dailyArr.map(d => d.date.slice(5));

    if (mode === 'pnl') {
      if (titleEl) titleEl.textContent = 'Cumulative P&L';
      const cumData = dailyArr.map(d => d.cumPnl);
      _charts.push(_makeLineChart('anl-equity-chart', labels, cumData, 'Cumulative P&L', '#5b6af0'));
    } else {
      if (titleEl) titleEl.textContent = 'Cumulative Equity';
      const capital     = await db.getCapital();
      const netDeposits = calc.getNetDeposits(capital);
      const eqData = dailyArr.map(d => Math.round(netDeposits + d.cumPnl));
      const fullData = [netDeposits, ...eqData];
      _charts.push(_makeLineChart('anl-equity-chart', ['Start', ...labels], fullData, 'Cumulative Equity', '#22c55e'));
    }
  }

  function _buildHeatmap(trades) {
    const monthly = {};
    trades.forEach(t => {
      const m = calc.getTradeMetrics(t);
      const date = t.finalExit?.date || '';
      if (!date) return;
      const ym = date.slice(0, 7);
      if (!monthly[ym]) monthly[ym] = 0;
      monthly[ym] += m.realizedPnl;
    });
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const years = [...new Set(Object.keys(monthly).map(k => k.slice(0,4)))].sort();
    if (!years.length) return '<div class="no-data">No data for heatmap</div>';
    const maxAbs = Math.max(...Object.values(monthly).map(Math.abs), 1);
    let html = `<table class="heatmap-table"><thead><tr><th></th>${MONTHS.map(m => `<th>${m}</th>`).join('')}</tr></thead><tbody>`;
    years.forEach(yr => {
      html += `<tr><td class="heatmap-year">${yr}</td>`;
      MONTHS.forEach((_, mi) => {
        const key = `${yr}-${String(mi+1).padStart(2,'0')}`;
        const val = monthly[key];
        if (val === undefined) { html += `<td class="heatmap-cell empty">—</td>`; return; }
        const intensity = Math.min(255, Math.round((Math.abs(val) / maxAbs) * 255));
        const cls = val >= 0 ? 'pos' : 'neg';
        html += `<td class="heatmap-cell ${cls}" style="--intensity:${intensity}" title="${key}: ${calc.formatCurrency(val)}">${val >= 0 ? '+' : ''}${(val/1000).toFixed(1)}K</td>`;
      });
      html += `</tr>`;
    });
    html += `</tbody></table>`;
    return html;
  }

  // ── TAB 2: Trade Analytics ─────────────────────────────────────────────────
  function _tabTradeAnalytics(el, trades) {
    const sectors = {};
    trades.forEach(t => {
      const s = t.sector || 'Other';
      if (!sectors[s]) sectors[s] = [];
      sectors[s].push(t);
    });
    const sectorRows = Object.entries(sectors).map(([sec, ts]) => {
      const m = calc.getTradeMetrics; const wr = calc.getWinRate(ts); const netR = calc.getTotalR(ts); const exp = calc.getExpectancy(ts);
      const avgDays = ts.reduce((s,t) => s + m(t).holdingDays, 0) / ts.length;
      return { sec, cnt: ts.length, wr: wr.toFixed(1), netR: netR.toFixed(2), exp: exp.toFixed(2), avgDays: avgDays.toFixed(0), netPnl: calc.getTotalPnl(ts) };
    }).sort((a,b) => parseFloat(b.netR) - parseFloat(a.netR));

    const days = ['Mon','Tue','Wed','Thu','Fri'];
    const dayR = [0,0,0,0,0]; const dayCnt = [0,0,0,0,0];
    trades.forEach(t => {
      const date = t.entries?.[0]?.date;
      if (!date) return;
      const day = new Date(date).getDay();
      if (day >= 1 && day <= 5) { dayR[day-1] += calc.getTradeMetrics(t).profitR; dayCnt[day-1]++; }
    });

    const rBuckets = {'<-2R':0,'-2 to -1':0,'-1 to 0':0,'0 to 1':0,'1 to 2':0,'2 to 3':0,'>3R':0};
    trades.forEach(t => {
      const r = calc.getTradeMetrics(t).profitR;
      if (r < -2) rBuckets['<-2R']++;
      else if (r < -1) rBuckets['-2 to -1']++;
      else if (r < 0) rBuckets['-1 to 0']++;
      else if (r < 1) rBuckets['0 to 1']++;
      else if (r < 2) rBuckets['1 to 2']++;
      else if (r < 3) rBuckets['2 to 3']++;
      else rBuckets['>3R']++;
    });

    // Holding period scatter data
    const scatterData = trades.map(t => {
      const m = calc.getTradeMetrics(t);
      const result = calc.getTradeResult(t);
      return { x: m.holdingDays, y: m.profitR, result };
    });

    el.innerHTML = `<div class="anl-tab-content">
      <div class="anl-section">
        <div class="anl-section-title">Sector Performance</div>
        <table class="sector-table"><thead><tr><th>Sector</th><th>Trades</th><th>Win Rate</th><th>Net R</th><th>Expectancy</th><th>Avg Days</th></tr></thead>
        <tbody>${sectorRows.map(r => `<tr><td><strong>${r.sec}</strong></td><td>${r.cnt}</td>
          <td>${r.wr}%</td>
          <td class="${parseFloat(r.netR) >= 0 ? 'text-success' : 'text-danger'} font-mono">${r.netR}R</td>
          <td class="${parseFloat(r.exp) >= 0 ? 'text-success' : 'text-danger'}">${r.exp}R</td>
          <td>${r.avgDays}d</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="anl-charts-row">
        <div class="card"><div class="card-header"><span class="card-title">Net R by Weekday</span></div><div style="padding:12px;height:200px"><canvas id="anl-weekday-chart"></canvas></div></div>
        <div class="card"><div class="card-header"><span class="card-title">Return Distribution (R)</span></div><div style="padding:12px;height:200px"><canvas id="anl-dist-chart"></canvas></div></div>
      </div>
      <div class="anl-charts-row">
        <div class="card" style="flex:2">
          <div class="card-header"><span class="card-title">Holding Period vs Profit R</span><span class="card-subtitle">Each dot = one trade (Green=Win, Red=Loss)</span></div>
          <div style="padding:12px;height:220px"><canvas id="anl-scatter-chart"></canvas></div>
        </div>
      </div>
    </div>`;

    // Weekday chart
    _charts.push(_makeBarChart('anl-weekday-chart', days, dayR, 'Net R by Day'));
    // Distribution chart
    _charts.push(_makeBarChart('anl-dist-chart', Object.keys(rBuckets), Object.values(rBuckets), 'Frequency'));
    // Holding period scatter
    _charts.push(_makeScatterChart('anl-scatter-chart', scatterData));
  }

  // ── TAB 3: Playbook Analytics ──────────────────────────────────────────────
  async function _tabPlaybookAnalytics(el, trades) {
    const pbs = await db.getPlaybooks();
    const rows = pbs.map(pb => {
      const ts = trades.filter(t => t.playbookId === pb.id);
      if (!ts.length) return null;
      const wr = calc.getWinRate(ts);
      const { avgWinR, avgLossR } = calc.getAvgWinLoss(ts);
      const exp = calc.getExpectancy(ts);
      const netR = calc.getTotalR(ts);
      const avgDays = ts.reduce((s,t) => s + calc.getTradeMetrics(t).holdingDays,0)/ts.length;
      return { pb, ts, wr, avgWinR, avgLossR, exp, netR, avgDays };
    }).filter(Boolean).sort((a,b) => b.exp - a.exp);

    el.innerHTML = `<div class="anl-tab-content">
      <div class="anl-section">
        <div class="anl-section-title">Playbook Performance</div>
        <table class="data-table"><thead><tr><th>Name</th><th>Ver</th><th>Trades</th><th>Win Rate</th><th>Avg Win</th><th>Avg Loss</th><th>Expectancy</th><th>Net R</th><th>Avg Days</th></tr></thead>
        <tbody>${rows.map(r => `<tr onclick="app.navigate('playbook')">
          <td><strong>${r.pb.name}</strong></td><td>v${r.pb.currentVersion}</td><td>${r.ts.length}</td>
          <td>${r.wr.toFixed(1)}%</td>
          <td class="text-success">${r.avgWinR.toFixed(2)}R</td>
          <td class="text-danger">${r.avgLossR.toFixed(2)}R</td>
          <td class="${r.exp >= 0 ? 'text-success' : 'text-danger'} fw-600">${calc.formatR(r.exp)}</td>
          <td class="${r.netR >= 0 ? 'text-success' : 'text-danger'}">${calc.formatR(r.netR)}</td>
          <td>${r.avgDays.toFixed(0)}d</td>
        </tr>`).join('')}</tbody></table>
      </div>
      <div class="anl-charts-row">
        <div class="card"><div class="card-header"><span class="card-title">Expectancy by Playbook</span></div><div style="padding:12px;height:220px"><canvas id="anl-pb-exp-chart"></canvas></div></div>
        <div class="card"><div class="card-header"><span class="card-title">Win Rate by Playbook</span></div><div style="padding:12px;height:220px"><canvas id="anl-pb-wr-chart"></canvas></div></div>
      </div>
      <div class="anl-charts-row">
        <div class="card" style="flex:2">
          <div class="card-header"><span class="card-title">Playbook vs Avg Holding Days</span><span class="card-subtitle">Average holding duration per setup</span></div>
          <div style="padding:12px;height:220px"><canvas id="anl-pb-days-chart"></canvas></div>
        </div>
      </div>
    </div>`;

    if (rows.length) {
      const names = rows.map(r => r.pb.name.length > 12 ? r.pb.name.slice(0,12)+'…' : r.pb.name);
      _charts.push(_makeBarChart('anl-pb-exp-chart', names, rows.map(r => r.exp), 'Expectancy (R)'));
      _charts.push(_makeBarChart('anl-pb-wr-chart', names, rows.map(r => r.wr), 'Win Rate %'));
      // Playbook vs Avg Holding Days
      const daysData = rows.map(r => parseFloat(r.avgDays.toFixed(0)));
      const daysCtx  = document.getElementById('anl-pb-days-chart')?.getContext('2d');
      if (daysCtx) {
        _charts.push(new Chart(daysCtx, {
          type: 'bar',
          data: { labels: names, datasets: [{ label: 'Avg Days', data: daysData, backgroundColor: 'rgba(91,106,240,0.7)', borderColor: '#5b6af0', borderWidth: 1.5 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 10 }, callback: v => v + 'd' } } } }
        }));
      }
    }
  }

  // ── TAB 4: Risk Analytics ──────────────────────────────────────────────────
  async function _tabRisk(el, trades) {
    const openTrades = await db.getOpenTrades();
    const heat = calc.getPortfolioHeat(openTrades);
    const violations = trades.filter(t => !t.ruleFollowed);
    const settings = await db.getSettings();
    const maxHeat = settings?.riskManagement?.maxPortfolioHeat || 4;

    el.innerHTML = `<div class="anl-tab-content">
      <div class="anl-cards-row">
        ${_sCard('Current Heat', `${heat.toFixed(2)}R`, `Max: ${maxHeat}R`, heat >= maxHeat ? 'text-danger' : '')}
        ${_sCard('Rule Violations', violations.length, `${trades.length > 0 ? ((violations.length/trades.length)*100).toFixed(0) : 0}% of trades`, violations.length > 0 ? 'text-warning' : 'text-success')}
        ${_sCard('Open Positions', openTrades.length, 'Currently active', '')}
      </div>
      <div class="anl-section">
        <div class="anl-section-title">Rule Violations</div>
        ${violations.length ? `<table class="data-table"><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R</th></tr></thead>
        <tbody>${violations.map(t => { const m = calc.getTradeMetrics(t); return `<tr>
          <td><strong>${t.symbol}</strong></td>
          <td>${calc.formatDate(t.entries?.[0]?.date)}</td>
          <td>${calc.formatDate(t.finalExit?.date)}</td>
          <td class="${m.realizedPnl >= 0 ? 'text-success' : 'text-danger'} font-mono">${calc.formatCurrency(m.realizedPnl)}</td>
          <td class="${m.profitR >= 0 ? 'text-success' : 'text-danger'}">${calc.formatR(m.profitR)}</td>
        </tr>`; }).join('')}</tbody></table>` : `<div class="no-data" style="padding:20px 0">No rule violations in this period. 🎯</div>`}
      </div>
    </div>`;
  }

  // ── TAB 5: Discipline ──────────────────────────────────────────────────────
  function _tabDiscipline(el, trades) {
    const ruleBreaks = trades.filter(t => !t.ruleFollowed).length;
    const ruleBreakPct = trades.length > 0 ? (ruleBreaks / trades.length) * 100 : 0;
    const score = Math.max(0, Math.round(100 - ruleBreakPct * 0.5));
    const violations = trades.filter(t => !t.ruleFollowed);
    const sorted = trades.slice().sort((a,b) => (a.finalExit?.date||'').localeCompare(b.finalExit?.date||''));
    let revengeTrade = false;
    for (let i = 3; i < sorted.length; i++) {
      const recent3 = sorted.slice(i-3, i);
      const allLoss = recent3.every(t => calc.getTradeMetrics(t).profitR < 0);
      if (allLoss) {
        const nextRPT = calc.getTradeMetrics(sorted[i]).initialRPT;
        const avgRPT = recent3.reduce((s,t) => s + calc.getTradeMetrics(t).initialRPT, 0) / 3;
        if (nextRPT > avgRPT * 1.5) { revengeTrade = true; break; }
      }
    }
    el.innerHTML = `<div class="anl-tab-content">
      <div style="display:flex;align-items:center;gap:24px;margin-bottom:18px">
        <div class="score-circle" style="--pct:${score}%">
          <span class="score-value">${score}</span>
        </div>
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--navy)">Discipline Score</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">${score >= 80 ? '🟢 Excellent discipline' : score >= 60 ? '🟡 Needs improvement' : '🔴 Significant issues detected'}</div>
          ${revengeTrade ? `<div class="alert-banner danger" style="margin-top:8px">⚠ Possible revenge trading detected — position size increased after 3 consecutive losses.</div>` : ''}
        </div>
      </div>
      <div class="anl-cards-row">
        ${_sCard('Rule Breaks', ruleBreaks, `${ruleBreakPct.toFixed(1)}%`, ruleBreaks > 0 ? 'text-danger' : 'text-success')}
        ${_sCard('Clean Trades', trades.length - ruleBreaks, `${(100-ruleBreakPct).toFixed(1)}%`, 'text-success')}
        ${_sCard('Revenge Trade', revengeTrade ? 'Detected' : 'Clear', '', revengeTrade ? 'text-danger' : 'text-success')}
      </div>
      ${violations.length ? `<div class="anl-section-title">Trades with Rule Breaks</div>
      <table class="data-table"><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R</th></tr></thead>
      <tbody>${violations.map(t => { const m = calc.getTradeMetrics(t); return `<tr>
        <td><strong>${t.symbol}</strong></td><td>${calc.formatDate(t.entries?.[0]?.date)}</td>
        <td>${calc.formatDate(t.finalExit?.date)}</td>
        <td class="${m.realizedPnl >= 0 ? 'text-success' : 'text-danger'} font-mono">${calc.formatCurrency(m.realizedPnl)}</td>
        <td class="${m.profitR >= 0 ? 'text-success' : 'text-danger'}">${calc.formatR(m.profitR)}</td>
      </tr>`; }).join('')}</tbody></table>` : `<div class="no-data">No rule violations! 🎉</div>`}
    </div>`;
  }

  // ── TAB 6: Growth Simulator (Bucket-Based) ────────────────────────────────
  async function _tabSimulator(el, trades) {
    const capital   = await db.getCapital();
    const allClosed = await db.getClosedTrades();
    const equity    = calc.getCurrentEquity(capital, calc.getTotalPnl(allClosed));
    const tpy       = trades.length > 0 ? Math.round(trades.length * (365 / Math.max(1, _daysDiff(trades)))) : 192;

    window._simBuckets = {
      breakeven: [{ r: -0.10, pct: 15 }],
      losing:    [{ r: -1.10, pct: 35 }, { r: -0.50, pct: 10 }],
      winning:   [{ r: 1.0, pct: 12 }, { r: 2.0, pct: 10 }, { r: 3.0, pct: 8 }, { r: 5.0, pct: 6 }, { r: 7.0, pct: 3 }, { r: 10.0, pct: 1 }],
    };

    el.innerHTML = `<div class="anl-tab-content sim-bucket-layout">
      <div class="sim-inputs-bar">
        <div class="form-group"><label class="form-label">Account Value (₹)</label><input class="form-input" id="sim-capital" type="number" value="${equity.toFixed(0)}" oninput="analyticsModule._simRecalc()"></div>
        <div class="form-group"><label class="form-label">Risk per Trade (%)</label><input class="form-input" id="sim-risk" type="number" step="0.1" value="1.20" oninput="analyticsModule._simRecalc()"></div>
        <div class="form-group"><label class="form-label">Total Trades / Year</label><input class="form-input" id="sim-tpy" type="number" value="${tpy}" oninput="analyticsModule._simRecalc()"></div>
        <button class="btn btn-secondary btn-sm" style="align-self:flex-end" onclick="analyticsModule._simAutoFill()">⚡ Auto-Fill from History</button>
      </div>
      <div class="sim-bucket-tables">
        <div class="sim-bucket-card breakeven">
          <div class="sim-bucket-title">Breakeven Buckets</div>
          <table class="sim-bucket-table"><thead><tr><th>R Multiple</th><th>% of Total Trades</th><th>No. of Trades</th><th></th></tr></thead><tbody id="sim-be-body"></tbody>
          <tfoot><tr><td colspan="4"><button class="btn btn-secondary btn-sm" onclick="analyticsModule._simAddRow('breakeven')">+ Add Row</button></td></tr></tfoot></table>
          <div class="sim-bucket-total" id="sim-be-total"></div>
        </div>
        <div class="sim-bucket-card losing">
          <div class="sim-bucket-title">Losing Buckets</div>
          <table class="sim-bucket-table"><thead><tr><th>R Multiple</th><th>% of Total Trades</th><th>No. of Trades</th><th></th></tr></thead><tbody id="sim-loss-body"></tbody>
          <tfoot><tr><td colspan="4"><button class="btn btn-secondary btn-sm" onclick="analyticsModule._simAddRow('losing')">+ Add Row</button></td></tr></tfoot></table>
          <div class="sim-bucket-total" id="sim-loss-total"></div>
        </div>
        <div class="sim-bucket-card winning">
          <div class="sim-bucket-title">Winning Buckets</div>
          <table class="sim-bucket-table"><thead><tr><th>R Multiple</th><th>% of Total Trades</th><th>No. of Trades</th><th></th></tr></thead><tbody id="sim-win-body"></tbody>
          <tfoot><tr><td colspan="4"><button class="btn btn-secondary btn-sm" onclick="analyticsModule._simAddRow('winning')">+ Add Row</button></td></tr></tfoot></table>
          <div class="sim-bucket-total" id="sim-win-total"></div>
        </div>
      </div>
      <div id="sim-results"></div>
    </div>`;

    _simRenderBuckets();
    _simRecalc();
  }

  function _simRenderBuckets() {
    const tpy = parseInt(document.getElementById('sim-tpy')?.value) || 192;
    const map = { breakeven: 'sim-be-body', losing: 'sim-loss-body', winning: 'sim-win-body' };
    Object.entries(map).forEach(([type, bodyId]) => {
      const tbody = document.getElementById(bodyId);
      if (!tbody) return;
      tbody.innerHTML = (window._simBuckets[type] || []).map((b, i) => `<tr>
        <td><input class="form-input sim-cell-input" type="number" step="0.1" value="${b.r}" oninput="analyticsModule._simUpdateBucket('${type}',${i},'r',this.value)"></td>
        <td><input class="form-input sim-cell-input" type="number" step="0.5" min="0" max="100" value="${b.pct}" oninput="analyticsModule._simUpdateBucket('${type}',${i},'pct',this.value)"></td>
        <td class="sim-trades-count">${Math.round((b.pct / 100) * tpy)}</td>
        <td><span class="rule-delete" onclick="analyticsModule._simDeleteRow('${type}',${i})">✕</span></td>
      </tr>`).join('');
    });
  }

  function _simUpdateBucket(type, idx, field, val) {
    if (!window._simBuckets?.[type]) return;
    window._simBuckets[type][idx][field] = parseFloat(val) || 0;
    _simRenderBuckets();
    _simRecalc();
  }
  function _simAddRow(type) {
    if (!window._simBuckets) return;
    const defs = { breakeven: { r: 0.0, pct: 5 }, losing: { r: -1.0, pct: 5 }, winning: { r: 1.0, pct: 5 } };
    window._simBuckets[type].push({ ...defs[type] });
    _simRenderBuckets();
    _simRecalc();
  }
  function _simDeleteRow(type, idx) {
    if (!window._simBuckets?.[type]) return;
    window._simBuckets[type].splice(idx, 1);
    _simRenderBuckets();
    _simRecalc();
  }

  async function _simAutoFill() {
    const allClosed = await db.getClosedTrades();
    if (!allClosed.length) { app.toast('No closed trades to analyse', 'warning'); return; }
    const rVals = allClosed.map(t => calc.getTradeMetrics(t).profitR).filter(r => isFinite(r));
    if (!rVals.length) { app.toast('No valid R data', 'warning'); return; }
    const BE_A   = [-0.10, 0.0];
    const LOSS_A = [-10, -7, -5, -3, -2, -1.5, -1.0, -0.5];
    const WIN_A  = [0.5, 1.0, 1.5, 2.0, 3.0, 5.0, 7.0, 10.0];
    const ALL    = [...LOSS_A, ...BE_A, ...WIN_A];
    const groups = {};
    ALL.forEach(a => { groups[a] = []; });
    rVals.forEach(r => {
      let best = ALL[0], bestD = Infinity;
      ALL.forEach(a => { const d = Math.abs(r - a); if (d < bestD) { bestD = d; best = a; } });
      groups[best].push(r);
    });
    const total = rVals.length;
    const toBuckets = anchors => anchors.filter(a => groups[a].length > 0).map(a => ({
      r:   parseFloat((groups[a].reduce((s, v) => s + v, 0) / groups[a].length).toFixed(2)),
      pct: parseFloat(((groups[a].length / total) * 100).toFixed(1)),
    }));
    window._simBuckets.breakeven = toBuckets(BE_A).length   ? toBuckets(BE_A)   : [{ r: -0.10, pct: 15 }];
    window._simBuckets.losing    = toBuckets(LOSS_A).length ? toBuckets(LOSS_A) : [{ r: -1.10, pct: 35 }, { r: -0.50, pct: 10 }];
    window._simBuckets.winning   = toBuckets(WIN_A).length  ? toBuckets(WIN_A)  : [{ r: 1.0, pct: 12 }];
    _simRenderBuckets();
    _simRecalc();
    app.toast(`Auto-filled from ${total} closed trades`, 'success');
  }

  function _simRecalc() {
    const startCap = parseFloat(document.getElementById('sim-capital')?.value) || 1500000;
    const riskPct  = parseFloat(document.getElementById('sim-risk')?.value) / 100 || 0.012;
    const tpy      = parseInt(document.getElementById('sim-tpy')?.value) || 192;
    if (!window._simBuckets) return;
    const { breakeven = [], losing = [], winning = [] } = window._simBuckets;
    const sumPct = arr => arr.reduce((s, b) => s + b.pct, 0);
    const bePct = sumPct(breakeven), lossPct = sumPct(losing), winPct = sumPct(winning);
    const totalPct = bePct + lossPct + winPct;
    [['sim-be-total', bePct], ['sim-loss-total', lossPct], ['sim-win-total', winPct]].forEach(([id, v]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = `TOTAL  ${v.toFixed(1)}%`;
    });
    _simRenderBuckets();
    const resultsEl = document.getElementById('sim-results');
    if (!resultsEl) return;
    if (Math.abs(totalPct - 100) > 0.5) {
      resultsEl.innerHTML = `<div class="alert-banner danger" style="margin-top:14px">⚠ Bucket percentages must sum to 100%. Current total: <strong>${totalPct.toFixed(1)}%</strong></div>`;
      return;
    }
    const wavg = (arr, tot) => tot > 0 ? arr.reduce((s, b) => s + b.r * b.pct, 0) / tot : 0;
    const avgWinR  = wavg(winning,   winPct);
    const avgLossR = Math.abs(wavg(losing, lossPct));
    const avgBeR   = wavg(breakeven, bePct);
    const avgWinPct  = avgWinR  * riskPct * 100;
    const avgLossPct = avgLossR * riskPct * 100;
    const avgBePct   = avgBeR   * riskPct * 100;
    const arr        = avgLossR > 0 ? avgWinR / avgLossR : 0;
    const allBuckets = [...winning, ...losing, ...breakeven];
    const expectancyR   = allBuckets.reduce((s, b) => s + b.r * (b.pct / 100), 0);
    const expectancyPct = allBuckets.reduce((s, b) => s + (b.r * riskPct * 100) * (b.pct / 100), 0);
    const annualNoCmp   = expectancyPct * tpy;
    const qGrowth       = Math.pow(1 + expectancyPct / 100, tpy / 4);
    const annualCmp     = (Math.pow(qGrowth, 4) - 1) * 100;
    const annualAmt     = startCap * annualCmp / 100;
    const proj          = [5, 10, 20].map(y => ({ y, cap: startCap * Math.pow(qGrowth, y * 4) }));
    const fc = v => calc.formatCurrency(v);
    const fp = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    const fr = v => (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';
    const rc = v => v >= 0 ? 'style="background:#f0fdf4"' : 'style="background:#fef2f2"';
    const vc = v => v >= 0 ? 'positive' : 'negative';
    resultsEl.innerHTML = `
      <div class="sim-summary-section">
        <div class="sim-section-title" style="margin-bottom:12px">📊 Summary</div>
        <table class="sim-summary-table"><tbody>
          <tr><td>Win Rate</td><td class="sim-val positive">${winPct.toFixed(2)}%</td></tr>
          <tr ${rc(1)}><td>Avg % Gained per Winning Trade</td><td class="sim-val positive">+${avgWinPct.toFixed(2)}%</td></tr>
          <tr ${rc(-1)}><td>Avg % Lost per Losing Trade</td><td class="sim-val negative">-${avgLossPct.toFixed(2)}%</td></tr>
          <tr><td>Average Gain : Loss (ARR)</td><td class="sim-val ${vc(arr - 1)}">${arr.toFixed(2)}</td></tr>
          <tr ${rc(avgBePct)}><td>Avg % on Breakeven Trades</td><td class="sim-val ${vc(avgBePct)}">${fp(avgBePct)}</td></tr>
          <tr ${rc(expectancyR)}><td>Expectancy per Trade (R)</td><td class="sim-val ${vc(expectancyR)}">${fr(expectancyR)}</td></tr>
          <tr ${rc(expectancyPct)}><td>Expectancy per Trade (%)</td><td class="sim-val ${vc(expectancyPct)}">${fp(expectancyPct)}</td></tr>
          <tr ${rc(annualNoCmp)}><td>Expected Return % (No Compounding)</td><td class="sim-val ${vc(annualNoCmp)}">${fp(annualNoCmp)}</td></tr>
          <tr ${rc(annualCmp)}><td>Expected Return % (Quarterly Compounding)</td><td class="sim-val ${vc(annualCmp)}">${fp(annualCmp)}</td></tr>
          <tr ${rc(annualAmt)}><td>Expected Return Year (Amount ₹)</td><td class="sim-val ${vc(annualAmt)}">${fc(annualAmt)}</td></tr>
        </tbody></table>
        <div style="margin-top:18px">
          <div class="sim-section-title" style="margin-bottom:8px">📈 Long-Term Projections (Quarterly Compounding)</div>
          <table class="sim-summary-table"><tbody>
            ${proj.map(p => `<tr ${rc(p.cap - startCap)}><td>Account Value (${p.y} years)</td><td class="sim-val ${vc(p.cap - startCap)}">${fc(p.cap)}</td></tr>`).join('')}
          </tbody></table>
        </div>
      </div>`;
  }

  function _daysDiff(trades) {
    const dates = trades.map(t => t.finalExit?.date || t.entries?.[0]?.date).filter(Boolean).sort();
    if (dates.length < 2) return 365;
    return Math.max(1, (new Date(dates.at(-1)) - new Date(dates[0])) / (1000*60*60*24));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function _sCard(label, value, sub='', cls='') {
    return `<div class="stat-card"><div class="stat-card-label">${label}</div><div class="stat-card-value ${cls}">${value}</div>${sub ? `<div class="stat-card-sub">${sub}</div>` : ''}</div>`;
  }
  function _simRow(label, value) {
    return `<div class="settings-row"><div class="settings-row-label">${label}</div><div class="fw-600">${value}</div></div>`;
  }
  function _makeLineChart(id, labels, data, label, color='#5b6af0') {
    const ctx = document.getElementById(id)?.getContext('2d');
    if (!ctx) return null;
    return new Chart(ctx, { type: 'line', data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '15', fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { size: 10 }, maxTicksLimit: 8 } }, y: { ticks: { font: { size: 10 } } } } } });
  }
  function _makeBarChart(id, labels, data, label) {
    const ctx = document.getElementById(id)?.getContext('2d');
    if (!ctx) return null;
    const colors  = data.map(v => v >= 0 ? '#22c55e80' : '#ef444480');
    const borders = data.map(v => v >= 0 ? '#22c55e'   : '#ef4444');
    return new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label, data, backgroundColor: colors, borderColor: borders, borderWidth: 1.5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } } } });
  }

  // Scatter chart for Holding Period vs Profit R
  function _makeScatterChart(id, points) {
    const ctx = document.getElementById(id)?.getContext('2d');
    if (!ctx) return null;
    const datasets = [
      { label: 'Win',        data: points.filter(p => p.result === 'Win').map(p => ({ x: p.x, y: p.y })),        backgroundColor: 'rgba(34,197,94,0.65)',  pointRadius: 6 },
      { label: 'Loss',       data: points.filter(p => p.result === 'Loss').map(p => ({ x: p.x, y: p.y })),       backgroundColor: 'rgba(239,68,68,0.65)',  pointRadius: 6 },
      { label: 'Break-even', data: points.filter(p => p.result === 'Break-even').map(p => ({ x: p.x, y: p.y })), backgroundColor: 'rgba(148,163,184,0.65)', pointRadius: 6 },
    ];
    return new Chart(ctx, {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } },
        scales: {
          x: { title: { display: true, text: 'Holding Days', font: { size: 10 } }, ticks: { font: { size: 10 } } },
          y: { title: { display: true, text: 'Profit (R)',    font: { size: 10 } }, ticks: { font: { size: 10 } } }
        }
      }
    });
  }

  return { init, _simRecalc, _simUpdateBucket, _simAddRow, _simDeleteRow, _simAutoFill, _switchCumChart };
})();
