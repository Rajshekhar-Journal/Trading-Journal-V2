/**
 * tests/helpers/fake-kite.js — an in-process stand-in for Kite Connect + Supabase + the IP lookup.
 * Returned as a `fetch` replacement, so the gateway code under test runs unchanged.
 */
'use strict';
const crypto = require('crypto');

function createFakeWorld({ apiKey = 'key123', apiSecret = 'sec456', clientId = 'AB1234', publicIp = '203.0.113.10' } = {}) {
  const w = {
    apiKey, apiSecret, clientId, publicIp,
    accessToken: 'tok_' + crypto.randomBytes(6).toString('hex'),
    tokenDead: false,
    kiteCalls: [],                     // { method, path }
    holdings: [], positions: { net: [], day: [] }, orders: [], gtts: [],
    margins: { equity: { net: 100000 } },
    db: { exec_state: [], broker_snapshots: [], broker_orders: [], broker_gtts: [], drift_log: [], trades: [], order_intents: [], order_audit: [], alert_log: [], settings: [] },
    gttWrites: [], nextGttId: 9001, placeBehaviour: 'ok',   // ok | reject | timeout_applied | timeout_lost
    orderWrites: [], nextOrderId: 5001, sellBehaviour: 'fill',   // fill | partial | open | stuck | reject | refuse | timeout_applied | timeout_lost
    uid: '11111111-1111-1111-1111-111111111111',
    journalPassword: 'journal-pass', refreshToken: 'rt_1',
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = data => json(200, { status: 'success', data });

  const KEYS = { exec_state: ['user_id'], broker_snapshots: ['user_id', 'kind'], broker_orders: ['user_id', 'order_id'], broker_gtts: ['user_id', 'gtt_id'], drift_log: ['id'] };
  function match(row, params) {
    for (const [k, v] of params) {
      if (['select', 'on_conflict', 'order'].includes(k)) continue;
      const [op, ...rest] = v.split('.'); const val = rest.join('.');
      if (op === 'eq' && String(row[k]) !== val) return false;
      if (op === 'lt' && !(String(row[k]) < val)) return false;
      if (op === 'is' && val === 'null' && row[k] != null) return false;
      if (op === 'in' && !val.replace(/^\(|\)$/g, '').split(',').includes(String(row[k]))) return false;
    }
    return true;
  }

  w.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const method = (init.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));

    if (url.hostname === 'ip.test') return new Response(w.publicIp);

    if (url.hostname === 'kite.test') {
      w.kiteCalls.push({ method, path: url.pathname });
      if (url.pathname === '/session/token') {
        const f = new URLSearchParams(init.body);
        const want = crypto.createHash('sha256').update(apiKey + f.get('request_token') + apiSecret).digest('hex');
        if (f.get('api_key') !== apiKey || f.get('checksum') !== want || f.get('request_token') === 'bad')
          return json(403, { status: 'error', message: 'Invalid checksum', error_type: 'TokenException' });
        return ok({ access_token: w.accessToken, user_id: f.get('request_token') === 'other' ? 'ZZ9999' : w.clientId, user_name: 'Test', login_time: '2026-11-11 08:50:00' });
      }
      const authed = () => !w.tokenDead && headers.authorization === `token ${apiKey}:${w.accessToken}`;
      const gm = /^\/gtt\/triggers(?:\/(\d+))?$/.exec(url.pathname);
      if (gm && (method === 'POST' || method === 'PUT')) {                 // the only writes the fake accepts: stop GTT place / modify
        if (!authed()) return json(403, { status: 'error', message: 'Incorrect `api_key` or `access_token`.', error_type: 'TokenException' });
        const f = new URLSearchParams(init.body), cond = JSON.parse(f.get('condition')), orders = JSON.parse(f.get('orders'));
        w.gttWrites.push({ method, id: gm[1] || null, cond, orders });
        if (w.placeBehaviour === 'reject') return json(400, { status: 'error', message: 'Trigger price is too close to the last price', error_type: 'InputException' });
        const apply = () => {
          if (method === 'POST') { const id = w.nextGttId++; w.gtts.push({ id, status: 'active', type: 'single', condition: cond, orders }); return id; }
          const g = w.gtts.find(x => String(x.id) === gm[1]); g.condition = cond; g.orders = orders; return g.id;
        };
        if (w.placeBehaviour === 'timeout_lost') throw new Error('socket hang up');
        const id = apply();
        if (w.placeBehaviour === 'timeout_applied') throw new Error('socket hang up');
        return ok({ trigger_id: id });
      }
      // Exits: one market SELL, cancelling an order, deleting a GTT. The fake refuses anything that is not a CNC market SELL.
      const om = /^\/orders\/regular(?:\/(\w+))?$/.exec(url.pathname);
      if (om && method === 'POST' && !om[1]) {
        if (!authed()) return json(403, { status: 'error', message: 'Incorrect `api_key` or `access_token`.', error_type: 'TokenException' });
        const f = Object.fromEntries(new URLSearchParams(init.body));
        w.orderWrites.push({ method, ...f });
        if (f.transaction_type !== 'SELL' || f.order_type !== 'MARKET' || f.product !== 'CNC' || !['-1', '5', '10'].includes(f.market_protection))
          return json(400, { status: 'error', message: 'fake kite accepts only protected CNC market sells', error_type: 'InputException' });
        const beh = w.sellScript && w.sellScript.length ? w.sellScript.shift() : w.sellBehaviour;
        if (beh === 'refuse') return json(400, { status: 'error', message: 'Insufficient holdings', error_type: 'InputException' });
        if (beh === 'timeout_lost') throw new Error('socket hang up');
        const qty = Number(f.quantity), id = String(w.nextOrderId++);
        const filled = { fill: qty, partial: Math.floor(qty / 2), open: 0, reject: 0, timeout_applied: qty, stuck: 0 }[beh] ?? qty;
        const status = { fill: 'COMPLETE', timeout_applied: 'COMPLETE', reject: 'REJECTED' }[beh] || 'OPEN';
        w.orders.push({ order_id: id, status, tradingsymbol: f.tradingsymbol, exchange: f.exchange, transaction_type: 'SELL', order_type: 'LIMIT', product: 'CNC',
          quantity: qty, filled_quantity: filled, pending_quantity: qty - filled, average_price: filled ? (w.fillPrice || 99.5) : 0, tag: f.tag, stuck: beh === 'stuck', status_message: status === 'REJECTED' ? 'RMS: rule violated' : null });
        const h = w.holdings.find(x => x.tradingsymbol === f.tradingsymbol); if (h) h.quantity -= filled;
        if (beh === 'timeout_applied') throw new Error('socket hang up');
        return ok({ order_id: id });
      }
      if (om && method === 'DELETE' && om[1]) {
        if (!authed()) return json(403, { status: 'error', message: 'token', error_type: 'TokenException' });
        w.orderWrites.push({ method, id: om[1] });
        const o = w.orders.find(x => x.order_id === om[1]);
        if (o && !['COMPLETE', 'CANCELLED', 'REJECTED'].includes(o.status) && !o.stuck && w.sellBehaviour !== 'stuck') { o.status = 'CANCELLED'; o.pending_quantity = 0; }
        return ok({ order_id: om[1] });
      }
      if (gm && method === 'DELETE' && gm[1]) {
        if (!authed()) return json(403, { status: 'error', message: 'token', error_type: 'TokenException' });
        w.gttWrites.push({ method, id: gm[1] });
        if (w.gttDeleteFails) return json(400, { status: 'error', message: 'cannot delete', error_type: 'InputException' });
        w.gtts = w.gtts.filter(x => String(x.id) !== gm[1]);
        return ok({ trigger_id: Number(gm[1]) });
      }
      if (method !== 'GET') return json(405, { status: 'error', message: 'fake kite accepts no other writes', error_type: 'InputException' });
      if (w.tokenDead || headers.authorization !== `token ${apiKey}:${w.accessToken}`)
        return json(403, { status: 'error', message: 'Incorrect `api_key` or `access_token`.', error_type: 'TokenException' });
      const route = { '/user/profile': { user_id: w.clientId }, '/user/margins': w.margins, '/orders': w.orders, '/trades': [],
        '/portfolio/holdings': w.holdings, '/portfolio/positions': w.positions, '/gtt/triggers': w.gtts }[url.pathname];
      return route === undefined ? json(404, { status: 'error', message: 'no route' }) : ok(route);
    }

    if (url.hostname === 'sb.test') {
      if (url.pathname === '/auth/v1/token') {
        const b = JSON.parse(init.body); const grant = url.searchParams.get('grant_type');
        const good = grant === 'password' ? b.password === w.journalPassword : b.refresh_token === w.refreshToken;
        if (!good) return json(400, { error_description: 'Invalid login credentials' });
        return json(200, { access_token: 'jwt_user', refresh_token: w.refreshToken, expires_in: 3600, user: { id: w.uid } });
      }
      if (headers.authorization !== 'Bearer jwt_user') return json(401, { message: 'no auth' });
      if (url.pathname === '/rest/v1/rpc/exec_commit_fill') {                 // JS mirror of migration 012
        if (w.noMigration012) return json(404, { code: 'PGRST202', message: 'Could not find the function public.exec_commit_fill' });
        const a = JSON.parse(init.body); const i = w.db.order_intents.find(x => x.id === a.p_intent_id && x.user_id === w.uid);
        if (!i) return json(200, 'not_found');
        if (i.booked_at) return json(200, 'already_booked');
        if (i.booking) return json(200, i.booking);
        if (i.mode !== 'confirm' || !['EXIT_PARTIAL', 'EXIT_ALL', 'EMERGENCY_EXIT', 'GTT_STOP_FILL'].includes(i.action) || !['done', 'failed'].includes(i.status)) return json(200, 'not_bookable');
        const sum = arr => (arr || []).reduce((s, e) => s + (Number(e.qty) || 0), 0);
        const t = w.db.trades.find(x => x.id === i.trade_id && x.user_id === w.uid);
        let out = null;
        if (!(a.p_qty > 0) || !(a.p_price > 0)) out = 'nothing_filled';
        else if (a.p_qty > i.qty) out = 'qty_exceeds_intent';
        else if (!i.trade_id || !t) out = 'no_trade';
        else if (t.final_exit) out = 'trade_closed';
        if (!out) {
          const open = sum(t.entries) + sum(t.pyramids) - sum(t.partial_exits);
          const rec = { id: 'ax_' + i.id, date: a.p_date, price: a.p_price, qty: a.p_qty, charges: a.p_charges || 0, actionSource: a.p_source, auto: true, orderRef: a.p_order_ref, intentId: i.id };
          if (a.p_qty > open) out = 'qty_exceeds_open';
          else if (a.p_qty === open) { t.final_exit = rec; out = 'booked_final'; }
          else { t.partial_exits = [...(t.partial_exits || []), rec]; out = 'booked_partial'; }
        }
        i.booking = out; if (out.startsWith('booked_')) i.booked_at = new Date().toISOString();
        if (out.startsWith('booked_') && i.alert_id && a.p_qty === i.qty) { const al = w.db.alert_log.find(x => x.id === i.alert_id); if (al && al.status === 'New') al.status = 'Executed'; }
        return json(200, out);
      }
      if (url.pathname === '/rest/v1/rpc/exec_intent_transition') {
        const a = JSON.parse(init.body); const it = w.db.order_intents.find(i => i.id === a.p_id && i.user_id === w.uid);
        const allowed = { approved: ['sending', 'expired'], sending: ['done', 'failed', 'unknown'], unknown: ['done', 'failed'] };
        const okMove = !!it && it.mode === 'confirm' && it.status === a.p_from && (allowed[a.p_from] || []).includes(a.p_to);
        if (okMove) Object.assign(it, { status: a.p_to, result: a.p_result ?? it.result ?? null, broker_ref: a.p_broker_ref ?? it.broker_ref ?? null });
        return json(200, okMove);
      }
      const table = url.pathname.replace('/rest/v1/', ''); const rows = w.db[table];
      if (!rows) return json(404, { message: 'no table ' + table });
      if (method === 'GET') return json(200, rows.filter(r => match(r, url.searchParams)));
      if (method === 'POST' && !KEYS[table]) {
        const incoming = JSON.parse(init.body);
        if (table === 'order_intents' && incoming.some(r => rows.some(x => x.user_id === r.user_id && x.intent_key === r.intent_key)))
          return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "order_intents_user_key_uidx"' });
        rows.push(...incoming); return new Response('', { status: 201 });
      }
      if (method === 'POST') {
        for (const row of JSON.parse(init.body)) {
          if (row.user_id && row.user_id !== w.uid) return json(403, { message: 'RLS' });
          if (table === 'broker_snapshots' && (w.rejectKinds || []).includes(row.kind)) return json(400, { message: 'violates check constraint "broker_snapshots_kind_check"' });
          const keys = KEYS[table]; const i = rows.findIndex(r => keys.every(k => r[k] === row[k]));
          if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push({ ...row });
        }
        return new Response('', { status: 201 });
      }
      if (method === 'PATCH') { const patch = JSON.parse(init.body); rows.filter(r => match(r, url.searchParams)).forEach(r => Object.assign(r, patch)); return new Response(null, { status: 204 }); }
    }
    return json(404, { message: 'unknown host ' + url.hostname });
  };
  return w;
}

module.exports = { createFakeWorld };
