/**
 * og/lib/kite-adapter.js — Zerodha Kite Connect adapter.
 *
 * By default it can only log in and read. With `allowGttWrites: true` (set by the gateway only when
 * stop-GTT placement is switched on and the static IP matches) it can also place and modify a
 * stop-loss GTT. With `allowSellOrders: true` (exits switched on, static IP matching) it can also send
 * one market SELL of delivery shares, cancel an order and delete a stop GTT. It has NO method that
 * places a BUY or any priced order.
 */
'use strict';
const crypto = require('crypto');

class KiteError extends Error {
  constructor(message, { status, errorType } = {}) {
    super(message);
    this.name = 'KiteError';
    this.status = status;
    this.errorType = errorType;                       // e.g. TokenException, InputException
    this.tokenInvalid = errorType === 'TokenException' || status === 403;
  }
}

function createKiteAdapter({ baseUrl, loginUrl, apiKey, apiSecret, accessToken, fetchImpl, timeoutMs = 10000, allowGttWrites = false, allowSellOrders = false }) {
  const _fetch = fetchImpl || globalThis.fetch;
  let _token = accessToken || '';

  async function _call(method, path, { form, auth = true } = {}) {
    const headers = { 'X-Kite-Version': '3' };
    if (auth) {
      if (!_token) throw new KiteError('Not logged in to Kite', { status: 403, errorType: 'TokenException' });
      headers.Authorization = `token ${apiKey}:${_token}`;
    }
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res, json;
    try {
      res = await _fetch(baseUrl.replace(/\/$/, '') + path, { method, headers, body, signal: ctl.signal });
      json = await res.json().catch(() => null);
    } catch (e) {
      throw new KiteError(e.name === 'AbortError' ? 'Kite request timed out' : 'Kite request failed: ' + e.message, { status: 0, errorType: 'NetworkException' });
    } finally { clearTimeout(timer); }
    if (!res.ok || !json || json.status !== 'success') {
      throw new KiteError((json && json.message) || `Kite HTTP ${res.status}`, { status: res.status, errorType: json && json.error_type });
    }
    return json.data;
  }
  const _get = path => _call('GET', path);

  /** Form body of a single-leg stop-loss sell GTT (LIMIT, CNC). */
  function _gttForm({ symbol, exchange = 'NSE', trigger, limit, qty, lastPrice }) {
    return {
      type: 'single',
      condition: JSON.stringify({ exchange, tradingsymbol: symbol, trigger_values: [trigger], last_price: lastPrice }),
      orders: JSON.stringify([{ exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product: 'CNC', price: limit }]),
    };
  }
  const gttWrites = allowGttWrites ? {
    /** @returns { triggerId } */
    async placeStopGtt(spec) { const d = await _call('POST', '/gtt/triggers', { form: _gttForm(spec) }); return { triggerId: String(d.trigger_id) }; },
    async modifyStopGtt(id, spec) { const d = await _call('PUT', `/gtt/triggers/${encodeURIComponent(id)}`, { form: _gttForm(spec) }); return { triggerId: String(d.trigger_id ?? id) }; },
  } : {};

  // Exits (Phase 4): one market SELL for delivery shares, cancelling that order, and deleting a stop GTT.
  // There is deliberately no way to pass a BUY, a price, or any other order type through this adapter.
  const sellWrites = allowSellOrders ? {
    /** @returns { orderId } */
    async placeMarketSell({ symbol, exchange = 'NSE', qty, tag, protection = -1 }) {
      // -1 = Zerodha's automatic protection; 5 and 10 are used only by the Emergency Exit ladder. Nothing else is accepted.
      if (![-1, 5, 10].includes(protection)) throw new KiteError('market protection must be -1, 5 or 10', { status: 0, errorType: 'InputException' });
      const d = await _call('POST', '/orders/regular', { form: { tradingsymbol: symbol, exchange, transaction_type: 'SELL', order_type: 'MARKET',
        quantity: String(qty), product: 'CNC', validity: 'DAY', market_protection: String(protection), tag } });
      return { orderId: String(d.order_id) };
    },
    async cancelOrder(orderId) { await _call('DELETE', `/orders/regular/${encodeURIComponent(orderId)}`); return { orderId: String(orderId) }; },
    async deleteGtt(id) { await _call('DELETE', `/gtt/triggers/${encodeURIComponent(id)}`); return { triggerId: String(id) }; },
  } : {};

  return {
    readOnly: !allowGttWrites && !allowSellOrders,
    ...gttWrites,
    ...sellWrites,
    setAccessToken(t) { _token = t || ''; },
    hasToken() { return !!_token; },

    /** URL the user opens to log in. Kite redirects back with ?request_token=… */
    loginUrl() { return `${loginUrl}?v=3&api_key=${encodeURIComponent(apiKey)}`; },

    /** Exchange the one-time request_token for the day's access token. */
    async createSession(requestToken) {
      const checksum = crypto.createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex');
      const data = await _call('POST', '/session/token', { auth: false, form: { api_key: apiKey, request_token: requestToken, checksum } });
      _token = data.access_token;
      return { accessToken: data.access_token, userId: data.user_id, userName: data.user_name, loginTime: data.login_time };
    },

    profile:   () => _get('/user/profile'),
    margins:   () => _get('/user/margins'),
    orders:    () => _get('/orders'),
    trades:    () => _get('/trades'),
    holdings:  () => _get('/portfolio/holdings'),
    positions: () => _get('/portfolio/positions'),
    gtts:      () => _get('/gtt/triggers'),
  };
}

/** Kite access tokens lapse at 06:00 IST the next morning. Returns that instant for a login time. */
function tokenValidUntil(loginAt = new Date()) {
  const IST = 330 * 60000;
  const ist = new Date(loginAt.getTime() + IST);
  const sixAm = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0) - IST;
  return new Date(loginAt.getTime() < sixAm ? sixAm : sixAm + 86400000);
}

module.exports = { createKiteAdapter, KiteError, tokenValidUntil };
