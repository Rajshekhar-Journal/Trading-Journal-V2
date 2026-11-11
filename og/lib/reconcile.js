/**
 * og/lib/reconcile.js — pure comparison of the journal with the broker. No I/O.
 * P1 only REPORTS differences (drift); it never changes the journal or the broker.
 */
'use strict';

function normSymbol(s) {
  return String(s || '').toUpperCase().trim().replace(/^(NSE|BSE):/, '').replace(/\.(NS|BO)$/, '').replace(/-EQ$/, '');
}

function remainingQty(t) {
  const sum = a => (a || []).reduce((s, x) => s + (Number(x.qty) || 0), 0);
  return sum(t.entries) + sum(t.pyramids) - sum(t.partial_exits || t.partialExits) - (t.final_exit || t.finalExit ? Number((t.final_exit || t.finalExit).qty) || 0 : 0);
}

/** Journal: open real long positions → { SYMBOL: { qty, stop, tradeIds } } */
function journalPositions(trades) {
  const out = {};
  for (const t of trades || []) {
    if (t.closed_at || t.closedAt) continue;
    if (String(t.direction || 'Long').toLowerCase() !== 'long') continue;
    const qty = remainingQty(t);
    if (qty <= 0) continue;
    const sym = normSymbol(t.symbol);
    const p = out[sym] || (out[sym] = { qty: 0, stop: null, tradeIds: [] });
    p.qty += qty;
    p.tradeIds.push(t.id);
    const stop = Number(t.current_stop ?? t.currentStop ?? t.initial_stop ?? t.initialStop) || null;
    if (stop && (p.stop === null || stop > p.stop)) p.stop = stop;
  }
  return out;
}

