/**
 * og/lib/kite-adapter.js — the ONLY door between the gateway and Zerodha.
 *
 * Underneath it uses Zerodha's official JavaScript client (the `kiteconnect` package, installed in
 * og/node_modules and pinned to an exact version). The rest of the gateway never touches that client;
 * it sees only the small set of functions below, so what the gateway can do at the broker is decided here:
 *
 *   always            log in, read profile / funds / orders / trades / holdings / positions / GTTs
 *   allowGttWrites    place and modify a single-leg stop-loss SELL GTT (LIMIT, CNC)
 *   allowSellOrders   one market SELL of delivery shares (protection -1, 5 or 10), cancel an order, delete a GTT
 *
 * There is no function here that can express a BUY, a priced order or any other product.
 */
'use strict';
const { KiteConnect } = require('kiteconnect');

class KiteError extends Error {
  constructor(message, { status, errorType } = {}) {
    super(message);
    this.name = 'KiteError';
    this.status = status;
    this.errorType = errorType;                       // TokenException, InputException, NetworkException, …
    this.tokenInvalid = errorType === 'TokenException' || status === 403;
  }
}

/** The client rejects with a plain object { message, error_type }. Turn it into one error type for the gateway. */
function toKiteError(e) {
  if (e instanceof KiteError) return e;
  const type = (e && e.error_type) || (e && e.code ? 'NetworkException' : 'GeneralException');
  return new KiteError((e && e.message) || 'Kite request failed', { status: e && e.status_code, errorType: type });
}

/**
 * The client turns Kite's "YYYY-MM-DD HH:MM:SS" (which is IST) into a Date using THIS machine's time zone.
 * Read the wall-clock parts back and state the zone explicitly, so the time is right on any machine.
 */
