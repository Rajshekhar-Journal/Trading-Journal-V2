/**
 * og/lib/exit-executor.js — carries out APPROVED exit intents (Phase 4, CONFIRM mode).
 *
 * The lifecycle engine decides the exit; you approve it; this file only executes it. It handles
 * mode = 'confirm', action = 'EXIT_PARTIAL' | 'EXIT_ALL', status = 'approved'. For each one it
 *   1. claims it (approved → sending, compare-and-swap, so it runs once),
 *   2. re-reads the journal and the broker and re-checks everything at the moment of use,
 *   3. partial exit: lowers the stop GTT to the remaining quantity FIRST,
 *   4. sends ONE market sell (automatic market protection) carrying a tag unique to the intent,
 *   5. watches it; if it is not filled in time it cancels it and waits for the broker to confirm,
 *   6. full exit: deletes the stop GTT after the sell is completely filled.
 * It never sends a second sell for the same intent and never while another sell is live on the stock.
 * It does not book the exit in the journal: record the fill there as you do today (Phase 4b).
 */
'use strict';
const crypto = require('crypto');
const { journalPositions, brokerPositions, activeSellGtts, lastPrices, normSymbol } = require('./reconcile.js');

const FINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const EXITS = new Set(['EXIT_PARTIAL', 'EXIT_ALL']);
const tagOf = id => 'TJ' + crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16).toUpperCase();   // ≤ 20 chars, letters and digits
const istMinute = ms => Math.floor(((ms / 60000) + 330) % 1440);

