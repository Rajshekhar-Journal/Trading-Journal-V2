/**
 * og/lib/kite-adapter.js — Zerodha Kite Connect adapter, PHASE 1: READ ONLY.
 *
 * This file can log in and read. It has no method that places, modifies or cancels an order or a
 * GTT, and `_get` is the only request helper besides the login exchange. Order methods arrive in
 * P3/P4 behind the guards; until then there is no code path that can move money.
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

function createKiteAdapter({ baseUrl, loginUrl, apiKey, apiSecret, accessToken, fetchImpl, timeoutMs = 10000 }) {
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

  return {
    readOnly: true,
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