const pad = n => String(n).padStart(2, '0');
function istIso(v) {
  if (!(v instanceof Date) || isNaN(v)) return v;
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}+05:30`;
}
const TIME_FIELDS = ['order_timestamp', 'exchange_timestamp', 'fill_timestamp'];
const fixTimes = rows => (rows || []).map(r => { const o = { ...r }; for (const f of TIME_FIELDS) if (o[f] instanceof Date) o[f] = istIso(o[f]); return o; });

/**
 * Test seam only: when a `fetchImpl` is given (the in-process fake broker), the client's HTTP transport is
 * replaced by it. Everything else — parameters, encoding, checksum, error handling — is the real client.
 */
function fetchTransport(fetchImpl) {
  return async config => {
    const url = new URL((config.baseURL || '').replace(/\/$/, '') + config.url);
    for (const [k, v] of Object.entries(config.params || {})) if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    const headers = typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : { ...(config.headers || {}) };
    let res;
    try { res = await fetchImpl(url.toString(), { method: String(config.method || 'get').toUpperCase(), headers, body: config.data ?? undefined }); }
    catch (e) { const err = new Error(e.message); err.code = 'ECONNRESET'; err.request = {}; err.config = config; throw err; }
    const response = { data: await res.text(), status: res.status, statusText: res.statusText || '', headers: Object.fromEntries(res.headers.entries()), config, request: {} };
    if (res.status >= 200 && res.status < 300) return response;
    const err = new Error('Request failed with status code ' + res.status); err.response = response; err.config = config; err.request = {};
    throw err;
  };
}

function createKiteAdapter({ baseUrl, loginUrl, apiKey, apiSecret, accessToken, fetchImpl, timeoutMs = 10000, allowGttWrites = false, allowSellOrders = false }) {
  const kc = new KiteConnect({ api_key: apiKey, root: baseUrl || undefined, timeout: timeoutMs, access_token: accessToken || undefined });
  if (fetchImpl) kc.requestInstance.defaults.adapter = fetchTransport(fetchImpl);
  let _token = accessToken || '';

  const call = async (fn, { auth = true } = {}) => {
    if (auth && !_token) throw new KiteError('Not logged in to Kite', { status: 403, errorType: 'TokenException' });
    let out;
    try { out = await fn(); } catch (e) { throw toKiteError(e); }
    // The client hands back an error-shaped object (instead of throwing) when the reply is not JSON.
    if (out && typeof out === 'object' && !Array.isArray(out) && out.error_type && out.message) throw toKiteError(out);
    return out;
  };

  /** One single-leg stop-loss sell GTT (LIMIT, CNC) — the only GTT shape this gateway can create. */
  const gttParams = ({ symbol, exchange = 'NSE', trigger, limit, qty, lastPrice }) => ({
    trigger_type: 'single', tradingsymbol: symbol, exchange, trigger_values: [trigger], last_price: lastPrice,
    orders: [{ transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product: 'CNC', price: limit }],
  });
  const gttWrites = allowGttWrites ? {
    /** @returns { triggerId } */
    async placeStopGtt(spec) { const d = await call(() => kc.placeGTT(gttParams(spec))); return { triggerId: String(d.trigger_id) }; },
    async modifyStopGtt(id, spec) { const d = await call(() => kc.modifyGTT(id, gttParams(spec))); return { triggerId: String((d && d.trigger_id) ?? id) }; },
  } : {};

  const sellWrites = allowSellOrders ? {
    /** @returns { orderId } */
    async placeMarketSell({ symbol, exchange = 'NSE', qty, tag, protection = -1 }) {
      // -1 = Zerodha's automatic protection; 5 and 10 are used only by the Emergency Exit ladder. Nothing else is accepted.
      if (![-1, 5, 10].includes(protection)) throw new KiteError('market protection must be -1, 5 or 10', { status: 0, errorType: 'InputException' });
      const d = await call(() => kc.placeOrder('regular', { tradingsymbol: symbol, exchange, transaction_type: 'SELL', order_type: 'MARKET',
        quantity: qty, product: 'CNC', validity: 'DAY', market_protection: protection, tag }));
      return { orderId: String(d.order_id) };
    },
    async cancelOrder(orderId) { await call(() => kc.cancelOrder('regular', orderId)); return { orderId: String(orderId) }; },
    async deleteGtt(id) { await call(() => kc.deleteGTT(id)); return { triggerId: String(id) }; },
  } : {};

  return {
    readOnly: !allowGttWrites && !allowSellOrders,
    ...gttWrites,
    ...sellWrites,
    setAccessToken(t) { _token = t || ''; kc.setAccessToken(_token); },
    hasToken() { return !!_token; },

    /** URL the user opens to log in. Kite redirects back with ?request_token=… */
    loginUrl() { return loginUrl ? `${loginUrl}?api_key=${encodeURIComponent(apiKey)}&v=3` : kc.getLoginURL(); },

    /** Exchange the one-time request_token for the day's access token. */
    async createSession(requestToken) {
      const data = await call(() => kc.generateSession(requestToken, apiSecret), { auth: false });
      _token = data.access_token;
      return { accessToken: data.access_token, userId: data.user_id, userName: data.user_name, loginTime: data.login_time };
    },

    profile:   () => call(() => kc.getProfile()),
    margins:   () => call(() => kc.getMargins()),
    orders:    () => call(() => kc.getOrders()).then(fixTimes),
    trades:    () => call(() => kc.getTrades()).then(fixTimes),
    holdings:  () => call(() => kc.getHoldings()),
    positions: () => call(() => kc.getPositions()),
    gtts:      () => call(() => kc.getGTTs()),
  };
}

/** Kite access tokens lapse at 06:00 IST the next morning. Returns that instant for a login time. */
function tokenValidUntil(loginAt = new Date()) {
  const IST = 330 * 60000;
  const ist = new Date(loginAt.getTime() + IST);
  const sixAm = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0) - IST;
  return new Date(loginAt.getTime() < sixAm ? sixAm : sixAm + 86400000);
}

module.exports = { createKiteAdapter, KiteError, tokenValidUntil, istIso };
