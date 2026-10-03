/**
 * engine/alert-service.js — turns engine actions into alerts.
 *
 * Message (3 lines):  Alert type · CMP · Suggestion.
 * Sending rules (spec §6.3):
 *   AL-01 same alert (trade + rule) at most once per day
 *   AL-02 re-sent the same day only if the suggested price/qty moved ≥ 1%
 *   AL-03 an Executed alert is never re-sent
 *   AL-05 stop-loss breach on a real trade repeats every 15 min until executed
 * Real alerts go to Telegram (sent by the backend runner) + Alert Dashboard; paper alerts to the dashboard only.
 */
(function (root) {
  const { RULES, ALERT_TYPES } = root.TLMRules;

  const inr = v => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = v => Number(v).toLocaleString('en-IN');

  /** Suggestion text for a real trade (what the trader should do). */
  function suggestion(a) {
    switch (a.kind) {
      case 'BUY':
        return a.rule === RULES.ENTRY
          ? `Buy Qty ${qtyFmt(a.qty)} · Set stop loss ${inr(a.stop)}`
          : `Buy Qty ${qtyFmt(a.qty)} · Revise stop loss to ${inr(a.stop)}`;
      case 'STOP':     return `Revise stop loss to ${inr(a.stop)}`;
      case 'TRAIL':    return `${a.dropped ? 'Cancel previous trail · ' : ''}Trail Qty ${qtyFmt(a.qty)} with stop ${inr(a.trail)}`;
      case 'SELL':     return `Exit Qty ${qtyFmt(a.qty)} at market price`;
      case 'EXIT_ALL': return `Exit Qty ${qtyFmt(a.qty)} (all open) at market price`;
      case 'BRIEF':    return `Set stop loss ${inr(a.stop)} for Qty ${qtyFmt(a.qty)}` + (a.trail ? ` · Trail stop ${inr(a.trail)} for Qty ${qtyFmt(a.trailQty)}` : '');
      default:         return '';
    }
  }

  /** What the paper executor did. */
  function executedText(a) {
    switch (a.kind) {
      case 'BUY':      return `Executed: Bought ${qtyFmt(a.qty)} @ ${inr(a.fill ?? a.price)} · Stop ${inr(a.stop)}`;
      case 'STOP':     return `Executed: Stop loss revised to ${inr(a.stop)}`;
      case 'TRAIL':    return `Executed: ${a.dropped ? 'previous trail dropped · ' : ''}Trailing Qty ${qtyFmt(a.qty)} with stop ${inr(a.trail)}`;
      case 'SELL':
      case 'EXIT_ALL': return `Executed: Sold ${qtyFmt(a.qty)} @ ${inr(a.fill ?? a.price)}`;
      case 'BRIEF':    return `Executed: Stop loss ${inr(a.stop)}` + (a.trail ? ` · Trail ${inr(a.trail)}` : '');
      default:         return '';
    }
  }

  function message({ action, symbol, mode, cmp }) {
    const type = action.r ? `Target reached — ${action.r}R` : (ALERT_TYPES[action.rule] || action.rule);
    const sugg = mode === 'paper' ? executedText(action) : suggestion(action);
    return {
      alertType: type,
      text: `Alert type : ${type} · ${symbol} · ${mode.toUpperCase()}\nCMP        : ${cmp ? inr(cmp) : '—'}\nSuggestion : ${sugg}`,
      suggestionText: sugg,
    };
  }

  /** The number whose ≥1% change allows a same-day resend. */
  const keyValue = a => Number(a.stop ?? a.trail ?? a.price ?? 0);

  /** Decide whether this action should produce a new alert (AL-01..05). */
  function shouldSend({ action, refId, mode, alertsToday, now, params }) {
    const prior = alertsToday.filter(x => (x.trade_id === refId || x.watchlist_id === refId) && x.rule_id === action.rule);
    if (!prior.length) return true;
    const last = prior.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    if (last.status === 'Executed') return false;                                       // AL-03
    if (action.rule === RULES.HARD_EXIT && mode === 'real') {                             // AL-05
      return now - Date.parse(last.created_at) >= params.breachRepeatMin * 60000;
    }
    const before = Number(last.suggestion?.value || 0);                                 // AL-02
    const nowV = keyValue(action);
    return before > 0 && Math.abs(nowV - before) / before * 100 >= params.alertResendPct;
  }

  /**
   * Notifier port: (text, settings) → 'sent' | 'failed' | 'skipped'.
   * Only the backend runner sets one (Telegram, bot token held as a server secret).
   * In the browser there is none, so a fallback browser cycle logs alerts to the dashboard only.
   */
  let _notifier = null;
  const setNotifier = fn => { _notifier = fn; };
  async function _notify(settings, text) {
    if (!_notifier) return 'skipped';
    try { return await _notifier(text, settings); } catch { return 'failed'; }
  }

  /**
   * Log (and for real trades, send) one alert if the sending rules allow it.
   * @returns the alert_log row, or null when suppressed.
   */
  async function dispatch({ action, symbol, mode, tradeId, watchlistId, stage, cmp, settings, params, alertsToday, now }) {
    const refId = tradeId || watchlistId;
    if (!shouldSend({ action, refId, mode, alertsToday, now, params })) return null;
    const msg = message({ action, symbol, mode, cmp });
    const telegram = mode === 'real' ? await _notify(settings, msg.text) : 'skipped';
    const row = await db.insertAlert({
      trade_id: tradeId || null, watchlist_id: watchlistId || null, mode, symbol,
      rule_id: action.rule, alert_type: msg.alertType, stage: stage ?? null, cmp: cmp || null,
      suggestion: { kind: action.kind, qty: action.qty ?? null, stop: action.stop ?? null, trail: action.trail ?? null,
                    price: action.fill ?? action.price ?? null, text: msg.suggestionText, value: keyValue(action) },
      message: msg.text,
      status: mode === 'paper' ? 'Executed' : 'New',
      executed_at: mode === 'paper' ? new Date(now).toISOString() : null,
      telegram_status: telegram,
    });
    alertsToday.push(row);
    return row;
  }

  /** Mark a real trade's open alerts Executed when the trader records the matching transaction. */
  async function markExecuted(tradeId, kinds) {
    const open = (await db.getAlerts({ limit: 200 })).filter(a => a.trade_id === tradeId && a.status === 'New' && kinds.includes(a.suggestion?.kind));
    for (const a of open) await db.updateAlert(a.id, { status: 'Executed', executed_at: new Date().toISOString() });
  }

  const api = { dispatch, shouldSend, message, suggestion, markExecuted, setNotifier };
  root.TLMAlerts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
