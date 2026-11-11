/**
 * og/lib/gtt-fills.js — notices when a stop GTT has sold shares, so the fill can be booked in the journal.
 *
 * Read only towards the broker. For an open journal position it looks for a GTT that triggered today
 * and whose own sell order (linked by the order id Zerodha puts on the triggered GTT) is final with a
 * filled quantity. It records that as a finished intent (action GTT_STOP_FILL); og/lib/booking.js then
 * writes it into the trade, once. Without the order link nothing is recorded — it never guesses.
 */
'use strict';
const { journalPositions, normSymbol } = require('./reconcile.js');

const FINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const istDate = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);

function findGttFills({ trades, orders, gtts }, now) {
  const journal = journalPositions(trades), today = istDate(now), out = [];
  for (const g of gtts || []) {
    if (g.status !== 'triggered') continue;
    if (g.updated_at && String(g.updated_at).slice(0, 10) !== today) continue;
    const sym = normSymbol(g.condition && g.condition.tradingsymbol);
    if (!journal[sym]) continue;
    for (const leg of g.orders || []) {
      const id = leg.transaction_type === 'SELL' && leg.result && leg.result.order_result && leg.result.order_result.order_id;
      if (!id) continue;
      const o = (orders || []).find(x => String(x.order_id) === String(id));
      const filled = o ? Number(o.filled_quantity) || 0 : 0;
      if (!o || !FINAL.has(o.status) || filled <= 0 || !(Number(o.average_price) > 0)) continue;
      out.push({ symbol: sym, tradeId: journal[sym].tradeIds[0], orderId: String(id), gttId: String(g.id), filled, averagePrice: Number(o.average_price) });
    }
  }
  return out;
}

/** Store each new GTT fill as a finished intent. Returns how many were new. */
async function recordGttFills({ store, snapshot, now = Date.now(), log = () => {} }) {
  const fills = findGttFills(snapshot, now);
  if (!fills.length) return 0;
  const uid = await store.userId();
  let made = 0;
  for (const f of fills) {
    const row = { id: `oi_${now}_${Math.random().toString(36).slice(2, 8)}`, user_id: uid, intent_key: `${f.symbol}:GTTFILL:${f.orderId}`, mode: 'confirm', status: 'done',
      action: 'GTT_STOP_FILL', rule_id: 'LC-09', symbol: f.symbol, exchange: 'NSE', trade_id: f.tradeId, side: 'SELL', qty: f.filled, route: 'GTT',
      would_send: false, guards: [], block_reasons: [], broker_ref: f.orderId, result: { filled: f.filled, averagePrice: f.averagePrice, orderId: f.orderId, gttId: f.gttId },
      detail: { note: 'Sold by the stop GTT at the broker.' }, created_at: new Date(now).toISOString() };
    try { await store.insert('order_intents', [row]); made++; log('gtt fill', { symbol: f.symbol, filled: f.filled, price: f.averagePrice }); }
    catch (e) { if (!/409|23505|duplicate/i.test(e.message)) log('gtt fill not recorded', { symbol: f.symbol, error: e.message.slice(0, 160) }); }
  }
  return made;
}

module.exports = { findGttFills, recordGttFills };
