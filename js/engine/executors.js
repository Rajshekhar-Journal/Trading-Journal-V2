/**
 * engine/executors.js — turn engine actions into lifecycle records.
 * Paper trades: every action is booked automatically (no user step).
 * Real trades: nothing is booked; the trader acts on the alert and records the fill.
 */
(function (root) {
  const { RULES } = root.TLMRules;

  const LABEL = {
    [RULES.ENTRY]: 'LC-01 Entry', [RULES.ADD_1R]: 'LC-02 1R add', [RULES.LOCK_2R]: 'LC-03 2R lock',
    [RULES.BOOK_5R]: 'LC-04 5R trail', [RULES.BOOK_10R]: 'LC-05 10R trail', [RULES.TRAIL_EXIT]: 'LC-07 Trail exit',
    [RULES.HARD_TRAIL]: 'LC-08 Hard-stop trail', [RULES.HARD_EXIT]: 'LC-09 Hard stop', [RULES.DAY_BRIEF]: 'LC-10 Day start',
  };
  const source = (rule, mode) => `${LABEL[rule] || rule}${mode === 'paper' ? ' (Paper)' : ''}`;

  function _charges(trade, buyTurnover, sellTurnover, settings) {
    if (typeof calc === 'undefined' || !calc.getZerodhaCharges) return 0;   // calc is a script-level const, not a window property
    const c = calc.getZerodhaCharges(trade.tradeType || 'Equity', buyTurnover, sellTurnover, settings, trade.exchange || 'NSE');
    return Math.round((c.total || 0) * 100) / 100;
  }

  function _stopRevision(trade, date, newStop, rule) {
    const oldStop = Number(trade.currentStop ?? trade.initialStop ?? 0);
    if (!(newStop > oldStop)) return trade;
    return {
      ...trade,
      currentStop: newStop,
      stopRevisions: [...(trade.stopRevisions || []), { id: db.generateId('sr'), date, oldStop, newStop, actionSource: source(rule, 'paper'), notes: '' }],
    };
  }

  /**
   * Book engine actions on a paper trade. Returns the updated trade.
   * @param {object} trade    paper trade (with tlmState already updated)
   * @param {Array}  actions  engine actions for this cycle
   * @param {object} ctx      { settings, date: 'YYYY-MM-DD', openQty }
   */
  function applyPaper(trade, actions, { settings, date, openQty }) {
    let t = { ...trade };
    let open = openQty;
    for (const a of actions) {
      const px = a.fill ?? a.price;
      if (a.kind === 'BUY' && a.rule === RULES.ADD_1R) {
        t.pyramids = [...(t.pyramids || []), { id: db.generateId('py'), date, price: px, qty: a.qty, charges: _charges(t, px * a.qty, 0, settings), actionSource: source(a.rule, 'paper'), notes: '' }];
        open += a.qty;
        t = _stopRevision(t, date, a.stop, a.rule);
      } else if (a.kind === 'STOP' || a.kind === 'BRIEF') {
        t = _stopRevision(t, date, a.stop, a.kind === 'BRIEF' ? RULES.HARD_TRAIL : a.rule);
      } else if (a.kind === 'SELL' && a.qty < open) {
        t.partialExits = [...(t.partialExits || []), { id: db.generateId('pe'), date, price: px, qty: a.qty, charges: _charges(t, 0, px * a.qty, settings), actionSource: source(a.rule, 'paper') }];
        open -= a.qty;
      } else if (a.kind === 'SELL' || a.kind === 'EXIT_ALL') {
        t.finalExit = { id: db.generateId('fe'), date, price: px, qty: open, charges: _charges(t, 0, px * open, settings), actionSource: source(a.rule, 'paper') };
        t.closedAt = date;
        open = 0;
      }
      // TRAIL: the tranche lives in tlmState; nothing to book until it is sold.
    }
    return t;
  }

  /** A new paper trade from a confirmed watchlist entry (LC-01). */
  function createPaperTrade({ item, action, plan, state, settings, date }) {
    const t = {
      id: db.generateId('pt'), symbol: item.symbol, sector: item.sector || 'Other',
      tradeType: 'Equity', direction: 'Long', exchange: item.exchange || 'NSE',
      playbookId: '', playbookVersion: '',
      initialStop: action.stop, currentStop: action.stop, rpt: Math.round(plan.riskPerShare * plan.fullQty),
      entries: [], pyramids: [], partialExits: [], finalExit: null, notes: [], alerts: [], tags: [item.sector || 'Other'],
      stopRevisions: [{ id: db.generateId('sr'), date, oldStop: 0, newStop: action.stop, actionSource: source(RULES.ENTRY, 'paper'), notes: `Trigger ₹${item.trigger_price}` }],
      ruleFollowed: true, reviewStatus: 'Paper', rating: 0,
      chartLink: `https://www.tradingview.com/chart/?symbol=NSE:${item.symbol}`,
      cmp: action.price, createdAt: date, closedAt: null, tlmState: state,
    };
    t.entries = [{ id: db.generateId('en'), date, price: action.price, qty: plan.firstQty, charges: _charges(t, action.price * plan.firstQty, 0, settings), notes: `Watchlist trigger ₹${item.trigger_price}` }];
    return t;
  }

  const api = { applyPaper, createPaperTrade, source };
  root.TLMExecutors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
