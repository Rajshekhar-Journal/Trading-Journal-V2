/**
 * og/lib/executor.js — carries out APPROVED stop-GTT intents (Phase 3, CONFIRM mode).
 *
 * The lifecycle engine decides; this file only executes. It handles exactly one kind of intent:
 * mode = 'confirm', action = 'STOP_ENSURE', status = 'approved'. For each one it
 *   1. claims it (approved → sending, compare-and-swap in the database, so it runs once),
 *   2. re-reads the journal and the broker and re-checks everything at the moment of use,
 *   3. places a new stop GTT, modifies the existing one, or does nothing if it is already right,
 *   4. verifies the result at the broker and records it (done / failed / unknown).
 * It never retries blindly: after a timeout the intent is 'unknown' and the next pass looks at the
 * broker's GTT list to decide whether the request went through.
 */
'use strict';
const { journalPositions, brokerPositions, activeSellGtts, lastPrices, normSymbol } = require('./reconcile.js');

const TICK = 0.051;
const same = (a, b) => Math.abs(Number(a) - Number(b)) < TICK;

function createExecutor({ broker, store, log = () => {}, now = () => Date.now() }) {
  async function audit(uid, intent, event, detail = {}) {
    try {
      await store.insert('order_audit', [{ id: `${intent.id}:${now()}:${Math.random().toString(36).slice(2, 8)}`, user_id: uid, intent_id: intent.id,
        symbol: intent.symbol, event, detail, at: new Date(now()).toISOString() }]);
    } catch (e) { log('audit write failed', { error: e.message.slice(0, 120) }); }
  }
  const move = (intent, from, to, result = null, brokerRef = null) =>
    store.rpc('exec_intent_transition', { p_id: intent.id, p_from: from, p_to: to, p_result: result, p_broker_ref: brokerRef });

  /** Everything needed to judge one intent, read fresh. */
  async function snapshot(uid) {
    const [gtts, holdings, positions, trades] = await Promise.all([broker.gtts(), broker.holdings(), broker.positions(),
      store.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,tlm_state,closed_at&user_id=eq.${uid}&closed_at=is.null`)]);
    return { gtts, holdings, positions, trades, journal: journalPositions(trades), brokerQty: brokerPositions(holdings, positions),
      sellGtts: activeSellGtts(gtts), last: lastPrices(holdings, positions) };
  }

  /** Checks at the time of use. Returns a refusal reason, or null when the intent may be executed. */
  function refuse(intent, s) {
    const sym = normSymbol(intent.symbol), pos = s.journal[sym];
    if (!Number.isInteger(intent.qty) || intent.qty <= 0) return 'quantity is not a positive whole number';
    if (!(Number(intent.trigger_price) > 0) || !(Number(intent.gtt_limit_price) > 0)) return 'trigger or limit price missing';
    if (!(Number(intent.gtt_limit_price) < Number(intent.trigger_price))) return 'limit price must be below the trigger';
    if (!pos) return 'no open journal position for this stock any more';
    if (pos.qty !== intent.qty) return `journal position is now ${pos.qty}, the intent was for ${intent.qty}`;
    const levels = s.trades.filter(t => normSymbol(t.symbol) === sym).flatMap(t => [t.current_stop, t.initial_stop, t.tlm_state && t.tlm_state.hardStop]).filter(v => Number(v) > 0);
    if (!levels.some(v => same(v, intent.trigger_price))) return `stop ${intent.trigger_price} is not a stop level of this position in the journal (${[...new Set(levels)].join(', ') || 'none'})`;
    const held = s.brokerQty[sym] || 0;
    if (held < intent.qty) return `broker holds ${held}, fewer than ${intent.qty}`;
    const ltp = s.last[sym];
    if (!(ltp > 0)) return 'no last price from the broker for this stock';
    if (!(Number(intent.trigger_price) < ltp)) return `stop ${intent.trigger_price} is at or above the price ${ltp} — a GTT cannot protect this; act manually`;
    const list = s.sellGtts[sym] || [];
    if (list.length > 1) return `${list.length} sell GTTs already exist on this stock — remove the extra ones on Kite first`;
    if (list.length === 1 && Math.min(...list[0].triggers) > Number(intent.trigger_price) + TICK) return `existing GTT trigger ${Math.min(...list[0].triggers)} is higher; a stop is never lowered automatically`;
    return null;
  }
  const inPlace = (intent, s) => (s.sellGtts[normSymbol(intent.symbol)] || []).find(g => g.qty === intent.qty && g.triggers.some(t => same(t, intent.trigger_price)));

  async function finishUnknown(uid, intent) {
    const s = await snapshot(uid);
    const hit = inPlace(intent, s);
    if (hit) { await move(intent, 'unknown', 'done', { note: 'found at the broker after an unclear response' }, String(hit.id)); await audit(uid, intent, 'verified_after_unknown', { gttId: hit.id }); return 'done'; }
    await move(intent, 'unknown', 'failed', { reason: 'request did not reach the broker; not retried — propose again' });
    await audit(uid, intent, 'failed_after_unknown');
    return 'failed';
  }

  async function runOne(uid, intent) {
    if (intent.expires_at && Date.parse(intent.expires_at) < now()) { await move(intent, 'approved', 'expired', { reason: 'approval expired before it could be sent' }); return 'expired'; }
    if (!(await move(intent, 'approved', 'sending'))) return 'skipped';            // someone else claimed it
    await audit(uid, intent, 'claimed');
    let s;
    try { s = await snapshot(uid); }
    catch (e) { await move(intent, 'sending', 'failed', { reason: 'could not read broker state: ' + e.message }); await audit(uid, intent, 'failed', { reason: e.message }); return 'failed'; }

    const why = refuse(intent, s);
    if (why) { await move(intent, 'sending', 'failed', { reason: why }); await audit(uid, intent, 'refused', { reason: why }); return 'failed'; }
    const existing = inPlace(intent, s);
    if (existing) { await move(intent, 'sending', 'done', { note: 'already in place' }, String(existing.id)); await audit(uid, intent, 'already_in_place', { gttId: existing.id }); return 'done'; }

    const sym = normSymbol(intent.symbol);
    const spec = { symbol: sym, exchange: intent.exchange || 'NSE', trigger: Number(intent.trigger_price), limit: Number(intent.gtt_limit_price), qty: intent.qty, lastPrice: s.last[sym] };
    const current = (s.sellGtts[sym] || [])[0];
    const verb = current ? 'modify' : 'place';
    await audit(uid, intent, 'sending_' + verb, { spec, gttId: current ? current.id : null });
    try {
      if (current) await broker.modifyStopGtt(current.id, spec); else await broker.placeStopGtt(spec);
    } catch (e) {
      if (e.errorType === 'NetworkException') {                                  // timeout / connection: outcome not known
        await move(intent, 'sending', 'unknown', { reason: e.message }); await audit(uid, intent, 'unknown', { reason: e.message }); return 'unknown';
      }
      await move(intent, 'sending', 'failed', { reason: 'broker refused: ' + e.message }); await audit(uid, intent, 'broker_refused', { reason: e.message });
      return 'failed';
    }
    // Verify at the broker before calling it done.
    let after;
    try { after = inPlace(intent, await snapshot(uid)); } catch (_) { after = null; }
    if (!after) { await move(intent, 'sending', 'unknown', { reason: 'sent, but not yet visible in the broker GTT list' }); await audit(uid, intent, 'unverified'); return 'unknown'; }
    await move(intent, 'sending', 'done', { verb }, String(after.id));
    await audit(uid, intent, 'done', { gttId: after.id, verb });
    return 'done';
  }

  /** One pass. `enabled` is decided by the gateway (switch on + static IP matches + logged in). */
  async function runOnce({ enabled }) {
    const out = { done: 0, failed: 0, unknown: 0, expired: 0, skipped: 0 };
    if (!enabled || broker.readOnly) return out;
    const uid = await store.userId();
    const q = st => `select=*&user_id=eq.${uid}&mode=eq.confirm&action=eq.STOP_ENSURE&status=eq.${st}&order=created_at.asc`;
    for (const intent of await store.select('order_intents', q('unknown'))) out[await finishUnknown(uid, intent)]++;
    for (const intent of await store.select('order_intents', q('approved'))) {    // one at a time: no two actions on a position overlap
      const r = await runOne(uid, intent);
      out[r]++;
      log('stop gtt', { symbol: intent.symbol, result: r });
    }
    return out;
  }

  return { runOnce, refuse };
}

module.exports = { createExecutor };
