/**
 * Order Gateway — log and audit trail: IST log files, secrets never logged, audit rows never lost,
 * machine name on every row, gateway-level events audited, clock check. Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeWorld } = require('./helpers/fake-kite.js');
const { createGateway } = require('../og/server.js');
const { createLogger, istStamp } = require('../og/lib/logger.js');
const { createAuditQueue } = require('../og/lib/audit-queue.js');
const { checkClock } = require('../og/lib/clock-check.js');

const IP = '203.0.113.10';
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const lines = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('log times are IST (UTC+05:30) and the file is named by the IST date', () => {
  const dir = tmp('ogl-');
  const t = Date.parse('2026-11-27T20:00:01.250Z');               // 01:30:01 IST on the 28th
  const log = createLogger({ dir, now: () => t, echo: false, host: 'TESTBOX', version: 'og-x' });
  log.info('gateway', 'ready', 'hello');
  assert.equal(istStamp(t), '2026-11-28 01:30:01.250 IST');
  const [e] = lines(path.join(dir, 'og-2026-11-28.log'));
  assert.equal(e.ts, '2026-11-28 01:30:01.250 IST');
  assert.equal(e.utc, '2026-11-27T20:00:01.250Z');
  assert.equal(e.host, 'TESTBOX'); assert.equal(e.v, 'og-x'); assert.equal(e.event, 'ready');
});

test('the terminal line carries the IST time; old-style calls still work and failures are WARN', () => {
  const out = [], dir = tmp('ogl-');
  const log = createLogger({ dir, now: () => Date.parse('2026-11-28T04:00:00Z'), out: s => out.push(s), err: s => out.push(s) });
  log('[og] heartbeat failed:', 'Request rate limit reached');
  assert.match(out[0], /^\[2026-11-28 09:30:00 IST\] WARN gateway heartbeat_failed/);
  const [e] = lines(path.join(dir, 'og-2026-11-28.log'));
  assert.equal(e.lvl, 'WARN');
});

test('tokens, keys and passwords never reach the log', () => {
  const dir = tmp('ogl-');
  const log = createLogger({ dir, echo: false });
  log.info('login', 'x', 'Authorization: Bearer abcdefghijkl12345 access_token=SECRET123456', { detail: { apiSecret: 'zzz999', accessToken: 'tok', nested: { password: 'pw12345' }, qty: 5 } });
  const text = fs.readFileSync(path.join(dir, log.files()[0].name), 'utf8');
  for (const s of ['abcdefghijkl12345', 'SECRET123456', 'zzz999', '"tok"', 'pw12345']) assert.ok(!text.includes(s), s);
  assert.ok(text.includes('"qty":5'));
});

test('log files older than the retention setting are removed; only og-YYYY-MM-DD.log names can be downloaded', () => {
  const dir = tmp('ogl-');
  fs.writeFileSync(path.join(dir, 'og-2020-01-01.log'), 'old\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep\n');
  const log = createLogger({ dir, retentionDays: 30, echo: false });
  log.info('gateway', 'x', 'y');
  assert.ok(!fs.existsSync(path.join(dir, 'og-2020-01-01.log')));
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
  assert.equal(log.pathOf('../config.json'), null);
  assert.equal(log.pathOf('notes.txt'), null);
  assert.ok(log.pathOf(log.files()[0].name));
});

test('audit rows that cannot reach the journal are kept locally and sent later, with the machine name', async () => {
  const file = path.join(tmp('ogq-'), 'audit-pending.jsonl');
  const q = createAuditQueue({ file, host: 'HP-LAPTOP', version: 'og-x', log: createLogger({ echo: false }) });
  const sent = []; let down = true;
  const raw = { userId: async () => 'u1', insert: async (t, rows) => { if (down) throw new Error('Journal database POST order_audit failed: 429 rate limit'); sent.push(...rows); } };
  const store = q.wrap(raw);
  await store.insert('order_audit', [{ id: 'a1', user_id: 'u1', intent_id: 'i1', event: 'done', detail: { qty: 5 } }]);   // does not throw
  assert.equal(q.pending(), 1);
  down = false;
  assert.deepEqual(await q.flush(raw), { sent: 1, left: 0 });
  assert.equal(q.pending(), 0);
  assert.equal(sent[0].detail.host, 'HP-LAPTOP'); assert.equal(sent[0].detail.og, 'og-x'); assert.equal(sent[0].detail.qty, 5);
  // a row the journal already has counts as sent
  q.enqueue([{ id: 'a2', user_id: null, intent_id: 'gateway', event: 'x', detail: {} }]);
  assert.deepEqual(await q.flush({ userId: async () => 'u1', insert: async () => { throw new Error('failed: 409 duplicate key'); } }), { sent: 1, left: 0 });
});

async function ready() {
  const w = createFakeWorld({ publicIp: IP });
  const dataDir = tmp('ogg-');
  const gw = createGateway({ dataDir, fetchImpl: w.fetch, log: createLogger({ dir: path.join(dataDir, 'logs'), echo: false, host: 'TESTBOX', version: 'og-t' }) });
  gw.config.save({ kiteBaseUrl: 'https://kite.test', kiteLoginUrl: 'https://kite.test/connect/login', ipCheckUrl: 'https://ip.test', supabaseUrl: 'https://sb.test',
    zerodhaClientId: w.clientId, expectedStaticIp: IP });
  gw.secrets.set('kiteApiKey', w.apiKey); gw.secrets.set('kiteApiSecret', w.apiSecret); gw.secrets.set('supabaseAnonKey', 'anon'); gw.secrets.set('journalRefreshToken', w.refreshToken);
  w.db.settings.push({ user_id: w.uid, data: { execution: { mode: 'confirm' } } });
  return { w, gw, dataDir };
}
const settle = () => new Promise(r => setTimeout(r, 30));

test('Kite login and the IP check are written to order_audit as gateway events, with the machine name', async () => {
  const { w, gw, dataDir } = await ready();
  await gw.completeKiteLogin('req1'); await gw.tickIp(); await settle();
  const ev = w.db.order_audit.filter(a => a.intent_id === 'gateway').map(a => a.event);
  assert.ok(ev.includes('kite_login'), ev.join());
  assert.ok(ev.includes('ip_match'), ev.join());
  const row = w.db.order_audit.find(a => a.event === 'kite_login');
  assert.equal(row.detail.host, 'TESTBOX'); assert.equal(row.user_id, w.uid);
  const logged = lines(path.join(dataDir, 'logs', gw.log.files()[0].name)).map(e => e.event);
  assert.ok(logged.includes('kite_login'));
  const text = fs.readFileSync(path.join(dataDir, 'logs', gw.log.files()[0].name), 'utf8');
  assert.ok(!text.includes(w.apiSecret) && !text.includes(w.apiKey));
});

test('a gateway event made while the journal is unreachable is kept and sent on the next heartbeat', async () => {
  const { w, gw } = await ready();
  await gw.completeKiteLogin('req1'); await settle();
  const real = w.fetch; let down = true;
  const flaky = async (u, init) => (down && String(u).includes('/rest/v1/order_audit') ? { ok: false, status: 503, text: async () => 'down', headers: { get: () => null } } : real(u, init));
  const gw2 = createGateway({ dataDir: tmp('ogg2-'), fetchImpl: (u, i) => flaky(u, i), log: createLogger({ echo: false }) });
  gw2.config.save({ supabaseUrl: 'https://sb.test', ipCheckUrl: 'https://ip.test' });
  gw2.secrets.set('supabaseAnonKey', 'anon'); gw2.secrets.set('journalRefreshToken', w.refreshToken);
  await gw2.gatewayEvent('test_event', 'gateway', 'while down');
  assert.equal(w.db.order_audit.filter(a => a.event === 'test_event').length, 0);
  down = false;
  await gw2.tickHeartbeat();
  assert.equal(w.db.order_audit.filter(a => a.event === 'test_event').length, 1);
});

test('clock check: offset from the server Date header, drift flagged past the setting', async () => {
  const at = Date.parse('2026-11-28T04:00:00Z');
  const fetchAt = serverMs => async () => ({ headers: { get: k => (k === 'date' ? new Date(serverMs).toUTCString() : null) } });
  const ok = await checkClock({ url: 'https://x', fetchImpl: fetchAt(at), now: () => at + 400, maxDriftSec: 30 });
  assert.equal(ok.ok, true); assert.equal(ok.offsetSec, 0);
  const ahead = await checkClock({ url: 'https://x', fetchImpl: fetchAt(at), now: () => at + 95000, maxDriftSec: 30 });
  assert.equal(ahead.ok, false); assert.equal(ahead.offsetSec, 95);
  const none = await checkClock({ url: 'https://x', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(none.ok, null);
});
