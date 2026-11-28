/**
 * og/lib/clock-check.js — is this machine's clock right?
 * Every log time, audit time and market-window check comes from this machine's clock, so it is compared
 * with a server's clock (the HTTP Date header). The round trip is measured and the midpoint used.
 * Date headers have 1-second resolution, so offsets under ~1 s are noise.
 */
'use strict';

async function checkClock({ url, fetchImpl = globalThis.fetch, now = () => Date.now(), maxDriftSec = 30, timeoutMs = 10000 }) {
  if (!url) return { ok: null, reason: 'no_url' };
  const t0 = now();
  let res;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try { res = await fetchImpl(url, { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, signal: ac ? ac.signal : undefined }); }
  catch (e) { return { ok: null, reason: 'lookup_failed', error: String(e.message || e).slice(0, 120), at: new Date(t0).toISOString() }; }
  finally { if (timer) clearTimeout(timer); }
  const t1 = now();
  const h = res && res.headers && (typeof res.headers.get === 'function' ? res.headers.get('date') : res.headers.date);
  const server = h ? Date.parse(h) : NaN;
  if (!Number.isFinite(server)) return { ok: null, reason: 'no_date_header', at: new Date(t1).toISOString() };
  const local = (t0 + t1) / 2;
  const offsetSec = Math.round((local - (server + 500)) / 1000) || 0;   // + 500 ms: the header is truncated to the second
  return { ok: Math.abs(offsetSec) <= maxDriftSec, offsetSec, roundTripMs: t1 - t0, serverTime: new Date(server).toISOString(), at: new Date(t1).toISOString(), maxDriftSec };
}

module.exports = { checkClock };
