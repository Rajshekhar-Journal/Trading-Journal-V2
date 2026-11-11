/**
 * og/lib/emergency-exit.js — Emergency Exit (Phase 4c, SRS §10): the stop GTT did its job badly.
 *
 * DETECT (read only), for an open journal position the broker still holds:
 *   GTT_ORDER_UNFILLED   the GTT triggered and its sell order is still open after the grace period
 *   GTT_ORDER_REJECTED   the GTT triggered and its sell order was rejected or cancelled unfilled
 *   GTT_NOT_TRIGGERED    the price is below the stop but the GTT is still active after the grace period
 * PROPOSE: one EMERGENCY_EXIT intent per case — 'proposed' (you approve) or, in auto mode, 'approved'.
 *   GTT_NOT_TRIGGERED is never automatic: it always waits for you.
 * EXECUTE, for an approved intent, strictly in this order:
 *   1. (not-triggered case) delete the GTT and confirm it is gone
 *   2. cancel every open sell on the stock and wait until the broker confirms each is final
 *   3. read the quantity the broker actually holds
 *   4. market sell with automatic protection; if not filled: cancel, confirm, then 5%, then 10%
 * One sell at a time, never more than is held, never a second order while one is unresolved.
 */
'use strict';
const { journalPositions, brokerPositions, activeSellGtts, lastPrices, normSymbol } = require('./reconcile.js');
const { tagOf } = require('./exit-executor.js');

const FINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const PENDING = new Set(['proposed', 'approved', 'sending', 'unknown']);
const istDate = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const istMinute = ms => Math.floor(((ms / 60000) + 330) % 1440);
const round2 = v => Math.round(v * 100) / 100;
const gttOrderIds = g => (g.orders || []).map(o => o.result && o.result.order_result && o.result.order_result.order_id).filter(Boolean).map(String);
const gttSells = g => (g.orders || []).some(o => o.transaction_type === 'SELL');

/**
 * Pure detection. `seen` is a Map kept by the caller (key → first time the condition was seen).
 * @returns [{ kind, symbol, qty, tradeId, gttId, orderId, detail }]
 */
function detect({ trades, orders, gtts, holdings, positions }, { now, seen, gttFillGraceSec = 10, notTriggeredGraceSec = 60 }) {
  const journal = journalPositions(trades), held = brokerPositions(holdings, positions), last = lastPrices(holdings, positions), active = activeSellGtts(gtts);
  const today = istDate(now), out = [], alive = new Set();
  const aged = (key, sec) => { alive.add(key); if (!seen.has(key)) seen.set(key, now); return now - seen.get(key) >= sec * 1000; };

  for (const sym of Object.keys(journal)) {
    const qty = Math.min(journal[sym].qty, held[sym] || 0);
    if (qty <= 0) continue;
    const base = { symbol: sym, qty, tradeId: journal[sym].tradeIds[0] };
    const symOrders = (orders || []).filter(o => normSymbol(o.tradingsymbol) === sym && o.transaction_type === 'SELL');
    const fired = (gtts || []).filter(g => g.status === 'triggered' && gttSells(g) && normSymbol(g.condition && g.condition.tradingsymbol) === sym
      && (!g.updated_at || String(g.updated_at).slice(0, 10) === today));

    for (const g of fired) {
      const ids = gttOrderIds(g);
      const linked = symOrders.filter(o => ids.includes(String(o.order_id)));
      const live = (ids.length ? linked : symOrders.filter(o => o.order_type === 'LIMIT')).find(o => !FINAL.has(o.status));
      if (live) {
        if (aged(`unfilled:${live.order_id}`, gttFillGraceSec))
          out.push({ ...base, kind: 'GTT_ORDER_UNFILLED', gttId: String(g.id), orderId: String(live.order_id),
            detail: { reason: `Stop GTT triggered but its sell order ${live.order_id} is not filled (${live.filled_quantity || 0} of ${live.quantity}).`, limit: live.price, lastPrice: last[sym] ?? null } });
        continue;
      }
      const dead = linked.find(o => (o.status === 'REJECTED' || o.status === 'CANCELLED') && (Number(o.filled_quantity) || 0) < Number(o.quantity));
      if (dead && !(active[sym] || []).length)
        out.push({ ...base, kind: 'GTT_ORDER_REJECTED', gttId: String(g.id), orderId: String(dead.order_id),
          detail: { reason: `Stop GTT triggered but its sell order ${dead.order_id} was ${dead.status.toLowerCase()}: ${dead.status_message || 'no reason given'}.`, lastPrice: last[sym] ?? null } });
    }

    const list = active[sym] || [];
    if (list.length === 1 && last[sym] > 0 && !symOrders.some(o => !FINAL.has(o.status))) {
      const trigger = Math.min(...list[0].triggers);
      if (last[sym] < trigger && aged(`asleep:${list[0].id}`, notTriggeredGraceSec))
        out.push({ ...base, kind: 'GTT_NOT_TRIGGERED', gttId: String(list[0].id), orderId: null,
          detail: { reason: `Price ${last[sym]} is below the stop ${trigger} but the GTT has not triggered.`, trigger, lastPrice: last[sym] } });
    }
  }
  for (const k of [...seen.keys()]) if (!alive.has(k)) seen.delete(k);            // condition gone → forget it
  return out;
}

