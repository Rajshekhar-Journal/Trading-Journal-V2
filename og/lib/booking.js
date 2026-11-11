/**
 * og/lib/booking.js — writes a completed sell into the journal's existing trade record (Phase 4b).
 *
 * One code path for every kind of exit the gateway sends. The database function exec_commit_fill
 * does the write in one transaction and refuses a second booking of the same intent, so a crash
 * or a retry can never book a fill twice or leave the trade half-updated.
 */
'use strict';
const calc = require('../../js/calculations.js');

const LABEL = { 'LC-07': 'LC-07 Trail exit', 'LC-09': 'LC-09 Hard stop' };
const istDate = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
const round2 = v => Math.round(v * 100) / 100;

function sourceOf(intent) {
  const base = LABEL[intent.rule_id] || intent.rule_id || 'Exit';
  if (intent.action === 'GTT_STOP_FILL') return 'LC-09 Hard stop — stop GTT (Auto)';
  return intent.action === 'EMERGENCY_EXIT' ? 'LC-09 Hard stop — Emergency Exit (Auto)' : `${base} (Auto)`;
}

function createBooking({ store, log = () => {}, now = () => Date.now() }) {
  /** Book every finished exit that has a fill and is not booked yet. Returns counts. */
  async function bookPending() {
    const out = { booked: 0, notBooked: 0 };
    const uid = await store.userId();
    const rows = await store.select('order_intents',
      `select=*&user_id=eq.${uid}&mode=eq.confirm&action=in.(EXIT_PARTIAL,EXIT_ALL,EMERGENCY_EXIT,GTT_STOP_FILL)&status=in.(done,failed)&booking=is.null&order=created_at.desc&limit=30`);
    const todo = rows.filter(i => i.result && Number(i.result.filled) > 0 && Number(i.result.averagePrice) > 0);
    if (!todo.length) return out;
    let settings = null;
    try { settings = ((await store.select('settings', `select=data&user_id=eq.${uid}`))[0] || {}).data || null; } catch (_) { /* charges fall back to 0 */ }
    for (const i of todo) {
      const qty = Math.min(Number(i.result.filled), i.qty), price = Number(i.result.averagePrice);
      let charges = 0;
      try { charges = round2(calc.getZerodhaCharges('Equity', 0, qty * price, settings, i.exchange || 'NSE').total || 0); } catch (_) { charges = 0; }
      let status;
      try {
        status = await store.rpc('exec_commit_fill', { p_intent_id: i.id, p_qty: qty, p_price: price, p_charges: charges,
          p_date: istDate(now()), p_source: sourceOf(i), p_order_ref: String(i.broker_ref || i.result.orderId || '') });
      } catch (e) {
        log('booking failed', { symbol: i.symbol, error: e.message.slice(0, 160) });       // e.g. migration 012 not run: retried next pass
        out.notBooked++;
        continue;
      }
      const ok = status === 'booked_final' || status === 'booked_partial';
      ok ? out.booked++ : out.notBooked++;
      try {
        await store.insert('order_audit', [{ id: `${i.id}:${now()}:bk${Math.random().toString(36).slice(2, 6)}`, user_id: uid, intent_id: i.id, symbol: i.symbol,
          event: ok ? 'booked' : 'not_booked', detail: { status, qty, price, charges }, at: new Date(now()).toISOString() }]);
      } catch (_) { /* audit is best effort */ }
      log('booking', { symbol: i.symbol, status, qty, price });
    }
    return out;
  }
  return { bookPending };
}

module.exports = { createBooking, sourceOf };
