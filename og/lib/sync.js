/**
 * og/lib/sync.js — P1 loops: heartbeat, broker read-only sync, reconcile report.
 * `broker` is a BrokerPort (kite-adapter or the test fake); `store` is a supabase-rest client.
 */
'use strict';
const { reconcile, protection } = require('./reconcile.js');

const VERSION = 'og-0.4.0-p4';

function createSync({ broker, store, getState, log = () => {} }) {
  /** Gateway health row the journal reads. Contains status only — no secret, no IP address. */
  async function heartbeat(extra = {}) {
    const uid = await store.userId();
    const st = getState();
    const row = {
      user_id: uid,
      gateway_version: VERSION,
      heartbeat_at: new Date().toISOString(),
      broker_connected: !!st.brokerConnected,
      token_valid_until: st.tokenValidUntil || null,
      ip_ok: !!(st.ip && st.ip.ok),
      ip_status: st.ip ? st.ip.reason : 'not_checked',
      ip_checked_at: st.ip ? st.ip.at : null,
      order_sending_enabled: !!st.orderSending,        // true only when stop-GTT placement is on AND the static IP matches AND logged in
      updated_at: new Date().toISOString(),
      ...extra,
    };
    await store.upsert('exec_state', [row], 'user_id');
    return row;
  }

  /** Read broker state, store it, compare with the journal, record drift. */
  async function syncOnce() {
    const uid = await store.userId();
    const now = new Date().toISOString();
    const [orders, holdings, positions, gtts, margins] = await Promise.all(
      [broker.orders(), broker.holdings(), broker.positions(), broker.gtts(), broker.margins()]);

    await store.upsert('broker_snapshots', [
      { user_id: uid, kind: 'holdings', data: holdings, taken_at: now },
      { user_id: uid, kind: 'positions', data: positions, taken_at: now },
      { user_id: uid, kind: 'funds', data: margins, taken_at: now },
    ], 'user_id,kind');

    await store.upsert('broker_orders', (orders || []).map(o => ({
      user_id: uid, order_id: String(o.order_id), status: o.status, tradingsymbol: o.tradingsymbol, exchange: o.exchange,
      transaction_type: o.transaction_type, order_type: o.order_type, product: o.product,
      quantity: o.quantity, filled_quantity: o.filled_quantity, pending_quantity: o.pending_quantity,
      price: o.price, trigger_price: o.trigger_price, average_price: o.average_price, tag: o.tag || null,
      status_message: o.status_message || null, order_timestamp: _ts(o.order_timestamp), raw: o, synced_at: now,
    })), 'user_id,order_id');

    await store.upsert('broker_gtts', (gtts || []).map(g => ({
      user_id: uid, gtt_id: String(g.id), status: g.status, gtt_type: g.type,
      tradingsymbol: g.condition && g.condition.tradingsymbol, exchange: g.condition && g.condition.exchange,
      trigger_values: (g.condition && g.condition.trigger_values) || [], orders: g.orders || [],
      expires_at: _ts(g.expires_at), raw: g, present: true, synced_at: now,
    })), 'user_id,gtt_id');
    await store.update('broker_gtts', `user_id=eq.${uid}&synced_at=lt.${encodeURIComponent(now)}&present=eq.true`, { present: false });

    const trades = await store.select('trades', `select=id,symbol,direction,entries,pyramids,partial_exits,final_exit,current_stop,initial_stop,closed_at&user_id=eq.${uid}&closed_at=is.null`);
    const drift = reconcile({ trades, holdings, positions, gtts });
    await store.upsert('drift_log', drift.map(d => ({
      id: `${uid}:${d.kind}:${d.symbol}`, user_id: uid, kind: d.kind, symbol: d.symbol, severity: d.severity,
      journal_qty: d.journalQty, broker_qty: d.brokerQty, detail: d.detail, status: 'open', last_seen_at: now, resolved_at: null,
    })), 'id');
    await store.update('drift_log', `user_id=eq.${uid}&status=eq.open&last_seen_at=lt.${encodeURIComponent(now)}`, { status: 'resolved', resolved_at: now });

    // Protection state per open position. Stored separately so an older database (before migration 010)
    // cannot break the rest of the sync.
    const prot = protection({ trades, holdings, positions, gtts });
    let protectionStored = true;
    try { await store.upsert('broker_snapshots', [{ user_id: uid, kind: 'protection', data: prot, taken_at: now }], 'user_id,kind'); }
    catch (e) { protectionStored = false; log('protection report not stored (run migration 010)', { error: e.message.slice(0, 120) }); }

    const result = { at: now, orders: (orders || []).length, holdings: (holdings || []).length, gtts: (gtts || []).length,
      drift: drift.length, driftHigh: drift.filter(d => d.severity === 'high').length,
      positions: prot.length, notProtected: prot.filter(p => p.state !== 'PROTECTED').length, protectionStored };
    await heartbeat({ last_sync_at: now, last_sync_result: result, open_drift_count: drift.length });
    log('sync', result);
    return { result, drift, protection: prot, raw: { orders, holdings, positions, gtts, trades } };
  }

  return { heartbeat, syncOnce, VERSION };
}

function _ts(v) {
  if (!v) return null;
  const d = new Date(String(v).includes('T') ? v : String(v).replace(' ', 'T') + '+05:30');   // Kite times are IST
  return isNaN(d) ? null : d.toISOString();
}

module.exports = { createSync, VERSION };
