/**
 * og/lib/config.js — gateway configuration. Nothing is hardcoded: every broker, network and
 * journal detail is entered on the setup page and stored here (non-secret) or in the secret store.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  port: 8787,
  bindHosts: ['127.0.0.1'],          // add the LAN or VPN address on the setup page for remote login
  allowedHosts: [],                  // extra host names this page may be opened under (e.g. the VPN name)
  expectedStaticIp: '',              // blank = order sending stays off
  gttWritesEnabled: false,           // stop-GTT placement; also needs the static IP to match
  executeSec: 10,
  sellOrdersEnabled: false,          // exits (market sell) for intents you approve; also needs the static IP to match
  exitWindow: [556, 925],            // IST minutes 09:16–15:25
  fillWaitSec: 20,                   // wait this long for a sell to fill before cancelling it
  cancelWaitSec: 10,
  orderPollMs: 2000,
  emergencyExit: 'off',              // off | confirm (you approve) | auto. Needs exits switched on.
  gttFillGraceSec: 10,               // a triggered GTT's order may stay unfilled this long before it counts
  notTriggeredGraceSec: 60,          // price below the stop with the GTT still asleep for this long
  bookFills: true,                   // write completed sells into the journal trade
  bookGttFills: false,               // also book fills of the stop GTT itself (read only towards the broker)
  zerodhaClientId: '',
  kiteBaseUrl: 'https://api.kite.trade',
  kiteLoginUrl: 'https://kite.zerodha.com/connect/login',
  ipCheckUrl: 'https://api.ipify.org',
  supabaseUrl: '',
  journalEmail: '',
  heartbeatSec: 30,
  brokerSyncSec: 60,
  ipCheckSec: 600,
  sessionMinutes: 30,
});

/** Names kept in the encrypted secret store, never in config.json. */
const SECRET_NAMES = Object.freeze(['kiteApiKey', 'kiteApiSecret', 'kiteAccessToken', 'kiteTokenMeta',
  'supabaseAnonKey', 'journalRefreshToken', 'adminPasswordHash']);

function createConfig(dataDir) {
  const file = path.join(dataDir, 'config.json');
  function load() {
    let saved = {};
    if (fs.existsSync(file)) { try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { saved = {}; } }
    return { ...DEFAULTS, ...saved };
  }
  function save(patch) {
    const next = { ...load(), ...patch };
    for (const k of Object.keys(next)) if (!(k in DEFAULTS)) delete next[k];   // unknown keys are dropped
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    return next;
  }
  return { load, save, file };
}

function isIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || '').trim());
  return !!m && m.slice(1).every(o => Number(o) <= 255);
}

module.exports = { createConfig, DEFAULTS, SECRET_NAMES, isIPv4 };
