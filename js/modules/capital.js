/**
 * capital.js — Module 06: Capital Management
 * Fixes: Remove risk config editor (redirect to Settings), add CAGR + Return% metrics.
 */
const capitalModule = (() => {
  let _equityChart = null;

  async function init() {
    await _renderSummaryCards();
    await _renderEquityCurve();
    await _renderRiskInfo();   // Read-only info panel (editing moved to Settings)
    await _renderLedger();
    _setupAddBtn();
  }

  // ── Summary Cards ──────────────────────────────────────────────────────────
  async function _renderSummaryCards() {
    const el = document.getElementById('cap-summary-cards');
    if (!el) return;
    const capital      = await db.getCapital();
    const closedTrades = await db.getClosedTrades();
    const openTrades   = await db.getOpenTrades();
    const realizedPnl  = calc.getTotalPnl(closedTrades);
    const equity       = calc.getCurrentEquity(capital, realizedPnl);
    const settings     = await db.getSettings();
    const netDeposits  = calc.getNetDeposits(capital);
    const currentR     = calc.getCurrentR(equity, settings);
    const exposure     = openTrades.reduce((s,t) => s + calc.getTradeMetrics(t).exposure, 0);
    const availCash    = equity - exposure;

    // Starting capital = first deposit
    const sorted   = capital.slice().sort((a,b) => a.date.localeCompare(b.date));
    const startCap = sorted.length > 0 ? sorted[0].amount : 0;

    // Drawdown from peak
    const dailyPnlArr = calc.getDailyPnl(closedTrades);
    let peakCum = 0;
    const lastCum = dailyPnlArr.length > 0 ? dailyPnlArr[dailyPnlArr.length-1].cumPnl : 0;
    dailyPnlArr.forEach(d => { if (d.cumPnl > peakCum) peakCum = d.cumPnl; });
    const dd = peakCum > 0 ? ((lastCum - peakCum) / peakCum) * 100 : 0;

    // CAGR & Absolute Return
    const firstDepDate = sorted.length > 0 ? new Date(sorted[0].date) : new Date();
    const years        = Math.max(0.01, (new Date() - firstDepDate) / (365.25 * 24 * 3600 * 1000));
    const cagr         = startCap > 0 ? (Math.pow(equity / startCap, 1 / years) - 1) * 100 : 0;
    const absReturn    = netDeposits > 0 ? ((equity - netDeposits) / netDeposits) * 100 : 0;

    const cards = [
      { label:'Starting Capital', value:calc.formatCurrency(startCap), sub:'First deposit', icon:'🏦' },
      { label:'Current Equity',   value:calc.formatCurrency(equity),   sub:`Realized P&L: ${calc.formatCurrency(realizedPnl)}`, icon:'💰', cls: equity>startCap?'positive':'' },
      { label:'Net Deposits',     value:calc.formatCurrency(netDeposits), sub:'Deposits − Withdrawals', icon:'💳' },
      { label:'Current RPT',      value:calc.formatCurrency(currentR), sub:settings?.riskManagement?.riskMode==='Dynamic'?`${settings.riskManagement.riskPercent||1}% of equity`:'Fixed risk', icon:'🎯' },
      { label:'Available Cash',   value:calc.formatCurrency(availCash), sub:`Exposure: ${calc.formatCurrency(exposure)}`, icon:'💵', cls:availCash>0?'positive':'negative' },
      { label:'Drawdown (Peak)',  value:`${Math.abs(dd).toFixed(1)}%`, sub:'From realized peak', icon:'📉', cls:dd<-10?'negative':'' },
      { label:'CAGR',             value:`${cagr >= 0 ? '+' : ''}${cagr.toFixed(1)}%`, sub:`${years.toFixed(1)} year${years>=2?'s':''}`, icon:'📈', cls:cagr>=0?'positive':'negative' },
      { label:'Absolute Return',  value:`${absReturn>=0?'+':''}${absReturn.toFixed(1)}%`, sub:'On net deposits', icon:'🏆', cls:absReturn>=0?'positive':'negative' },
    ];
    el.innerHTML = cards.map(c => `
      <div class="stat-card">
        <div class="stat-card-icon">${c.icon}</div>
        <div class="stat-card-label">${c.label}</div>
        <div class="stat-card-value ${c.cls==='positive'?'text-success':c.cls==='negative'?'text-danger':''}">${c.value}</div>
        <div class="stat-card-sub">${c.sub}</div>
      </div>`).join('');
  }

  // ── Equity Curve ───────────────────────────────────────────────────────────
  async function _renderEquityCurve() {
    if (_equityChart) { try { _equityChart.destroy(); } catch(e) {} _equityChart = null; }
    const capital      = await db.getCapital();
    const closedTrades = await db.getClosedTrades();
    const netDeposits  = calc.getNetDeposits(capital);
    const dailyArr     = calc.getDailyPnl(closedTrades);
    const labels = ['Start', ...dailyArr.map(d => d.date.slice(5))];
    const data   = [netDeposits, ...dailyArr.map(d => Math.round(netDeposits + d.cumPnl))];
    const ctx    = document.getElementById('chart-equity-curve')?.getContext('2d');
    if (!ctx) return;
    _equityChart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [{ label:'Equity', data, borderColor:'#5b6af0', backgroundColor:'rgba(91,106,240,0.1)', fill:true, tension:0.3, pointRadius:1.5, borderWidth:2 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ font:{size:10}, maxTicksLimit:10 } }, y:{ ticks:{ font:{size:10}, callback: v => '₹'+(v/1000).toFixed(0)+'K' } } } }
    });
  }

  // ── Risk Info Panel (read-only — editing is in Settings > Risk Management) ─
  async function _renderRiskInfo() {
    const el = document.getElementById('cap-risk-config');
    if (!el) return;
    const settings = await db.getSettings();
    const capital  = await db.getCapital();
    const closedT  = await db.getClosedTrades();
    const realPnl  = calc.getTotalPnl(closedT);
    const equity   = calc.getCurrentEquity(capital, realPnl);
    const rm       = settings?.riskManagement || {};
    const currentR = calc.getCurrentR(equity, settings);

    el.innerHTML = `
      <div style="padding:16px">
        <div class="form-section-title" style="margin-bottom:12px">Risk Configuration</div>
        <div class="settings-row">
          <div class="settings-row-label">Risk Mode</div>
          <div><span class="badge badge-primary">${rm.riskMode||'Dynamic'}</span></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Current RPT</div>
          <div class="font-mono fw-600 text-primary">${calc.formatCurrency(currentR)}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">${rm.riskMode==='Fixed'?'Fixed Amount':'Risk %'}</div>
          <div>${rm.riskMode==='Fixed'?calc.formatCurrency(rm.fixedRiskAmount||0):(rm.riskPercent||1)+'% of equity'}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Max Portfolio Heat</div>
          <div>${rm.maxPortfolioHeat||5}%</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Warning Level</div>
          <div>${rm.warningPortfolioHeat||3}%</div>
        </div>
        <div style="margin-top:14px">
          <a href="#" onclick="app.navigate('settings');return false;" class="btn btn-secondary btn-sm">⚙ Edit Risk Config in Settings →</a>
        </div>
      </div>`;
  }

  // ── Ledger ─────────────────────────────────────────────────────────────────
  async function _renderLedger() {
    const tbody = document.getElementById('cap-ledger-body');
    if (!tbody) return;
    const capital = (await db.getCapital()).slice().sort((a,b) => a.date.localeCompare(b.date));
    if (!capital.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="no-data">No capital transactions yet.</div></td></tr>`;
      return;
    }
    let balance = 0;
    tbody.innerHTML = capital.map(txn => {
      if (txn.type==='Deposit')    balance += txn.amount;
      else if (txn.type==='Withdrawal') balance -= txn.amount;
      else balance += txn.amount;
      const cls  = txn.type==='Deposit'?'txn-deposit':txn.type==='Withdrawal'?'txn-withdrawal':'txn-adjustment';
      const sign = txn.type==='Withdrawal'?'−':'+';
      return `<tr>
        <td>${calc.formatDate(txn.date)}</td>
        <td><span class="${cls} fw-600">${txn.type}</span></td>
        <td class="${cls} font-mono fw-600">${sign}${calc.formatCurrency(txn.amount)}</td>
        <td class="font-mono">${calc.formatCurrency(balance)}</td>
        <td>${txn.account||'Zerodha'}</td>
        <td>${txn.remarks||'—'}</td>
        <td style="display:flex;gap:6px;">
          <button class="btn btn-secondary btn-xs" onclick="capitalModule._editTxn('${txn.id}')">✏ Edit</button>
          <button class="btn btn-danger btn-xs" onclick="capitalModule._deleteTxn('${txn.id}')">✕ Delete</button>
        </td>
      </tr>`;
    }).join('');
  }

  async function _deleteTxn(id) {
    if (!confirm('Delete this transaction?')) return;
    await db.deleteCapitalTransaction(id);
    app.toast('Transaction deleted', 'success');
    await init();
  }

  async function _editTxn(id) {
    const capital = await db.getCapital();
    const txn = capital.find(c => c.id === id);
    if (!txn) { app.toast('Transaction not found', 'error'); return; }

    const content = `<div class="form-grid">
      <div class="form-group"><label class="form-label">Transaction Type</label>
        <select class="form-select" id="cap-type">
          <option ${txn.type==='Deposit'?'selected':''}>Deposit</option>
          <option ${txn.type==='Withdrawal'?'selected':''}>Withdrawal</option>
          <option ${txn.type==='Adjustment'?'selected':''}>Adjustment</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Date</label>
        <input class="form-input" type="date" id="cap-date" value="${txn.date}">
      </div>
      <div class="form-group"><label class="form-label">Amount (₹) *</label>
        <input class="form-input" type="number" id="cap-amount" min="1" value="${txn.amount}">
      </div>
      <div class="form-group"><label class="form-label">Account</label>
        <input class="form-input" id="cap-account" value="${txn.account||txn.note||'Zerodha'}">
      </div>
      <div class="form-group form-full"><label class="form-label">Remarks</label>
        <input class="form-input" id="cap-remarks" value="${txn.remarks||''}" placeholder="e.g. Monthly top-up">
      </div>
    </div>`;

    app.openModal('Edit Capital Transaction', content, [
      { id: 'cancel', label: 'Cancel', class: 'btn-secondary', onClick: app.closeModal },
      { id: 'save', label: 'Update Transaction', class: 'btn-primary', onClick: async () => {
        const type    = document.getElementById('cap-type').value;
        const date    = document.getElementById('cap-date').value;
        const amount  = parseFloat(document.getElementById('cap-amount').value);
        const account = document.getElementById('cap-account').value || 'Zerodha';
        const remarks = document.getElementById('cap-remarks').value;
        if (!date || !amount || amount <= 0) { app.toast('Please fill Date and Amount', 'error'); return; }
        await db.saveCapitalTransaction({ id, type, date, amount, account, remarks });
        app.closeModal();
        app.toast('Transaction updated', 'success');
        await init();
      }}
    ]);
  }

  // ── Add Transaction ────────────────────────────────────────────────────────
  function _setupAddBtn() {
    const btn = document.getElementById('btn-add-capital');
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => {
      const today = new Date().toISOString().split('T')[0];
      const content = `<div class="form-grid">
        <div class="form-group"><label class="form-label">Transaction Type</label>
          <select class="form-select" id="cap-type"><option>Deposit</option><option>Withdrawal</option><option>Adjustment</option></select>
        </div>
        <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="cap-date" value="${today}"></div>
        <div class="form-group"><label class="form-label">Amount (₹) *</label><input class="form-input" type="number" id="cap-amount" min="1" placeholder="e.g. 100000"></div>
        <div class="form-group"><label class="form-label">Account</label><input class="form-input" id="cap-account" value="Zerodha"></div>
        <div class="form-group form-full"><label class="form-label">Remarks</label><input class="form-input" id="cap-remarks" placeholder="e.g. Monthly top-up"></div>
      </div>`;
      app.openModal('Add Capital Transaction', content, [
        { id:'cancel', label:'Cancel', class:'btn-secondary', onClick: app.closeModal },
        { id:'save', label:'Add Transaction', class:'btn-primary', onClick: async () => {
          const type    = document.getElementById('cap-type').value;
          const date    = document.getElementById('cap-date').value;
          const amount  = parseFloat(document.getElementById('cap-amount').value);
          const account = document.getElementById('cap-account').value || 'Zerodha';
          const remarks = document.getElementById('cap-remarks').value;
          if (!date||!amount||amount<=0) { app.toast('Please fill Date and Amount','error'); return; }
          await db.saveCapitalTransaction({ id:db.generateId('cap'), type, date, amount, account, remarks });
          app.closeModal();
          app.toast(`${type} of ${calc.formatCurrency(amount)} added`,'success');
          await init();
        }}
      ]);
    });
  }

  return { init, _deleteTxn, _editTxn };
})();
