/**
 * og/lib/pages.js — HTML for the gateway setup pages. Secrets are never rendered, only masked.
 */
'use strict';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} — Order Gateway</title>
<style>
:root{color-scheme:light dark;--b:#d0d7de;--m:#57606a;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--b);padding-bottom:4px}
.sub{color:var(--m);margin:0 0 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.tile{border:1px solid var(--b);border-radius:8px;padding:10px}.tile b{display:block;font-size:12px;color:var(--m);font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
label{display:block;font-size:13px;color:var(--m);margin:10px 0 2px}
input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--b);border-radius:6px;font:inherit}
button{margin-top:12px;padding:7px 14px;border:1px solid var(--b);border-radius:6px;font:inherit;cursor:pointer}
button.p{background:#0969da;color:#fff;border-color:#0969da}.msg{padding:9px 12px;border-radius:6px;border:1px solid var(--b);margin:12px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}form.inline{display:inline}small{color:var(--m)}
</style></head><body>${body}</body></html>`;

const msgBox = m => m ? `<div class="msg ${esc(m.type || '')}">${esc(m.text)}</div>` : '';

function setupPasswordPage(m) {
  return shell('First-time setup', `<h1>Order Gateway — first-time setup</h1>
<p class="sub">Choose the gateway password. This page works only on this machine.</p>${msgBox(m)}
<form method="post" action="/setup-password"><label>New password (12 characters or more)</label>
<input type="password" name="password" minlength="12" required autocomplete="new-password">
<label>Repeat password</label><input type="password" name="password2" minlength="12" required autocomplete="new-password">
<button class="p">Set password</button></form>`);
}

function loginPage(m) {
  return shell('Sign in', `<h1>Order Gateway</h1><p class="sub">Sign in to manage the broker connection.</p>${msgBox(m)}
<form method="post" action="/login"><label>Gateway password</label>
<input type="password" name="password" required autocomplete="current-password" autofocus><button class="p">Sign in</button></form>`);
}

function tile(label, text, cls) { return `<div class="tile"><b>${esc(label)}</b><span class="${cls || ''}">${esc(text)}</span></div>`; }

function dashboardPage({ csrf, cfg, view, m }) {
  const c = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const ipText = { match: 'Matches', mismatch: 'Does not match', not_configured: 'Not set yet', lookup_failed: 'Could not check', expected_ip_invalid: 'Invalid value', not_checked: 'Not checked yet' }[view.ipStatus] || view.ipStatus;
  return shell('Status', `<div class="row" style="justify-content:space-between"><div><h1>Order Gateway</h1>
<p class="sub">${esc(view.version)} · Reads the broker. Places stop GTTs and exit sells only when switched on below, and only for intents you approve. Cannot place buy orders.</p></div>
<form class="inline" method="post" action="/logout">${c}<button>Sign out</button></form></div>${msgBox(m)}

<h2>Status</h2><div class="grid">
${tile('Kite API details', view.kiteConfigured ? 'Saved' : 'Not entered', view.kiteConfigured ? 'ok' : 'warn')}
${tile('Kite login today', view.brokerConnected ? `Connected until ${view.tokenValidUntil}` : 'Login required', view.brokerConnected ? 'ok' : 'warn')}
${tile('Static IP', ipText, view.ipStatus === 'match' ? 'ok' : (view.ipStatus === 'mismatch' ? 'bad' : 'warn'))}
${tile('Journal account', view.journalLinked ? 'Linked' : 'Not linked', view.journalLinked ? 'ok' : 'warn')}
${tile('Last broker sync', view.lastSync || 'Never', view.lastSyncError ? 'bad' : '')}
${tile('Open differences', view.lastSync ? String(view.driftCount) : '—', view.driftHigh ? 'bad' : '')}
${tile('Stop-GTT placement', view.orderSending ? 'ON — approved intents only' : (view.gttWritesEnabled ? 'Switched on, waiting for IP match / login' : 'Off'), view.orderSending ? 'ok' : 'warn')}
${tile('Exits (market sell)', view.sellSending ? 'ON — approved intents only' : (view.sellOrdersEnabled ? 'Switched on, waiting for IP match / login' : 'Off'), view.sellSending ? 'ok' : 'warn')}
${tile('Emergency Exit', view.sellSending ? ({ off: 'Off', confirm: 'On — asks you first', auto: 'On — automatic' }[view.emergencyExit] || 'Off') : 'Off', view.sellSending && view.emergencyExit !== 'off' ? 'ok' : 'warn')}
</div>${view.lastSyncError ? `<div class="msg bad">Last sync error: ${esc(view.lastSyncError)}</div>` : ''}

<h2>Daily Kite login</h2>
<div class="row"><form class="inline" method="get" action="/kite/login"><button class="p" ${view.kiteConfigured ? '' : 'disabled'}>Log in to Kite</button></form>
<form class="inline" method="post" action="/sync-now">${c}<button ${view.brokerConnected && view.journalLinked ? '' : 'disabled'}>Sync now</button></form></div>
<form method="post" action="/kite/token">${c}<label>If the redirect does not come back here, paste the address Kite sent you to (or just the request_token)</label>
<input name="pasted" autocomplete="off" placeholder="https://…?request_token=…"><button>Complete login</button></form>

<h2>Sending to Zerodha</h2><form method="post" action="/execution">${c}
<p class="sub" style="margin:0">Both need the static IP to match and today's Kite login, and act only on intents you approve in the journal (Settings → Auto Trade – Broker Link). The gateway never places buy orders.</p>
<label style="display:flex;gap:8px;align-items:center;color:inherit;font-size:15px"><input type="checkbox" name="gttWritesEnabled" style="width:auto" ${view.gttWritesEnabled ? 'checked' : ''}> Allow stop-GTT placement (place / modify the stop-loss GTT)</label>
<label style="display:flex;gap:8px;align-items:center;color:inherit;font-size:15px"><input type="checkbox" name="sellOrdersEnabled" style="width:auto" ${view.sellOrdersEnabled ? 'checked' : ''}> Allow exits (market sell of shares you hold, for approved partial and full exits)</label>
<label style="display:flex;gap:8px;align-items:center;color:inherit;font-size:15px"><input type="checkbox" name="bookGttFills" style="width:auto" ${view.bookGttFills ? 'checked' : ''}> Book stop-GTT fills into the journal automatically (needs no static IP; nothing is sent to Zerodha)</label>
<label>Emergency Exit — when a stop GTT triggers but its order does not fill (or is rejected), cancel it, confirm, and sell at market: automatic protection, then 5%, then 10%</label>
<select name="emergencyExit" style="width:100%;padding:7px 9px;border:1px solid var(--b);border-radius:6px;font:inherit">
<option value="off" ${view.emergencyExit === 'off' ? 'selected' : ''}>Off — only report it</option>
<option value="confirm" ${view.emergencyExit === 'confirm' ? 'selected' : ''}>Confirm — propose it in the journal and wait for my approval</option>
<option value="auto" ${view.emergencyExit === 'auto' ? 'selected' : ''}>Auto — run it at once (a GTT that has not triggered always waits for approval)</option>
</select>
<button>Save</button></form>

<h2>Kite Connect API details</h2><form method="post" action="/secrets/kite" autocomplete="off">${c}
<label>API key ${view.kiteApiKeyMasked ? `<small>(saved: ${esc(view.kiteApiKeyMasked)})</small>` : ''}</label><input name="apiKey" autocomplete="off">
<label>API secret ${view.kiteConfigured ? '<small>(saved — leave blank to keep)</small>' : ''}</label><input type="password" name="apiSecret" autocomplete="new-password">
<label>Zerodha client ID (logins from any other account are refused)</label><input name="zerodhaClientId" value="${esc(cfg.zerodhaClientId)}" autocomplete="off">
<button>Save API details</button></form>
<small>Redirect URL to register in the Kite developer console: <code>${esc(view.callbackUrl)}</code></small>

<h2>Network</h2><form method="post" action="/config">${c}
<label>Static IP registered with Zerodha (leave blank until you have one)</label><input name="expectedStaticIp" value="${esc(cfg.expectedStaticIp)}" placeholder="e.g. 203.0.113.10">
<label>Addresses this page listens on (comma separated). 127.0.0.1 = this machine only; add the home-network or VPN address for remote login.</label>
<input name="bindHosts" value="${esc(cfg.bindHosts.join(', '))}">
<label>Extra host names this page may be opened under (comma separated, e.g. the VPN name)</label><input name="allowedHosts" value="${esc(cfg.allowedHosts.join(', '))}">
<label>Port</label><input name="port" value="${esc(cfg.port)}">
<button>Save network settings</button> <small>Listening changes apply after a restart.</small></form>

<h2>Journal account</h2><form method="post" action="/secrets/journal" autocomplete="off">${c}
<label>Supabase project URL</label><input name="supabaseUrl" value="${esc(cfg.supabaseUrl)}" placeholder="https://xxxx.supabase.co">
<label>Supabase anon (public) key ${view.anonKeySaved ? '<small>(saved — leave blank to keep)</small>' : ''}</label><input name="supabaseAnonKey" autocomplete="off">
<label>Journal login email</label><input name="journalEmail" value="${esc(cfg.journalEmail)}" autocomplete="off">
<label>Journal password <small>(used once to link; not stored)</small></label><input type="password" name="journalPassword" autocomplete="new-password">
<button>Link journal account</button></form>

<h2>Gateway password</h2><form method="post" action="/change-password">${c}
<label>Current password</label><input type="password" name="current" autocomplete="current-password">
<label>New password (12 characters or more)</label><input type="password" name="password" minlength="12" autocomplete="new-password">
<button>Change password</button></form>`);
}

module.exports = { setupPasswordPage, loginPage, dashboardPage, esc };