/** Broker: delivery quantity per symbol = settled holdings + T1 + today's net CNC position. */
function brokerPositions(holdings, positions) {
  const out = {};
  const add = (sym, q) => { if (q) out[sym] = (out[sym] || 0) + q; };
  for (const h of holdings || []) add(normSymbol(h.tradingsymbol), (Number(h.quantity) || 0) + (Number(h.t1_quantity) || 0));
  for (const p of (positions && positions.net) || []) if (p.product === 'CNC') add(normSymbol(p.tradingsymbol), Number(p.quantity) || 0);
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

/** Active sell GTTs per symbol → [{ id, qty, triggers }] */
function activeSellGtts(gtts) {
  const out = {};
  for (const g of gtts || []) {
    if (g.status !== 'active') continue;
    const sells = (g.orders || []).filter(o => o.transaction_type === 'SELL');
    if (!sells.length) continue;
    const sym = normSymbol(g.condition && g.condition.tradingsymbol);
    (out[sym] || (out[sym] = [])).push({
      id: g.id, type: g.type,
      qty: Math.max(...sells.map(o => Number(o.quantity) || 0)),
      triggers: (g.condition.trigger_values || []).map(Number),
    });
  }
  return out;
}

/**
 * @returns [{ kind, symbol, severity, journalQty, brokerQty, detail }]
 * kinds: QTY_MISMATCH, JOURNAL_ONLY, BROKER_ONLY, NO_STOP_GTT, GTT_QTY_MISMATCH, GTT_TRIGGER_MISMATCH, ORPHAN_GTT
 */
function reconcile({ trades, holdings, positions, gtts, tick = 0.05 }) {
  const j = journalPositions(trades), b = brokerPositions(holdings, positions), g = activeSellGtts(gtts);
  const drift = [];
  const push = (kind, symbol, severity, detail = {}) =>
    drift.push({ kind, symbol, severity, journalQty: j[symbol] ? j[symbol].qty : 0, brokerQty: b[symbol] || 0, detail });

  for (const sym of new Set([...Object.keys(j), ...Object.keys(b)])) {
    const jq = j[sym] ? j[sym].qty : 0, bq = b[sym] || 0;
    if (jq && !bq) push('JOURNAL_ONLY', sym, 'high', { note: 'Journal shows an open position; broker holds none.' });
    else if (!jq && bq) push('BROKER_ONLY', sym, 'info', { note: 'Shares held at the broker outside the journal.' });
    else if (jq !== bq) push('QTY_MISMATCH', sym, 'high', { note: 'Journal and broker quantities differ.' });
  }
  for (const sym of Object.keys(j)) {
    const list = g[sym] || [];
    if (!list.length) { push('NO_STOP_GTT', sym, 'info', { note: 'No active sell GTT at the broker for this position.' }); continue; }
    const covered = Math.max(...list.map(x => x.qty));
    if (covered !== j[sym].qty) push('GTT_QTY_MISMATCH', sym, 'high', { gttQty: covered, gttIds: list.map(x => x.id) });
    const stop = j[sym].stop;
    if (stop && !list.some(x => x.triggers.some(t => Math.abs(t - stop) <= tick + 1e-9)))
      push('GTT_TRIGGER_MISMATCH', sym, 'high', { journalStop: stop, gttTriggers: list.flatMap(x => x.triggers) });
  }
  for (const sym of Object.keys(g)) if (!j[sym]) push('ORPHAN_GTT', sym, 'info', { gttIds: g[sym].map(x => x.id), note: 'Sell GTT with no open journal position.' });
  return drift;
}

/**
 * Protection state of every open journal position, from the broker's GTT list (SRS §7).
 *   PROTECTED    an active sell GTT covers exactly the held quantity at the journal stop
 *   PARTIAL      a GTT exists but its quantity or level differs from the position
 *   UNPROTECTED  no active sell GTT
 * (PROTECTING and UNVERIFIED are not decided here: the first needs an order in flight, the second
 *  is what the journal shows when this report is stale.)
 * @returns [{ symbol, state, reason, journalQty, brokerQty, gttQty, gttTrigger, journalStop, gttIds }]
 */
function protection({ trades, holdings, positions, gtts, tick = 0.05 }) {
  const j = journalPositions(trades), b = brokerPositions(holdings, positions), g = activeSellGtts(gtts);
  const lp = lastPrices(holdings, positions);
  return Object.keys(j).sort().map(sym => {
    const list = g[sym] || [], pos = j[sym];
    const row = { symbol: sym, state: 'PROTECTED', reason: 'Stop GTT covers the position.', journalQty: pos.qty, brokerQty: b[sym] || 0,
      gttQty: 0, gttTrigger: null, journalStop: pos.stop, gttIds: list.map(x => x.id), lastPrice: lp[sym] ?? null };
    if (!list.length) return { ...row, state: 'UNPROTECTED', reason: 'No active stop GTT at the broker.' };
    const best = list.reduce((a, x) => (x.qty > a.qty ? x : a));
    row.gttQty = best.qty;
    row.gttTrigger = best.triggers.length ? Math.min(...best.triggers) : null;
    if (list.length > 1) return { ...row, state: 'PARTIAL', reason: `${list.length} sell GTTs on this stock; expected one.` };
    if (best.qty < pos.qty) return { ...row, state: 'PARTIAL', reason: `GTT covers ${best.qty} of ${pos.qty} shares.` };
    if (best.qty > pos.qty) return { ...row, state: 'PARTIAL', reason: `GTT quantity ${best.qty} is above the position ${pos.qty}.` };
    if (pos.stop && !best.triggers.some(t => Math.abs(t - pos.stop) <= tick + 1e-9))
      return { ...row, state: 'PARTIAL', reason: `GTT trigger ${row.gttTrigger} differs from the journal stop ${pos.stop}.` };
    return row;
  });
}

/** Last traded price per symbol as the broker reports it with holdings / positions. */
function lastPrices(holdings, positions) {
  const out = {};
  for (const h of holdings || []) if (Number(h.last_price) > 0) out[normSymbol(h.tradingsymbol)] = Number(h.last_price);
  for (const p of (positions && positions.net) || []) if (Number(p.last_price) > 0) out[normSymbol(p.tradingsymbol)] = Number(p.last_price);
  return out;
}

module.exports = { reconcile, protection, lastPrices, journalPositions, brokerPositions, activeSellGtts, normSymbol, remainingQty };
