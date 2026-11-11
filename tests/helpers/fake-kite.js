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
    db: { exec_state: [], broker_snapshots: [], broker_orders: [], broker_gtts: [], drift_log: [], trades: [] },
    uid: '11111111-1111-1111-1111-111111111111',
    journalPassword: 'journal-pass', refreshToken: 'rt_1',
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = data => json(200, { status: 'success', data });

  const KEYS = { exec_state: ['user_id'], broker_snapshots: ['user_id', 'kind'], broker_orders: ['user_id', 'order_id'], broker_gtts: ['user_id', 'gtt_id'], drift_log: ['id'] };
  function match(row, params) {
    for (const [k, v] of params) {
      if (['select', 'on_conflict'].includes(k)) continue;
      const [op, ...rest] = v.split('.'); const val = rest.join('.');
      if (op === 'eq' && String(row[k]) !== val) return false;
      if (op === 'lt' && !(String(row[k]) < val)) return false;
      if (op === 'is' && val === 'null' && row[k] != null) return false;
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
      if (method !== 'GET') return json(405, { status: 'error', message: 'fake kite is read only', error_type: 'InputException' });
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
      const table = url.pathname.replace('/rest/v1/', ''); const rows = w.db[table];
      if (!rows) return json(404, { message: 'no table ' + table });
      if (method === 'GET') return json(200, rows.filter(r => match(r, url.searchParams)));
      if (method === 'POST') {
        for (const row of JSON.parse(init.body)) {
          if (row.user_id && row.user_id !== w.uid) return json(403, { message: 'RLS' });
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