function createEmergencyExit({ broker, store, log = () => {}, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)),
  ladder = [-1, 5, 10], exitWindow = [556, 925], fillWaitSec = 20, cancelWaitSec = 10, pollMs = 2000 }) {

  async function audit(uid, intent, event, detail = {}) {
    try {
      await store.insert('order_audit', [{ id: `${intent.id}:${now()}:${Math.random().toString(36).slice(2, 8)}`, user_id: uid, intent_id: intent.id,
        symbol: intent.symbol, event, detail, at: new Date(now()).toISOString() }]);
    } catch (e) { log('audit write failed', { error: e.message.slice(0, 120) }); }
  }
  const move = (intent, from, to, result = null, brokerRef = null) =>
    store.rpc('exec_intent_transition', { p_id: intent.id, p_from: from, p_to: to, p_result: result, p_broker_ref: brokerRef });
  const tradesOf = uid => store.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,closed_at&user_id=eq.${uid}&closed_at=is.null`);

  /** Record the cases found as intents (and a dashboard alert). Returns how many were newly proposed. */
  async function propose(snapshot, { mode, seen, gttFillGraceSec, notTriggeredGraceSec }) {
    if (mode !== 'confirm' && mode !== 'auto') return 0;
    const uid = await store.userId();
    const cases = detect(snapshot, { now: now(), seen, gttFillGraceSec, notTriggeredGraceSec });
    if (!cases.length) return 0;
    const open = await store.select('order_intents', `select=symbol,status&user_id=eq.${uid}&mode=eq.confirm&action=eq.EMERGENCY_EXIT&order=created_at.desc&limit=50`);
    let made = 0;
    for (const c of cases) {
      if (open.some(i => PENDING.has(i.status) && normSymbol(i.symbol) === c.symbol)) continue;      // one at a time per stock
      const auto = mode === 'auto' && c.kind !== 'GTT_NOT_TRIGGERED';
      const t = now(), id = `oi_${t}_${Math.random().toString(36).slice(2, 8)}`;
      const row = { id, user_id: uid, intent_key: `${c.symbol}:EMERGENCY:${istDate(t)}:${c.kind}:${c.orderId || c.gttId}`, mode: 'confirm', status: auto ? 'approved' : 'proposed',
        action: 'EMERGENCY_EXIT', rule_id: 'LC-09', symbol: c.symbol, exchange: 'NSE', trade_id: c.tradeId, side: 'SELL', qty: c.qty, route: 'MARKET', market_protection: -1,
        ref_price: c.detail.lastPrice ?? null, would_send: true, guards: [], block_reasons: [], detail: { ...c.detail, kind: c.kind, gttId: c.gttId, orderId: c.orderId, auto },
        expires_at: new Date(t + (auto ? 5 : 15) * 60000).toISOString(), created_at: new Date(t).toISOString() };
      try { await store.insert('order_intents', [row]); }
      catch (e) { if (!/409|23505|duplicate/i.test(e.message)) log('emergency proposal failed', { symbol: c.symbol, error: e.message.slice(0, 160) }); continue; }
      made++;
      log('emergency', { symbol: c.symbol, kind: c.kind, auto });
      try {                                                                                       // show it on the Alert Dashboard
        await store.insert('alert_log', [{ id: `al_${t}_${Math.random().toString(36).slice(2, 8)}`, user_id: uid, trade_id: c.tradeId, watchlist_id: null, mode: 'real', symbol: c.symbol,
          rule_id: 'LC-09', alert_type: 'EMERGENCY EXIT needed', cmp: c.detail.lastPrice ?? null,
          suggestion: { kind: 'EXIT_ALL', qty: c.qty, text: auto ? 'The gateway is running the Emergency Exit now.' : 'Approve the Emergency Exit in Settings → Auto Trade – Broker Link, or act on Kite.' },
          message: `Alert type : EMERGENCY EXIT needed · ${c.symbol} · REAL\nReason     : ${c.detail.reason}\nAction     : ${auto ? 'Emergency Exit started automatically.' : 'Approve the Emergency Exit, or sell on Kite.'}`,
          status: 'New', telegram_status: 'pending', created_at: new Date(t).toISOString() }]);   // sent by the backend runner within a minute
      } catch (_) { /* the intent itself is what matters */ }
    }
    return made;
  }

  const ordersNow = async () => (await broker.orders()) || [];
  async function waitFinal(ids, sec) {
    const end = now() + sec * 1000;
    for (;;) {
      let list = null;
      try { list = await ordersNow(); } catch (_) { /* retry until the deadline */ }
      const mine = list ? ids.map(id => list.find(o => String(o.order_id) === String(id))) : [];
      if (list && mine.every(o => o && FINAL.has(o.status))) return { ok: true, orders: mine };
      if (now() >= end) return { ok: false, orders: mine.filter(Boolean) };
      await sleep(pollMs);
    }
  }

  async function runOne(uid, intent) {
    if (intent.expires_at && Date.parse(intent.expires_at) < now()) { await move(intent, 'approved', 'expired', { reason: 'approval expired before it could be sent' }); return 'expired'; }
    if (!(await move(intent, 'approved', 'sending'))) return 'skipped';
    await audit(uid, intent, 'claimed', { kind: intent.detail && intent.detail.kind });
    const sym = normSymbol(intent.symbol), kind = intent.detail && intent.detail.kind;
    const fail = async (reason, extra = {}) => { await move(intent, 'sending', 'failed', { reason, ...extra }); await audit(uid, intent, 'failed', { reason, ...extra }); return 'failed'; };
    const res = { filled: 0, averagePrice: null, attempts: [], tag: tagOf(intent.id) };
    let value = 0, lastOrderId = null;

    try {
      const minute = istMinute(now());
      if (minute < exitWindow[0] || minute > exitWindow[1]) return await fail('outside market hours for exits');
      const journal = journalPositions(await tradesOf(uid));
      if (!journal[sym]) return await fail('no open journal position for this stock any more');

      // 1. Not-triggered case: take the sleeping GTT away first so it cannot fire later; re-check the price.
      if (kind === 'GTT_NOT_TRIGGERED') {
        const [gtts, holdings, positions] = await Promise.all([broker.gtts(), broker.holdings(), broker.positions()]);
        const list = activeSellGtts(gtts)[sym] || [], ltp = lastPrices(holdings, positions)[sym];
        if (list.length && ltp > 0 && ltp >= Math.min(...list[0].triggers)) return await fail(`price ${ltp} is back at or above the stop ${Math.min(...list[0].triggers)} — nothing done`);
        for (const g of list) await broker.deleteGtt(g.id);
        if ((activeSellGtts(await broker.gtts())[sym] || []).length) return await fail('could not remove the stop GTT, so nothing was sold');
        await audit(uid, intent, 'gtt_deleted', { gttIds: list.map(g => g.id) });
      }

      // 2. Cancel every open sell on the stock and wait for the broker to confirm.
      const liveIds = (await ordersNow()).filter(o => normSymbol(o.tradingsymbol) === sym && o.transaction_type === 'SELL' && !FINAL.has(o.status)).map(o => String(o.order_id));
      if (liveIds.length) {
        await audit(uid, intent, 'cancelling', { orderIds: liveIds });
        for (const id of liveIds) { try { await broker.cancelOrder(id); } catch (e) { log('cancel request failed', { id, error: e.message.slice(0, 120) }); } }
        const w = await waitFinal(liveIds, cancelWaitSec);
        if (!w.ok) {
          await move(intent, 'sending', 'unknown', { ...res, reason: 'cancellation of the existing sell order is not confirmed — no other sell will be sent', waitingFor: liveIds });
          await audit(uid, intent, 'cancel_not_confirmed', { orderIds: liveIds });
          return 'unknown';
        }
        await audit(uid, intent, 'cancel_confirmed', { orderIds: liveIds });
      }

      // 3 + 4. Verify the quantity actually held, sell, and widen the protection only if needed.
      for (let k = 0; k < ladder.length; k++) {
        const [holdings, positions] = await Promise.all([broker.holdings(), broker.positions()]);
        const held = brokerPositions(holdings, positions)[sym] || 0;
        const qty = Math.min(held, intent.qty - res.filled);
        if (qty <= 0) break;
        const tag = tagOf(`${intent.id}:${k}`), protection = ladder[k];
        await audit(uid, intent, 'sending_sell', { attempt: k + 1, qty, protection, held, tag });
        let orderId;
        try { orderId = (await broker.placeMarketSell({ symbol: sym, exchange: intent.exchange || 'NSE', qty, tag, protection })).orderId; }
        catch (e) {
          if (e.errorType === 'NetworkException') {
            await move(intent, 'sending', 'unknown', { ...res, reason: 'sell request outcome unclear: ' + e.message }); await audit(uid, intent, 'unknown', { attempt: k + 1, reason: e.message });
            return 'unknown';
          }
          res.attempts.push({ protection, qty, refused: e.message });
          await audit(uid, intent, 'broker_refused', { attempt: k + 1, reason: e.message });
          break;
        }
        lastOrderId = orderId;
        let w = await waitFinal([orderId], fillWaitSec);
        if (!w.ok) {
          try { await broker.cancelOrder(orderId); } catch (e) { log('cancel request failed', { orderId, error: e.message.slice(0, 120) }); }
          w = await waitFinal([orderId], cancelWaitSec);
        }
        const o = w.orders[0], filled = o ? Number(o.filled_quantity) || 0 : 0;
        res.attempts.push({ protection, qty, orderId, filled, status: o ? o.status : 'not visible' });
        if (filled > 0) { res.filled += filled; value += filled * (Number(o.average_price) || 0); res.averagePrice = round2(value / res.filled); }
        if (!w.ok) {
          await move(intent, 'sending', 'unknown', { ...res, reason: `sell order ${orderId} is still open and its cancel is not confirmed — no other sell will be sent` }, String(orderId));
          await audit(uid, intent, 'cancel_not_confirmed', { orderId });
          return 'unknown';
        }
        if (o.status === 'REJECTED') await audit(uid, intent, 'sell_rejected', { attempt: k + 1, message: o.status_message || null });
        if (res.filled >= intent.qty) break;
      }

      const left = brokerPositions(await broker.holdings(), await broker.positions())[sym] || 0;
      if (res.filled >= intent.qty || (left <= 0 && res.filled > 0)) {
        try { for (const g of activeSellGtts(await broker.gtts())[sym] || []) await broker.deleteGtt(g.id); } catch (e) { res.gtt = 'a stop GTT is still listed — delete it on Kite: ' + e.message; }
        await move(intent, 'sending', 'done', res, lastOrderId);
        await audit(uid, intent, 'done', res);
        return 'done';
      }
      return await fail(left > 0 ? `still holding ${left} shares after ${res.attempts.length} attempt(s) — sell on Kite now` : 'nothing was sold', { ...res, stillHeld: left });
    } catch (e) {
      // Anything unexpected mid-flow: we may have an order out. Never guess; mark unknown and look again next pass.
      await move(intent, 'sending', 'unknown', { ...res, reason: 'interrupted: ' + e.message }, lastOrderId).catch(() => {});
      await audit(uid, intent, 'interrupted', { reason: e.message });
      return 'unknown';
    }
  }

  /** Unclear outcome: wait for this intent's own orders (and anything it was cancelling) to be final. Never sells. */
  async function finishUnknown(uid, intent) {
    const sym = normSymbol(intent.symbol), tags = new Set(ladder.map((_, k) => tagOf(`${intent.id}:${k}`)));
    const list = await ordersNow();
    const mine = list.filter(o => tags.has(o.tag));
    const live = list.filter(o => normSymbol(o.tradingsymbol) === sym && o.transaction_type === 'SELL' && !FINAL.has(o.status));
    if (live.length) {
      for (const o of live) { try { await broker.cancelOrder(o.order_id); } catch (_) { /* keep waiting */ } }
      if (!(await waitFinal(live.map(o => o.order_id), cancelWaitSec)).ok) return 'unknown';
    }
    const done = (await ordersNow()).filter(o => tags.has(o.tag));
    const filled = done.reduce((s, o) => s + (Number(o.filled_quantity) || 0), 0);
    const value = done.reduce((s, o) => s + (Number(o.filled_quantity) || 0) * (Number(o.average_price) || 0), 0);
    const left = brokerPositions(await broker.holdings(), await broker.positions())[sym] || 0;
    const res = { filled, averagePrice: filled ? round2(value / filled) : null, tag: tagOf(intent.id), attempts: done.map(o => ({ orderId: o.order_id, filled: o.filled_quantity, status: o.status })), stillHeld: left };
    const ok = filled >= intent.qty || (left <= 0 && filled > 0);
    res.reason = ok ? undefined : (mine.length || done.length ? `interrupted; ${filled} sold, still holding ${left} — check the position on Kite` : 'the sell did not reach the broker; not retried');
    await move(intent, 'unknown', ok ? 'done' : 'failed', res, done.length ? String(done[done.length - 1].order_id) : null);
    await audit(uid, intent, ok ? 'done_after_unknown' : 'failed_after_unknown', res);
    return ok ? 'done' : 'failed';
  }

  async function runOnce({ enabled }) {
    const out = { done: 0, failed: 0, unknown: 0, expired: 0, skipped: 0 };
    if (!enabled || typeof broker.placeMarketSell !== 'function') return out;
    const uid = await store.userId();
    const q = st => `select=*&user_id=eq.${uid}&mode=eq.confirm&action=eq.EMERGENCY_EXIT&status=eq.${st}&order=created_at.asc`;
    for (const intent of await store.select('order_intents', q('unknown'))) out[await finishUnknown(uid, intent)]++;
    for (const intent of await store.select('order_intents', q('approved'))) {
      const r = await runOne(uid, intent);
      out[r]++;
      log('emergency exit', { symbol: intent.symbol, result: r });
    }
    return out;
  }

  return { propose, runOnce };
}

module.exports = { createEmergencyExit, detect };
