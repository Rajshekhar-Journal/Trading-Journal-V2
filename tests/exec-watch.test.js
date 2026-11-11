/**
 * Auto Trade Engine — gateway watch alerts raised by the backend runner (Telegram). Run with:  npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createMemoryClient } = require('./helpers/memory-supabase.js');

const G = globalThis;
const UID = 'u1';
const tables = {}; const client = createMemoryClient(tables);
G.TLM_HOST = 'server';
G.APP_CONFIG = { SUPABASE_URL: 'https://example.test' };
G.auth = { getClient: () => client, getUser: () => ({ id: UID }) };
G.CustomEvent = G.CustomEvent || class extends Event { constructor(n, o) { super(n); this.detail = o?.detail; } };
for (const f of ['calculations.js', 'db-cloud.js', 'engine/indicators.js', 'engine/tlm-rules.js', 'engine/tlm-engine.js', 'engine/chartbook.js', 'engine/market-data.js',
  'engine/alert-service.js', 'engine/executors.js', 'engine/guards.js', 'engine/order-planner.js', 'engine/exec-watch.js'])
  require(path.join(__dirname, '../js', f));
const W = G.TLMExecWatch;

const at = hhmm => Date.parse(`2026-11-11T${hhmm}:00+05:30`);          // a Wednesday
const iso = ms => new Date(ms).toISOString();
const sent = [];
G.TLMAlerts.setNotifier(async (text, settings) => { sent.push(text); return settings.telegramChatId ? 'sent' : 'skipped'; });
function seed({ mode = 'confirm', state, prot, alerts = [] } = {}) {
  for (const k of Object.keys(tables)) delete tables[k];
  Object.assign(tables, { alert_log: alerts.map(a => ({ user_id: UID, mode: 'real', ...a })), exec_state: state ? [{ user_id: UID, ...state }] : [],
    broker_snapshots: prot ? [{ user_id: UID, kind: 'protection', ...prot }] : [] });
  sent.length = 0;
  return { telegramChatId: '123', execution: { mode } };
}
const healthy = now => ({ heartbeat_at: iso(now - 20000), broker_connected: true, token_valid_until: iso(now + 3600e3) });
const rules = () => tables.alert_log.map(a => a.rule_id);

test('gateway offline in market hours → one Telegram alert, repeated only after 30 minutes; silent outside market hours and on holidays', async () => {
  let now = at('10:00');
  let s = seed({ state: { ...healthy(now), heartbeat_at: iso(now - 600000) } });
  assert.deepEqual((await W.run({ settings: s, now })).raised, ['EX-01']);
  assert.match(sent[0], /Order Gateway OFFLINE[\s\S]*last reported at 09:50 IST[\s\S]*Stop GTTs already at Zerodha stay active/);
  assert.deepEqual([tables.alert_log[0].symbol, tables.alert_log[0].telegram_status, tables.alert_log[0].mode], ['GATEWAY', 'sent', 'real']);
  assert.deepEqual((await W.run({ settings: s, now: now + 10 * 60000 })).raised, [], 'not again after 10 min');
  assert.deepEqual((await W.run({ settings: s, now: now + 31 * 60000 })).raised, ['EX-01'], 'again after 30 min');
  assert.equal(sent.length, 2);

  for (const t of ['08:50', '15:45']) { s = seed({ state: { heartbeat_at: iso(at(t) - 600000) } }); assert.deepEqual((await W.run({ settings: s, now: at(t) })).raised, [], t); }
  s = seed({ state: { heartbeat_at: iso(now - 600000) } }); s.marketHolidays = '11-11-2026';
  assert.deepEqual((await W.run({ settings: s, now })).raised, [], 'holiday');
  s = seed({ state: { heartbeat_at: iso(now - 600000) } });
  assert.deepEqual((await W.run({ settings: s, now: Date.parse('2026-11-14T10:00:00+05:30') })).raised, [], 'Saturday');
});

test('nothing is raised when the Auto Trade Engine is not in use (mode alert, or the gateway never ran)', async () => {
  const now = at('10:00');
  let s = seed({ mode: 'alert', state: { heartbeat_at: iso(now - 600000) } });
  assert.deepEqual((await W.run({ settings: s, now })).raised, []);
  s = seed({ mode: 'confirm' });
  assert.deepEqual((await W.run({ settings: s, now })).raised, []);
  assert.equal(sent.length, 0);
});

test('Kite login required: from 08:45, only when the gateway is online and not logged in', async () => {
  let s = seed({ state: { ...healthy(at('08:40')), broker_connected: false } });
  assert.deepEqual((await W.run({ settings: s, now: at('08:40') })).raised, [], 'too early');
  s = seed({ state: { heartbeat_at: iso(at('08:46') - 20000), broker_connected: false } });
  assert.deepEqual((await W.run({ settings: s, now: at('08:46') })).raised, ['EX-02']);
  assert.match(sent[0], /Kite login required[\s\S]*Log in to Kite/);
  s = seed({ state: { heartbeat_at: iso(at('09:30') - 20000), broker_connected: true, token_valid_until: iso(at('09:30') - 1000) } });
  assert.deepEqual((await W.run({ settings: s, now: at('09:30') })).raised, ['EX-02'], 'expired token counts as not logged in');
  s = seed({ state: healthy(at('09:30')) });
  assert.deepEqual((await W.run({ settings: s, now: at('09:30') })).raised, []);
});

test('position not protected: confirm mode only, fresh report only, repeats hourly or when the list changes', async () => {
  const now = at('11:00');
  const data = [{ symbol: 'INFY', state: 'PROTECTED', reason: 'ok' }, { symbol: 'TCS', state: 'UNPROTECTED', reason: 'No active stop GTT at the broker.' }];
  let s = seed({ state: healthy(now), prot: { data, taken_at: iso(now - 60000) } });
  assert.deepEqual((await W.run({ settings: s, now })).raised, ['EX-03']);
  assert.match(sent[0], /Position NOT protected[\s\S]*TCS — UNPROTECTED: No active stop GTT/);
  assert.ok(!/INFY/.test(sent[0]));
  tables.exec_state[0] = { user_id: UID, ...healthy(now + 20 * 60000) };
  tables.alert_log.length = 0;
  assert.deepEqual((await W.run({ settings: s, now: now + 20 * 60000 })).raised, [], 'a report older than 5 minutes is not trusted → no alert from it');
  tables.broker_snapshots[0].taken_at = iso(now + 20 * 60000);
  assert.deepEqual((await W.run({ settings: s, now: now + 20 * 60000 })).raised, ['EX-03']);
  assert.deepEqual((await W.run({ settings: s, now: now + 20 * 60000 })).raised, [], 'same list within the hour → quiet');
  tables.broker_snapshots[0].data = [...data, { symbol: 'SBIN', state: 'PARTIAL', reason: 'GTT covers 4 of 10 shares.' }];
  assert.deepEqual((await W.run({ settings: s, now: now + 21 * 60000 })).raised, ['EX-03'], 'list changed → alert');

  s = seed({ mode: 'shadow', state: healthy(now), prot: { data, taken_at: iso(now - 60000) } });
  assert.deepEqual((await W.run({ settings: s, now })).raised, [], 'shadow mode: not nagged about GTTs');
  s = seed({ state: healthy(now), prot: { data: [data[0]], taken_at: iso(now - 60000) } });
  assert.deepEqual((await W.run({ settings: s, now })).raised, []);
});

test('outbox: alerts the gateway queued are sent once; old ones are marked skipped; works even in alert mode', async () => {
  const now = at('10:00');
  const s = seed({ mode: 'alert', alerts: [
    { id: 'a1', symbol: 'INFY', rule_id: 'LC-09', alert_type: 'EMERGENCY EXIT needed', message: 'Alert type : EMERGENCY EXIT needed · INFY · REAL', telegram_status: 'pending', created_at: iso(now - 30000) },
    { id: 'a2', symbol: 'TCS', rule_id: 'LC-09', alert_type: 'EMERGENCY EXIT needed', message: 'old', telegram_status: 'pending', created_at: iso(now - 45 * 60000) },
    { id: 'a3', symbol: 'SBIN', rule_id: 'LC-01', alert_type: 'x', message: 'already', telegram_status: 'sent', created_at: iso(now - 30000) }] });
  assert.equal((await W.run({ settings: s, now })).outbox, 1);
  assert.deepEqual(sent, ['Alert type : EMERGENCY EXIT needed · INFY · REAL']);
  assert.deepEqual(tables.alert_log.map(a => a.telegram_status), ['sent', 'skipped', 'sent']);
  assert.equal((await W.run({ settings: s, now: now + 60000 })).outbox, 0);
  assert.equal(sent.length, 1);
});