function createExitExecutor({ broker, store, log = () => {}, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)),
  exitWindow = [556, 925], fillWaitSec = 20, cancelWaitSec = 10, pollMs = 2000 }) {

  async function audit(uid, intent, event, detail = {}) {
    try {
      await store.insert('order_audit', [{ id: `${intent.id}:${now()}:${Math.random().toString(36).slice(2, 8)}`, user_id: uid, intent_id: intent.id,
        symbol: intent.symbol, event, detail, at: new Date(now()).toISOString() }]);
    } catch (e) { log('audit write failed', { error: e.message.slice(0, 120) }); }
  }
  const move = (intent, from, to, result = null, brokerRef = null) =>
    store.rpc('exec_intent_transition', { p_id: intent.id, p_from: from, p_to: to, p_result: result, p_broker_ref: brokerRef });

  async function snapshot(uid) {
    const [orders, gtts, holdings, positions, trades] = await Promise.all([broker.orders(), broker.gtts(), broker.holdings(), broker.positions(),
      store.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,closed_at&user_id=eq.${uid}&closed_at=is.null`)]);
    return { orders: orders || [], gtts: gtts || [], journal: journalPositions(trades), brokerQty: brokerPositions(holdings, positions),
      sellGtts: activeSellGtts(gtts), last: lastPrices(holdings, positions) };
  }

  /** Checks at the time of use. Returns a refusal reason, or null when the sell may be sent. */
  function refuse(intent, s) {
    const sym = normSymbol(intent.symbol), pos = s.journal[sym];
    if (!EXITS.has(intent.action)) return 'not an exit';
    if (!Number.isInteger(intent.qty) || intent.qty <= 0) return 'quantity is not a positive whole number';
    const minute = istMinute(now());
    if (minute < exitWindow[0] || minute > exitWindow[1]) return 'outside market hours for exits';
    if (!pos) return 'no open journal position for this stock any more';
    if (intent.action === 'EXIT_ALL' && pos.qty !== intent.qty) return `journal position is now ${pos.qty}, the exit was for ${intent.qty}`;
    if (intent.action === 'EXIT_PARTIAL' && intent.qty >= pos.qty) return `partial exit of ${intent.qty} is not smaller than the position ${pos.qty}`;
    const held = s.brokerQty[sym] || 0;
    if (held < intent.qty) return `broker holds ${held}, fewer than ${intent.qty} — never sell more than is held`;
    const live = s.orders.find(o => normSymbol(o.tradingsymbol) === sym && o.transaction_type === 'SELL' && !FINAL.has(o.status));
    if (live) return `a sell order is already live on this stock (order ${live.order_id}, ${live.status}) — one sell at a time`;
    if ((s.sellGtts[sym] || []).length > 1) return 'more than one sell GTT exists on this stock — remove the extra ones on Kite first';
    return null;
  }

  /** Watch one order to a final state; cancel it if it does not fill in time. Never sends anything new. */
  async function watch(orderId) {
    const find = async () => ((await broker.orders()) || []).find(o => String(o.order_id) === String(orderId));
    const until = async (sec, pred) => {
      const end = now() + sec * 1000;
      for (;;) {
        let o = null;
        try { o = await find(); } catch (_) { /* keep trying until the deadline */ }
        if (o && pred(o)) return o;
        if (now() >= end) return o;
        await sleep(pollMs);
      }
    };
    let o = await until(fillWaitSec, x => FINAL.has(x.status));
    if (o && FINAL.has(o.status)) return { order: o, cancelled: false };
    try { await broker.cancelOrder(orderId); } catch (e) { log('cancel request failed', { orderId, error: e.message.slice(0, 120) }); }
    o = await until(cancelWaitSec, x => FINAL.has(x.status));
    return { order: o, cancelled: true };
  }

  /** Turn a watched order into the intent's final status. */
  async function conclude(uid, intent, from, orderId, w, extra = {}) {
    const o = w.order, filled = o ? Number(o.filled_quantity) || 0 : 0;
    const res = { orderId: String(orderId), tag: tagOf(intent.id), filled, averagePrice: o ? Number(o.average_price) || null : null, brokerStatus: o ? o.status : null, ...extra };
    if (!o || !FINAL.has(o.status)) {
      await move(intent, from, 'unknown', { ...res, reason: 'order is still open at the broker and the cancel is not confirmed — no other sell will be sent' }, String(orderId));
      await audit(uid, intent, 'cancel_not_confirmed', res);
      return 'unknown';
    }
    if (o.status === 'COMPLETE' && filled >= intent.qty) {
      if (intent.action === 'EXIT_ALL') res.gtt = await removeGtt(uid, intent);
      await move(intent, from, 'done', res, String(orderId));
      await audit(uid, intent, 'done', res);
      return 'done';
    }
    res.reason = o.status === 'REJECTED' ? 'broker rejected the sell: ' + (o.status_message || 'no reason given')
      : filled > 0 ? `only ${filled} of ${intent.qty} sold; the rest was cancelled` : 'not filled in time; the order was cancelled';
    await move(intent, from, 'failed', res, String(orderId));
    await audit(uid, intent, 'failed', res);
    return 'failed';
  }

  /** After a full exit the stop GTT has nothing left to protect. Returns a short note for the result. */
  async function removeGtt(uid, intent) {
    const sym = normSymbol(intent.symbol);
    try {
      const list = activeSellGtts(await broker.gtts())[sym] || [];
      if (!list.length) return 'no stop GTT to delete';
      for (const g of list) await broker.deleteGtt(g.id);
      const left = activeSellGtts(await broker.gtts())[sym] || [];
      await audit(uid, intent, 'gtt_deleted', { gttIds: list.map(g => g.id), stillThere: left.map(g => g.id) });
      return left.length ? 'SOLD, but the stop GTT is still listed — delete it on Kite' : 'stop GTT deleted';
    } catch (e) {
      await audit(uid, intent, 'gtt_delete_failed', { reason: e.message });
      return 'SOLD, but the stop GTT could not be deleted — delete it on Kite: ' + e.message;
    }
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
    const already = s.orders.find(o => o.tag === tag);                       // defensive: this intent's order exists → never send again
    if (already) { await audit(uid, intent, 'adopted_existing_order', { orderId: already.order_id }); return conclude(uid, intent, 'sending', already.order_id, await watch(already.order_id)); }

    // Partial exit: bring the stop GTT down to what will remain BEFORE selling, so it can never oversell.
    const extra = {};
    if (intent.action === 'EXIT_PARTIAL') {
      const g = (s.sellGtts[sym] || [])[0], remaining = s.journal[sym].qty - intent.qty;
      if (g && g.qty > remaining) {
        const raw = s.gtts.find(x => String(x.id) === String(g.id));
        const sell = (raw.orders || []).find(o => o.transaction_type === 'SELL');
        const spec = { symbol: sym, exchange: intent.exchange || 'NSE', trigger: Math.min(...g.triggers), limit: Number(sell.price), qty: remaining, lastPrice: s.last[sym] };
        await audit(uid, intent, 'reducing_gtt', { gttId: g.id, from: g.qty, to: remaining });
        try { await broker.modifyStopGtt(g.id, spec); extra.gtt = `stop GTT reduced to ${remaining}`; }
        catch (e) {
          await move(intent, 'sending', 'failed', { reason: 'could not reduce the stop GTT first, so nothing was sold: ' + e.message });
          await audit(uid, intent, 'gtt_reduce_failed', { reason: e.message });
          return 'failed';
        }
      }
    }

    await audit(uid, intent, 'sending_sell', { symbol: sym, qty: intent.qty, tag });
    let orderId;
    try { orderId = (await broker.placeMarketSell({ symbol: sym, exchange: intent.exchange || 'NSE', qty: intent.qty, tag })).orderId; }
    catch (e) {
      if (e.errorType === 'NetworkException') {                               // outcome not known: look for the tag next pass, never resend
        await move(intent, 'sending', 'unknown', { tag, ...extra, reason: e.message }); await audit(uid, intent, 'unknown', { reason: e.message }); return 'unknown';
      }
      await move(intent, 'sending', 'failed', { ...extra, reason: 'broker refused the sell: ' + e.message }); await audit(uid, intent, 'broker_refused', { reason: e.message });
      return 'failed';
    }
    await audit(uid, intent, 'sell_placed', { orderId });
    return conclude(uid, intent, 'sending', orderId, await watch(orderId), extra);
  }

  /** An intent whose outcome was unclear: find its order at the broker by id or tag. Never resend. */
  async function finishUnknown(uid, intent) {
    const tag = tagOf(intent.id), ref = intent.broker_ref || (intent.result && intent.result.orderId);
    const o = ((await broker.orders()) || []).find(x => (ref && String(x.order_id) === String(ref)) || x.tag === tag);
    if (!o) {
      await move(intent, 'unknown', 'failed', { reason: 'the sell did not reach the broker; not retried — a new exit must be approved' });
      await audit(uid, intent, 'failed_after_unknown');
      return 'failed';
    }
    if (!FINAL.has(o.status)) {                                               // still open: ask again for the cancel and keep waiting
      const w = await watch(o.order_id);
      if (!w.order || !FINAL.has(w.order.status)) return 'unknown';
      return conclude(uid, intent, 'unknown', o.order_id, w);
    }
    return conclude(uid, intent, 'unknown', o.order_id, { order: o, cancelled: false });
  }

  async function runOnce({ enabled }) {
    const out = { done: 0, failed: 0, unknown: 0, expired: 0, skipped: 0 };
    if (!enabled || typeof broker.placeMarketSell !== 'function') return out;
    const uid = await store.userId();
    const q = st => `select=*&user_id=eq.${uid}&mode=eq.confirm&action=in.(EXIT_PARTIAL,EXIT_ALL)&status=eq.${st}&order=created_at.asc`;
    for (const intent of await store.select('order_intents', q('unknown'))) out[await finishUnknown(uid, intent)]++;
    for (const intent of await store.select('order_intents', q('approved'))) {   // strictly one at a time
      const r = await runOne(uid, intent);
      out[r]++;
      log('exit', { symbol: intent.symbol, action: intent.action, result: r });
    }
    return out;
  }

  return { runOnce, refuse, tagOf };
}

module.exports = { createExitExecutor, tagOf };
