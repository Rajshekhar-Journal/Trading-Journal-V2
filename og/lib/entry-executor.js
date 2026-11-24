/**
 * og/lib/entry-executor.js — carries out APPROVED buy intents: first entries and adds.
 *
 * The lifecycle engine decides; this file only executes. It handles intents with
 * mode = 'confirm', action = 'ENTRY' or 'ADD', status = 'approved' (approved by you, or automatically
 * by the database in Full Auto mode). For each one it
 *   1. claims it (approved → sending, once),
 *   2. re-reads the broker, the journal and your settings and re-checks everything at the moment of use,
 *   3. sends ONE marketable limit order, validity IOC (fill what the market gives at or below the limit now, cancel the rest),
 *   4. reads the result from the broker and records what was filled (done / failed / unknown).
 * It never retries and never chases the price: a fill of only part of the quantity is recorded as it is.
 * It does not write the journal; the journal engine books the fill and then proposes the stop GTT for the filled quantity.
 */
'use strict';
const { journalPositions, brokerPositions, protection, lastPrices, normSymbol } = require('./reconcile.js');
const { tagOf } = require('./exit-executor.js');

const FINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const BUYS = new Set(['ENTRY', 'ADD']);
const istMinute = ms => Math.floor(((ms / 60000) + 330) % 1440);

