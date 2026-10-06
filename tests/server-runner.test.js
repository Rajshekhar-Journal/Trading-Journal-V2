/**
 * Backend rule runner tests — run with:  npm test
 *  1. The Edge Function's engine copies match the browser files (no drift).
 *  2. The shared files load as strict ES modules (how Deno runs them).
 *  3. A full server cycle with an in-memory database: watchlist entry → real alert sent through the
 *     notifier + paper trade booked, legacy real trade gets a lifecycle state, other users untouched,
 *     no duplicate alerts on the next cycle.
 *  4. Browser mode: defers to a live server, asks it to run on Sync, and falls back when it is stale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMemoryClient } = require('./helpers/memory-supabase.js');

const ROOT = path.join(__dirname, '..');
const SHARED_DIR = path.join(ROOT, 'supabase/functions/_shared/engine');
const ORDER = ['calculations.js', 'db-cloud.js', 'indicators.js', 'tlm-rules.js', 'tlm-engine.js', 'chartbook.js',
  'market-data.js', 'alert-service.js', 'executors.js', 'runner.js'];
const sourceOf = f => fs.existsSync(path.join(ROOT, 'js', f)) ? path.join(ROOT, 'js', f) : path.join(ROOT, 'js/engine', f);

test('Edge Function engine copies are identical to the browser files (run: npm run sync-engine)', () => {
  for (const f of ORDER) {
    const copy = path.join(SHARED_DIR, f);
    assert.ok(fs.existsSync(copy), `${f} missing in ${SHARED_DIR}`);
    assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(sourceOf(f))), `${f} differs — run npm run sync-engine`);
  }
});

// ── Load the shared files the way Deno does: as strict ES modules, in order ──
const G = globalThis;
const UID = 'u1';
let tables, client;
let currentUid = UID;
const sent = [];

async function loadAsModules() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlm-esm-'));
  for (const f of ORDER) {
    const dest = path.join(tmp, f.replace(/\.js$/, '.mjs'));
    fs.copyFileSync(path.join(SHARED_DIR, f), dest);
    await import(pathToFileURL(dest).href);
  }
}

const DAY_MS = 864e5;
function yahoo(candles, ltp) {
  return { meta: { regularMarketPrice: ltp }, timestamp: candles.map(c => c.time),
    indicators: { quote: [{ open: candles.map(c => c.open), high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close) }] } };
}
function marketSource(prices) {
  return async (tk, interval) => {
    const sym = tk.replace(/\.(NS|BO)$/, '');
    const px = prices[sym] ?? 100;
    if (interval === '1d') {
      const out = [];
      for (let i = 60; i >= 1; i--) { const t = Math.floor((Date.now() - i * DAY_MS) / 1000); out.push({ time: t, open: px - 2, high: px - 1, low: px - 3, close: px - 2 }); }
      return yahoo(out, px);
    }
    const lastStart = Math.floor(Date.now() / 60000) * 60 - 60;
    const out = [];
    for (let i = 9; i >= 0; i--) out.push({ time: lastStart - i * 60, open: px, high: px, low: px, close: px });
    return yahoo(out, px);
  };
}

test('strict-ESM load + one full server cycle', async (t) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  tables = {
    settings: [{ user_id: UID, data: { telegramChatId: '123', rMode: 'fixed', fixedR: 10000 } }, { user_id: 'u2', data: {} }],
    trades: [{ id: 'tr1', user_id: UID, symbol: 'REAL1', direction: 'Long', trade_type: 'Equity', exchange: 'NSE',
      initial_stop: 95, current_stop: 95, cmp: 100, entries: [{ id: 'en1', date: today, price: 100, qty: 100, charges: 0 }],
      pyramids: [], partial_exits: [], final_exit: null, stop_revisions: [], alerts: [], notes: [], tags: [], created_at: new Date().toISOString() }],
    paper_trades: [], capital: [{ id: 'c1', user_id: UID, date: '2026-01-01', type: 'Deposit', amount: 1000000, running_balance: 1000000 }],
    watchlist: [
      { id: 'wl1', user_id: UID, symbol: 'WATCH1', trigger_price: 100, stop_loss: 95, status: 'monitoring', mode: 'both', created_at: new Date().toISOString() },
      { id: 'wl2', user_id: 'u2', symbol: 'OTHER', trigger_price: 100, stop_loss: 95, status: 'monitoring', mode: 'both', created_at: new Date().toISOString() },
    ],
    alert_log: [], trade_snapshots: [], runner_status: [{ id: 'tlm-runner' }],
  };
  client = createMemoryClient(tables);
  G.TLM_HOST = 'server';
  G.auth = { getClient: () => client, getUser: () => (currentUid ? { id: currentUid } : null) };
  G.CustomEvent = G.CustomEvent || class extends Event { constructor(n, o) { super(n); this.detail = o?.detail; } };
  await loadAsModules();
  assert.ok(G.TLMRunner && G.db && G.calc, 'globals published by the shared files');

  G.TLMMarketData.setSource(marketSource({ WATCH1: 101, REAL1: 101, OTHER: 101 }));
  G.TLMAlerts.setNotifier(async (text, settings) => { sent.push({ text, chat: settings.telegramChatId }); return 'sent'; });

  const ran = await G.TLMRunner.runCycle({ force: true });
  assert.equal(ran, true);
  assert.deepEqual(G.TLMRunner.lastErrors(), []);

  const real = tables.alert_log.filter(a => a.mode === 'real');
  const paper = tables.alert_log.filter(a => a.mode === 'paper');
  assert.ok(real.some(a => a.symbol === 'WATCH1' && a.rule_id && a.telegram_status === 'sent'), 'real entry alert sent');
  assert.ok(paper.some(a => a.symbol === 'WATCH1' && a.status === 'Executed'), 'paper entry executed');
  assert.ok(sent.length >= 1 && sent.every(s => s.chat === '123'));
  assert.equal(tables.paper_trades.length, 1);
  assert.equal(tables.paper_trades[0].user_id, UID);
  assert.equal(tables.watchlist.find(w => w.id === 'wl1').status, 'triggered');
  assert.ok(tables.trades[0].tlm_state, 'legacy trade received a lifecycle state');
  assert.ok(tables.alert_log.every(a => a.user_id === UID), 'alerts written for this user only');
  assert.equal(tables.watchlist.find(w => w.id === 'wl2').status, 'monitoring', 'other user untouched');

  const before = tables.alert_log.length;
  await G.TLMRunner.runCycle({ force: true });
  assert.equal(tables.alert_log.length, before, 'no duplicate alerts on the next cycle (AL-01)');

  await t.test('browser mode: defers to a live server, hands Sync to it, falls back when stale', async () => {
    G.TLM_HOST = undefined;
    G.TLMAlerts.setNotifier(null);                       // browsers never hold the bot token
    G.APP_CONFIG = { SUPABASE_URL: 'https://example.supabase.co' };
    const calls = [];
    G.fetch = async (url, init) => { calls.push({ url, body: init?.body }); return { ok: true, json: async () => ({ ran: true }) }; };

    tables.runner_status[0].last_finished_at = new Date().toISOString();
    assert.equal(await G.TLMRunner.runCycle(), false, 'live server → browser does nothing');
    assert.equal(G.TLMRunner.host(), 'server');
    assert.equal(await G.TLMRunner.runCycle({ force: true }), true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /functions\/v1\/tlm-runner$/);
    assert.equal(JSON.parse(calls[0].body).action, 'run');

    tables.runner_status[0].last_finished_at = new Date(Date.now() - 10 * 60000).toISOString();
    tables.watchlist.push({ id: 'wl3', user_id: UID, symbol: 'WATCH3', trigger_price: 100, stop_loss: 95, status: 'monitoring', mode: 'real', created_at: new Date().toISOString() });
    G.TLMMarketData.setSource(marketSource({ WATCH1: 101, REAL1: 101, WATCH3: 101 }));
    assert.equal(await G.TLMRunner.runCycle({ force: true }), true, 'stale server → browser runs the cycle');
    assert.equal(G.TLMRunner.host(), 'browser');
    const w3 = tables.alert_log.find(a => a.symbol === 'WATCH3');
    assert.ok(w3, 'browser cycle produced the alert');
    assert.equal(w3.telegram_status, 'skipped', 'no Telegram from the browser');
    assert.equal(tables.runner_status[0].locked_by, null, 'browser released the lock');

    tables.runner_status[0].locked_by = 'server';
    tables.runner_status[0].locked_until = new Date(Date.now() + 60000).toISOString();
    assert.equal(await G.TLMRunner.runCycle({ force: true }), false, 'server holds the lock → browser skips');
  });
});
