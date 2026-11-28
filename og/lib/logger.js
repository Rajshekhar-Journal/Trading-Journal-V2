/**
 * og/lib/logger.js — the gateway's own log, for the audit trail.
 *
 * One file per IST day: <dataDir>/logs/og-YYYY-MM-DD.log, one JSON line per entry, e.g.
 *   {"ts":"2026-11-28 09:22:15.123 IST","utc":"2026-11-28T03:52:15.123Z","lvl":"INFO","host":"HP-LAPTOP","v":"og-0.5.0",
 *    "cat":"order","event":"done","symbol":"63MOONS","intent":"in_…","msg":"…","detail":{…}}
 * The same entry is echoed to the terminal in short form: [2026-11-28 09:22:15 IST] INFO order done 63MOONS – …
 * Files older than `retentionDays` (a setting) are removed. Tokens, keys and passwords are blanked before anything is written.
 *
 * The returned function also accepts the old call style log('[og] something', '{"json":1}') so existing callers keep working.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const IST_MS = 330 * 60000;                     // India has no daylight saving: always UTC+05:30
const pad = (n, w = 2) => String(n).padStart(w, '0');
function istParts(ms) {
  const d = new Date(ms + IST_MS);
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`, ms: pad(d.getUTCMilliseconds(), 3) };
}
const istStamp = ms => { const p = istParts(ms); return `${p.date} ${p.time}.${p.ms} IST`; };

// ── Redaction: nothing secret ever reaches a log line ──
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|apikey|anon[_-]?key|authorization|cookie|checksum|csrf|sid)$/i;
const SECRET_TEXT = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***'],
  [/((?:access_token|refresh_token|request_token|api_key|api_secret|apikey|password|enctoken)["'=:\s]+)[^"'&\s,}]{4,}/gi, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***jwt***'],
];
function redactText(s) { let t = String(s); for (const [re, to] of SECRET_TEXT) t = t.replace(re, to); return t; }
function redact(v, depth = 0) {
  if (v == null || depth > 6) return v;
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && x != null && x !== '' && typeof x !== 'boolean' ? '***' : redact(x, depth + 1);
    return o;
  }
  return v;
}

const LEVELS = ['DEBUG', 'INFO', 'AUDIT', 'WARN', 'ERROR'];
const looksBad = s => /\b(fail|failed|error|could not|refused|rate limit|invalid|denied|mismatch|drift)/i.test(s);

function createLogger({ dir, retentionDays = 90, host = os.hostname(), version = '', now = () => Date.now(), echo = true,
  out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n') } = {}) {
  let lastPrune = '';
  function fileFor(date) { return path.join(dir, `og-${date}.log`); }
  function prune(today) {
    if (lastPrune === today || !(retentionDays > 0)) return;
    lastPrune = today;
    try {
      const cutoff = istParts(now() - retentionDays * 86400000).date;
      for (const f of fs.readdirSync(dir)) { const m = /^og-(\d{4}-\d{2}-\d{2})\.log$/.exec(f); if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f)); }
    } catch (_) { /* pruning is best effort */ }
  }

  /** Write one entry. lvl: DEBUG|INFO|AUDIT|WARN|ERROR; cat: gateway|order|switch|login|network|journal|clock|security … */
  function write(lvl, cat, event, msg, extra = {}) {
    const t = now(), p = istParts(t);
    const entry = { ts: istStamp(t), utc: new Date(t).toISOString(), lvl: LEVELS.includes(lvl) ? lvl : 'INFO', host, v: version, cat: cat || 'gateway',
      event: event || 'message', ...(extra.symbol ? { symbol: extra.symbol } : {}), ...(extra.intent ? { intent: extra.intent } : {}),
      msg: redactText(msg || ''), ...(extra.detail !== undefined ? { detail: redact(extra.detail) } : {}) };
    const line = JSON.stringify(entry);
    if (dir) {
      try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(fileFor(p.date), line + '\n'); prune(p.date); }
      catch (e) { if (echo) err(`[${p.date} ${p.time} IST] ERROR log file could not be written: ${e.message}`); }
    }
    if (echo) {
      const short = `[${p.date} ${p.time} IST] ${entry.lvl} ${entry.cat} ${entry.event}${entry.symbol ? ' ' + entry.symbol : ''}${entry.msg ? ' – ' + entry.msg : ''}`
        + (entry.detail !== undefined ? ' ' + JSON.stringify(entry.detail).slice(0, 300) : '');
      (entry.lvl === 'ERROR' || entry.lvl === 'WARN' ? err : out)(short);
    }
    return entry;
  }

  /** Old call style: log('[og] heartbeat failed:', 'message') or log('[og] audit write failed', '{"error":"…"}'). */
  function log(...args) {
    const head = String(args[0] ?? '').replace(/^\[og\]\s*/, '');
    let detail, rest = args.slice(1);
    if (rest.length === 1 && typeof rest[0] === 'string' && /^[{[]/.test(rest[0])) { try { detail = JSON.parse(rest[0]); rest = []; } catch (_) { /* keep as text */ } }
    else if (rest.length === 1 && rest[0] && typeof rest[0] === 'object') { detail = rest[0]; rest = []; }
    const msg = [head, ...rest.map(x => typeof x === 'string' ? x : JSON.stringify(x))].join(' ').trim();
    const bad = looksBad(msg) || (detail && looksBad(JSON.stringify(detail)));
    const event = (/^[a-z][a-z0-9_ ]{1,40}$/i.exec(head.replace(/[:.]+$/, '')) || [''])[0].trim().replace(/\s+/g, '_').toLowerCase() || 'message';
    return write(bad ? 'WARN' : 'INFO', detail && (detail.symbol || detail.intent) ? 'order' : 'gateway', event, msg,
      { detail, symbol: detail && detail.symbol, intent: detail && (detail.intent || detail.intentId) });
  }
  log.write = write;
  log.info = (cat, event, msg, extra) => write('INFO', cat, event, msg, extra);
  log.audit = (cat, event, msg, extra) => write('AUDIT', cat, event, msg, extra);
  log.warn = (cat, event, msg, extra) => write('WARN', cat, event, msg, extra);
  log.error = (cat, event, msg, extra) => write('ERROR', cat, event, msg, extra);
  /** Log files, newest first: [{ name, date, bytes }]. */
  log.files = () => { try { return fs.readdirSync(dir).filter(f => /^og-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().reverse().map(name => ({ name, date: name.slice(3, 13), bytes: fs.statSync(path.join(dir, name)).size })); } catch (_) { return []; } };
  /** Full path of one log file, or null. Only exact og-YYYY-MM-DD.log names are accepted. */
  log.pathOf = name => (/^og-\d{4}-\d{2}-\d{2}\.log$/.test(String(name)) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null);
  log.host = host;
  return log;
}

module.exports = { createLogger, istStamp, istParts, redact, redactText };
