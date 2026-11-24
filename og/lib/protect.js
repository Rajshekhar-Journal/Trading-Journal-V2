/**
 * og/lib/protect.js — keeps the hard-stop GTT matched to what Zerodha holds.
 *
 * Rule: for every stock held at the broker that has an open journal position, one active sell GTT covers
 * the journal position's shares — min(held at the broker, journal quantity) — so shares you hold outside the journal
 * (e.g. a long-term holding of the same stock) are never put under the trade's stop; at a trigger no lower than the journal stop (and never lower than the GTT already has).
 *
 *   ensure()  one stock, now: used right after a buy fills (C1) and after any partial or failed sell (C2).
 *   keep()    every gateway pass (C3): finds positions whose GTT is missing, has the wrong quantity, or a trigger
 *             below the journal stop, waits until the mismatch has lasted `graceSec`, then fixes it and verifies.
 *
 * It only ever places a GTT, changes its quantity to the held quantity, or raises its trigger. It never lowers a stop,
 * never sells, never acts while a sell order is live, a GTT has just triggered, or an order for the stock is in flight.
 * Every step is written to order_audit; repeated failures raise a Telegram alert.
 */
'use strict';
const { journalPositions, brokerPositions, activeSellGtts, lastPrices, normSymbol } = require('./reconcile.js');

const FINAL = new Set(['COMPLETE', 'CANCELLED', 'REJECTED']);
const TICK = 0.051;
const floorTick = v => Math.floor(v / 0.05 + 1e-9) * 0.05;
const r2 = v => Math.round(v * 100) / 100;
const istDate = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);

