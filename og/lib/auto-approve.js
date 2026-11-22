/**
 * og/lib/auto-approve.js — asks the DATABASE to approve proposals without you (Auto-Sell and Full Auto modes).
 *
 * The gateway never decides this itself. For every proposal the planner marked autoEligible, it calls
 * exec_auto_decide_intent(), and the database approves only if your saved mode allows it, the kill switch
 * is off for buys, and you have approved and completed enough orders of that kind yourself (migration 013).
 * It only asks for a kind of order whose sending switch is on at the gateway, so nothing is approved that
 * could not be sent.
 */
'use strict';

const kindOf = a => a === 'STOP_ENSURE' ? 'stop' : (a === 'EXIT_PARTIAL' || a === 'EXIT_ALL') ? 'exit' : (a === 'ENTRY' || a === 'ADD') ? 'buy' : null;

function createAutoApprover({ store, log = () => {}, now = () => Date.now() }) {
  /** @param sending { stop: boolean, exit: boolean, buy: boolean } what the gateway may send right now */
  async function runOnce({ sending }) {
    const out = { approved: 0, refused: 0 };
    if (!sending || (!sending.stop && !sending.exit && !sending.buy)) return out;
    const uid = await store.userId();
    const rows = await store.select('order_intents', `select=id,symbol,action,detail,expires_at&user_id=eq.${uid}&mode=eq.confirm&status=eq.proposed&order=created_at.asc`);
    for (const i of rows) {
      if (!(i.detail && i.detail.autoEligible)) continue;
      if (i.expires_at && Date.parse(i.expires_at) < now()) continue;
      if (!sending[kindOf(i.action)]) continue;
      let r;
      try { r = await store.rpc('exec_auto_decide_intent', { p_id: i.id }); }
      catch (e) { log('auto approval failed', { symbol: i.symbol, error: e.message.slice(0, 140) }); out.refused++; continue; }   // e.g. migration 013 not run
      if (r === 'approved') out.approved++; else out.refused++;
      log('auto approval', { symbol: i.symbol, action: i.action, result: r });
      try {
        await store.insert('order_audit', [{ id: `${i.id}:${now()}:au${Math.random().toString(36).slice(2, 6)}`, user_id: uid, intent_id: i.id, symbol: i.symbol,
          event: r === 'approved' ? 'auto_approved' : 'auto_approval_refused', detail: { result: r }, at: new Date(now()).toISOString() }]);
      } catch (_) { /* audit is best effort */ }
    }
    return out;
  }
  return { runOnce };
}

module.exports = { createAutoApprover };