function createEntryExecutor({ broker, store, log = () => {}, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)),
  entryWindow = [560, 915], fillWaitSec = 20, pollMs = 1000, fundsUtilisationPct = 98, protect = null }) {

  /** Right after a fill: the stop GTT must cover every share now held (C1). */
  async function afterBuy(uid, intent, r) {
    if (r !== 'done' || !protect) return r;
    try { const p = await protect(uid, { symbol: intent.symbol, exchange: intent.exchange || 'NSE', trigger: Number(intent.stop_price) || null, why: `after ${intent.action} fill`, intentId: intent.id }); await audit(uid, intent, 'gtt_after_buy', p); }
    catch (e) { await audit(uid, intent, 'gtt_after_buy_failed', { reason: e.message }); }
    return r;
  }

  async function audit(uid, intent, event, detail = {}) {
    try {
      await store.insert('order_audit', [{ id: `${intent.id}:${now()}:${Math.random().toString(36).slice(2, 8)}`, user_id: uid, intent_id: intent.id,
        symbol: intent.symbol, event, detail, at: new Date(now()).toISOString() }]);
    } catch (e) { log('audit write failed', { error: e.message.slice(0, 120) }); }
  }
  const move = (intent, from, to, result = null, brokerRef = null) =>
    store.rpc('exec_intent_transition', { p_id: intent.id, p_from: from, p_to: to, p_result: result, p_broker_ref: brokerRef });

  async function snapshot(uid) {
    const [orders, gtts, holdings, positions, margins, trades, settings] = await Promise.all([broker.orders(), broker.gtts(), broker.holdings(), broker.positions(), broker.margins(),
      store.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,closed_at&user_id=eq.${uid}&closed_at=is.null`),
      store.select('settings', `select=data&user_id=eq.${uid}`)]);
    const eq = margins && margins.equity;
    return { orders: orders || [], gtts: gtts || [], trades, holdings, positions, journal: journalPositions(trades), brokerQty: brokerPositions(holdings, positions),
      last: lastPrices(holdings, positions), funds: eq ? Number((eq.available && eq.available.live_balance) ?? eq.net) : null,
      x: ((settings[0] || {}).data || {}).execution || {} };
  }

  /** Checks at the time of use. Returns a refusal reason, or null when the buy may be sent. */
  function refuse(intent, s) {
    const sym = normSymbol(intent.symbol), pos = s.journal[sym];
    if (!BUYS.has(intent.action)) return 'not a buy';
    if (!protect) return 'stop-GTT placement is off at the gateway — a buy is never sent without its stop';
    if (!(Number(intent.stop_price) > 0)) return 'no stop price on the buy — a buy is never sent without its stop';
    if (!Number.isInteger(intent.qty) || intent.qty <= 0) return 'quantity is not a positive whole number';
    if (!(Number(intent.limit_price) > 0)) return 'limit price missing';
    if (s.x.killSwitch) return 'the kill switch is on';
    const minute = istMinute(now());
    if (minute < entryWindow[0] || minute > entryWindow[1]) return 'outside the entry window';
    if (intent.action === 'ENTRY' && pos) return `${sym} is already open in the journal (${pos.qty} shares) — an entry is for a new position`;
    if (intent.action === 'ADD' && !pos) return 'no open journal position to add to';
    // A stock you do not hold yet has no broker price here (the free Kite plan has no quotes). The limit price on the IOC order is the cap:
    // it can only fill at or below the limit. A known broker price above the limit, or a stop at or above the price, stops the order.
    const ltp = s.last[sym] || null, ref = Number(intent.ref_price) || null;
    if (ltp && ltp > Number(intent.limit_price)) return `price ${ltp} is already above the limit ${intent.limit_price} — not sent`;
    if (Number(intent.stop_price) > 0 && !(Number(intent.stop_price) < (ltp || ref || Number(intent.limit_price)))) return `the stop ${intent.stop_price} is not below the price`;
    const value = intent.qty * Number(intent.limit_price);
    if (Number(s.x.maxOrderValue) > 0 && value > Number(s.x.maxOrderValue)) return `order value ₹${Math.round(value)} is above the cap ₹${s.x.maxOrderValue}`;
    if (s.funds === null || value > s.funds * fundsUtilisationPct / 100) return s.funds === null ? 'broker funds unknown' : `order value ₹${Math.round(value)} is more than the available funds ₹${Math.round(s.funds)}`;
    const bad = protection({ trades: s.trades, holdings: s.holdings, positions: s.positions, gtts: s.gtts }).filter(p => p.state !== 'PROTECTED');
    if (bad.length) return `no new risk while a position is not protected: ${bad.map(p => p.symbol).join(', ')}`;
    const live = s.orders.find(o => normSymbol(o.tradingsymbol) === sym && o.transaction_type === 'BUY' && !FINAL.has(o.status));
    if (live) return `a buy order is already live on this stock (order ${live.order_id}, ${live.status})`;
    return null;
  }

  async function watch(orderId) {
    const end = now() + fillWaitSec * 1000;
    for (;;) {
      let o = null;
      try { o = ((await broker.orders()) || []).find(x => String(x.order_id) === String(orderId)); } catch (_) { /* keep trying until the deadline */ }
      if (o && FINAL.has(o.status)) return o;
      if (now() >= end) return o || null;
      await sleep(pollMs);
    }
  }

  async function conclude(uid, intent, from, orderId, o) {
    const filled = o ? Number(o.filled_quantity) || 0 : 0;
    const res = { orderId: String(orderId), tag: tagOf(intent.id), filled, averagePrice: o ? Number(o.average_price) || null : null, brokerStatus: o ? o.status : null };
    if (!o || !FINAL.has(o.status)) {
      await move(intent, from, 'unknown', { ...res, reason: 'the order is not final at the broker yet — nothing else will be sent' }, String(orderId));
      await audit(uid, intent, 'not_final', res);
      return 'unknown';
    }
    if (filled > 0) {
      if (filled < intent.qty) res.note = `partly filled: ${filled} of ${intent.qty}; the rest was cancelled (IOC) and is not chased`;
      await move(intent, from, 'done', res, String(orderId));
      await audit(uid, intent, 'done', res);
      return 'done';
    }
    res.reason = o.status === 'REJECTED' ? 'broker rejected the buy: ' + (o.status_message || 'no reason given') : 'nothing filled at or below the limit (IOC); the order was cancelled';
    await move(intent, from, 'failed', res, String(orderId));
    await audit(uid, intent, 'failed', res);
    return 'failed';
  }

  async function runOne(uid, intent) {
    if (intent.expires_at && Date.parse(intent.expires_at) < now()) { await move(intent, 'approved', 'expired', { reason: 'approval expired before it could be sent' }); return 'expired'; }
    if (!(await move(intent, 'approved', 'sending'))) return 'skipped';
    await audit(uid, intent, 'claimed');
    let s;
    try { s = await snapshot(uid); }
    catch (e) { await move(intent, 'sending', 'failed', { reason: 'could not read broker state: ' + e.message }); await audit(uid, intent, 'failed', { reason: e.message }); return 'failed'; }
    const why = refuse(intent, s);
    if (why) { await move(intent, 'sending', 'failed', { reason: why }); await audit(uid, intent, 'refused', { reason: why }); return 'failed'; }

    const sym = normSymbol(intent.symbol), tag = tagOf(intent.id);
    const already = s.orders.find(o => o.tag === tag);                        // this intent's order exists → never send again
    if (already) { await audit(uid, intent, 'adopted_existing_order', { orderId: already.order_id }); return afterBuy(uid, intent, await conclude(uid, intent, 'sending', already.order_id, await watch(already.order_id))); }

    await audit(uid, intent, 'sending_buy', { symbol: sym, qty: intent.qty, limit: Number(intent.limit_price), tag });
    let orderId;
    try { orderId = (await broker.placeBuyIoc({ symbol: sym, exchange: intent.exchange || 'NSE', qty: intent.qty, limit: Number(intent.limit_price), tag })).orderId; }
    catch (e) {
      if (e.errorType === 'NetworkException') {                                // outcome not known: look for the tag next pass, never resend
        await move(intent, 'sending', 'unknown', { tag, reason: e.message }); await audit(uid, intent, 'unknown', { reason: e.message }); return 'unknown';
      }
      await move(intent, 'sending', 'failed', { reason: 'broker refused the buy: ' + e.message }); await audit(uid, intent, 'broker_refused', { reason: e.message });
      return 'failed';
    }
    await audit(uid, intent, 'buy_placed', { orderId });
    return afterBuy(uid, intent, await conclude(uid, intent, 'sending', orderId, await watch(orderId)));
  }

  /** An intent whose outcome was unclear: find its order at the broker by id or tag. Never resend. */
  async function finishUnknown(uid, intent) {
    const tag = tagOf(intent.id), ref = intent.broker_ref || (intent.result && intent.result.orderId);
    const o = ((await broker.orders()) || []).find(x => (ref && String(x.order_id) === String(ref)) || x.tag === tag);
    if (!o) {
      await move(intent, 'unknown', 'failed', { reason: 'the buy did not reach the broker; not retried' });
      await audit(uid, intent, 'failed_after_unknown');
      return 'failed';
    }
    if (!FINAL.has(o.status)) { const w = await watch(o.order_id); if (!w || !FINAL.has(w.status)) return 'unknown'; return afterBuy(uid, intent, await conclude(uid, intent, 'unknown', o.order_id, w)); }
    return afterBuy(uid, intent, await conclude(uid, intent, 'unknown', o.order_id, o));
  }

  async function runOnce({ enabled }) {
    const out = { done: 0, failed: 0, unknown: 0, expired: 0, skipped: 0 };
    if (!enabled || typeof broker.placeBuyIoc !== 'function') return out;
    const uid = await store.userId();
    const q = st => `select=*&user_id=eq.${uid}&mode=eq.confirm&action=in.(ENTRY,ADD)&status=eq.${st}&order=created_at.asc`;
    for (const intent of await store.select('order_intents', q('unknown'))) out[await finishUnknown(uid, intent)]++;
    for (const intent of await store.select('order_intents', q('approved'))) {   // strictly one at a time
      const r = await runOne(uid, intent);
      out[r]++;
      log('buy', { symbol: intent.symbol, action: intent.action, result: r });
    }
    return out;
  }

  return { runOnce, refuse };
}

module.exports = { createEntryExecutor };
