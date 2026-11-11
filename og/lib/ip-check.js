/**
 * og/lib/ip-check.js — compares this machine's public IP with the static IP registered at Zerodha.
 * Blank or mismatching expected IP → order sending must stay off (read-only work continues).
 */
'use strict';
const { isIPv4 } = require('./config.js');

async function checkPublicIp({ expected, url, fetchImpl, timeoutMs = 8000 }) {
  const at = new Date().toISOString();
  if (!expected) return { ok: false, reason: 'not_configured', at };
  if (!isIPv4(expected)) return { ok: false, reason: 'expected_ip_invalid', at };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await (fetchImpl || globalThis.fetch)(url, { signal: ctl.signal });
    const seen = (await res.text()).trim();
    if (!isIPv4(seen)) return { ok: false, reason: 'lookup_failed', at };
    return seen === expected.trim() ? { ok: true, reason: 'match', at } : { ok: false, reason: 'mismatch', at, seen };
  } catch (_) {
    return { ok: false, reason: 'lookup_failed', at };
  } finally { clearTimeout(timer); }
}

module.exports = { checkPublicIp };