function createProtector({ broker, store, log = () => {}, now = () => Date.now(), graceSec = 60, seen = new Map(), fails = new Map() }) {
  const canWrite = () => typeof broker.placeStopGtt === 'function' && typeof broker.modifyStopGtt === 'function';

  async function audit(uid, sym, event, detail = {}, intentId) {
    try {
      await store.insert('order_audit', [{ id: `pk:${sym}:${now()}:${Math.random().toString(36).slice(2, 7)}`, user_id: uid, intent_id: intentId || `protect:${sym}`,
        symbol: sym, event, detail, at: new Date(now()).toISOString() }]);
    } catch (e) { log('audit write failed', { error: e.message.slice(0, 120) }); }
  }
  async function alert(uid, sym, text) {
    try {
      await store.insert('alert_log', [{ id: `al_${now()}_${Math.random().toString(36).slice(2, 8)}`, user_id: uid, trade_id: null, watchlist_id: null, mode: 'real', symbol: sym,
        rule_id: 'EX-06', alert_type: 'Stop GTT does not match holdings', cmp: null, suggestion: { kind: 'STOP', text, reason: text },
        message: `Alert type : Stop GTT does not match holdings · ${sym} · REAL\nAction     : Check the stop GTT on Kite now.\nReason     : ${text}`,
        status: 'New', telegram_status: 'pending', created_at: new Date(now()).toISOString() }]);
    } catch (_) { /* best effort */ }
  }
  async function bufferPct(uid) {
    try { const r = await store.select('settings', `select=data&user_id=eq.${uid}`); return Number(((r[0] || {}).data || {}).execution?.gttBufferPct) || 1.5; } catch (_) { return 1.5; }
  }

  /** Read what the broker shows for one stock. */
  async function view(uid, sym) {
    const [gtts, holdings, positions, orders, trades] = await Promise.all([broker.gtts(), broker.holdings(), broker.positions(), broker.orders(),
      store.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,closed_at&user_id=eq.${uid}&closed_at=is.null`)]);
    const jp = journalPositions(trades)[sym];
    return { gtts: gtts || [], held: brokerPositions(holdings, positions)[sym] || 0, journalQty: jp ? jp.qty : 0, last: lastPrices(holdings, positions)[sym] || null,
      list: activeSellGtts(gtts)[sym] || [], liveSell: (orders || []).find(o => normSymbol(o.tradingsymbol) === sym && o.transaction_type === 'SELL' && !FINAL.has(o.status)) };
  }

  /**
   * Make one stock's GTT cover the held quantity at max(trigger, existing trigger).
   * @returns { action: 'none'|'placed'|'modified'|'skipped'|'failed', reason?, qty?, trigger? }
   */
  /** @param journalDelta shares not yet booked in the journal: + a buy just filled, − a sell just filled. */
  async function ensure(uid, { symbol, exchange = 'NSE', trigger, why, intentId, journalDelta = 0 }) {
    const sym = normSymbol(symbol);
    if (!canWrite()) { await audit(uid, sym, 'protect_unavailable', { why }, intentId); return { action: 'failed', reason: 'stop-GTT placement is switched off at the gateway' }; }
    let v;
    try { v = await view(uid, sym); } catch (e) { return { action: 'failed', reason: 'could not read the broker: ' + e.message }; }
    const want = Math.min(v.held, Math.max(0, v.journalQty + (Number(journalDelta) || 0)));
    if (!want) return { action: 'none', reason: v.held ? 'no journal position to protect' : 'no shares held' };
    if (v.liveSell) return { action: 'skipped', reason: `a sell order is live (${v.liveSell.order_id})` };
    if (v.list.length > 1) { await audit(uid, sym, 'protect_refused', { reason: 'more than one sell GTT', why }, intentId); return { action: 'failed', reason: 'more than one sell GTT exists — remove the extra ones on Kite' }; }
    const cur = v.list[0], curTrig = cur ? Math.min(...cur.triggers) : 0;
    const trig = r2(Math.max(Number(trigger) || 0, curTrig));
    if (!(trig > 0)) return { action: 'failed', reason: 'no stop level known' };
    if (v.last && trig >= v.last) { await audit(uid, sym, 'protect_refused', { reason: 'stop at or above the price', trig, last: v.last, why }, intentId); return { action: 'failed', reason: `stop ${trig} is at or above the price ${v.last}` }; }
    if (cur && cur.qty === want && Math.abs(curTrig - trig) < TICK) return { action: 'none', qty: want, trigger: trig };
    const spec = { symbol: sym, exchange, trigger: trig, limit: r2(floorTick(trig * (1 - (await bufferPct(uid)) / 100))), qty: want, lastPrice: v.last };
    const verb = cur ? 'modified' : 'placed';
    await audit(uid, sym, 'protect_' + (cur ? 'modify' : 'place'), { spec, from: cur ? { qty: cur.qty, trigger: curTrig, id: cur.id } : null, why }, intentId);
    try { if (cur) await broker.modifyStopGtt(cur.id, spec); else await broker.placeStopGtt(spec); }
    catch (e) { await audit(uid, sym, 'protect_failed', { reason: e.message, why }, intentId); return { action: 'failed', reason: 'broker refused: ' + e.message }; }
    // Verify by reading it back.
    let after;
    try { after = activeSellGtts(await broker.gtts())[sym] || []; } catch (_) { after = []; }
    const ok = after.length === 1 && after[0].qty === want && after[0].triggers.some(t => Math.abs(t - trig) < TICK);
    await audit(uid, sym, ok ? 'protect_verified' : 'protect_unverified', { qty: want, held: v.held, journalQty: v.journalQty, trigger: trig, seen: after.map(g => ({ id: g.id, qty: g.qty, triggers: g.triggers })) }, intentId);
    return ok ? { action: verb, qty: want, trigger: trig } : { action: 'failed', reason: 'GTT change sent but not seen at the broker' };
  }

  /** Every pass: fix GTTs that do not match holdings. @returns { checked, fixed, failed, waiting } */
  async function keep() {
    const out = { checked: 0, fixed: 0, failed: 0, waiting: 0 };
    if (!canWrite()) return out;
    const uid = await store.userId();
    const [gtts, holdings, positions, orders, trades, busy] = await Promise.all([broker.gtts(), broker.holdings(), broker.positions(), broker.orders(),
      store.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,closed_at&user_id=eq.${uid}&closed_at=is.null`),
      store.select('order_intents', `select=symbol,action,status&user_id=eq.${uid}&mode=eq.confirm&status=in.(approved,sending,unknown)`)]);
    const j = journalPositions(trades), b = brokerPositions(holdings, positions), g = activeSellGtts(gtts), today = istDate(now());
    const t = now();
    for (const sym of Object.keys(j)) {
      const held = Math.min(b[sym] || 0, j[sym].qty);                     // shares of THIS position at the broker
      if (!held) { seen.delete(sym); continue; }
      out.checked++;
      const list = g[sym] || [], cur = list[0], curTrig = cur ? Math.min(...cur.triggers) : 0, stop = Number(j[sym].stop) || 0;
      const wrong = list.length !== 1 || cur.qty !== held || curTrig + TICK < stop;
      if (!wrong) { seen.delete(sym); fails.delete(sym); continue; }
      const live = (orders || []).some(o => normSymbol(o.tradingsymbol) === sym && o.transaction_type === 'SELL' && !FINAL.has(o.status));
      const fired = (gtts || []).some(x => x.status === 'triggered' && normSymbol(x.condition && x.condition.tradingsymbol) === sym && (!x.updated_at || String(x.updated_at).slice(0, 10) === today));
      const inFlight = busy.some(i => normSymbol(i.symbol) === sym);
      if (live || fired || inFlight || list.length > 1) { out.waiting++; continue; }         // an exit / Emergency Exit / approved order owns this stock now
      if (!seen.has(sym)) seen.set(sym, t);
      if (t - seen.get(sym) < graceSec * 1000) { out.waiting++; continue; }                // let bookings and syncs settle first
      const r = await ensure(uid, { symbol: sym, trigger: stop, why: !cur ? 'no stop GTT' : cur.qty !== held ? `GTT covers ${cur.qty}, the position has ${held} at the broker` : `GTT trigger ${curTrig} is below the journal stop ${stop}` });
      log('protect', { symbol: sym, result: r.action, reason: r.reason || null });
      if (r.action === 'placed' || r.action === 'modified' || r.action === 'none') { out.fixed += r.action === 'none' ? 0 : 1; seen.delete(sym); fails.delete(sym); continue; }
      out.failed++;
      const f = (fails.get(sym) || { n: 0, alerted: 0 }); f.n++;
      if (f.n >= 2 && t - f.alerted > 3600e3) { f.alerted = t; await alert(uid, sym, `The gateway could not make the stop GTT cover the ${held} shares held: ${r.reason}.`); }
      fails.set(sym, f);
    }
    return out;
  }

  return { ensure, keep };
}

module.exports = { createProtector };
