/**
 * engine/exec-watch.js — Telegram alerts about the Order Gateway, raised by the lifecycle engine.
 *
 * Runs once a minute in the backend runner (not on the gateway), so it still works when the
 * gateway machine is off. It only reads the journal database and sends alerts:
 *   outbox  alerts the gateway wrote with telegram_status = 'pending' (e.g. Emergency Exit) are sent
 *   EX-01   Order Gateway offline during market hours            (repeats every 30 min)
 *   EX-02   Kite login required, from 08:45 IST                  (repeats every 30 min)
 *   EX-03   Open position not protected by a stop GTT            (confirm / auto modes; repeats every 60 min, or when the list changes)
 *   EX-04   Price data stale for an open position in market hours (repeats every 30 min)
 *   TG      Telegram approvals: each waiting proposal is sent once with Approve / Reject buttons (settings.execution.telegramApprovals);
 *           the outcome of every proposal sent this way follows as a second message.
 * Nothing here places, changes or cancels anything.
 */
(function (root) {
  const I = root.TLMIndicators;
  const RULE = Object.freeze({ GATEWAY: 'EX-01', LOGIN: 'EX-02', PROTECTION: 'EX-03', STALE: 'EX-04' });
  const hhmm = iso => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });

  function isTradingDay(now, settings) {
    const wd = I.istWeekday(now);
    if (wd === 0 || wd === 6) return false;
    const [y, m, d] = I.istDate(now).split('-');
    return !(settings?.marketHolidays || '').includes(`${d}-${m}-${y}`);
  }

  // Ports set by the backend runner (they hold the bot token). Without them nothing is sent from here.
  let _sendProposal = null;   // (chatId, text, intentId) → message_id | null   (message carries Approve / Reject buttons)
  const setProposalSender = fn => { _sendProposal = fn; };
  const inr = v => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function orderText(i) {
    switch (i.action) {
      case 'ENTRY': case 'ADD': return `Buy ${i.qty} · limit ${inr(i.limit_price)} (IOC) · stop ${inr(i.stop_price)}`;
      case 'STOP_ENSURE': return `Stop GTT for ${i.qty} shares · trigger ${inr(i.trigger_price)} · limit ${inr(i.gtt_limit_price)}`;
      case 'EXIT_PARTIAL': return `Sell ${i.qty} at market (partial)`;
      case 'EXIT_ALL': return `Sell all ${i.qty} at market`;
      case 'EMERGENCY_EXIT': return `EMERGENCY EXIT: sell ${i.qty} (limit 1% below the price)`;
      default: return `${i.action} ${i.qty || ''}`;
    }
  }
  function resultText(i) {
    const r = i.result || {}, sym = i.symbol;
    if (i.status === 'done') {
      if (i.action === 'STOP_ENSURE') return `✅ ${sym}: stop GTT ${r.verb === 'modify' ? 'changed' : r.note ? 'already in place' : 'placed'} — ${i.qty} shares at ${inr(i.trigger_price)}.`;
      if (i.action === 'ENTRY' || i.action === 'ADD') return `✅ ${sym}: bought ${r.filled} @ ${inr(r.averagePrice)}${r.note ? ' (' + r.note + ')' : ''}.`;
      return `✅ ${sym}: sold ${r.filled} @ ${inr(r.averagePrice)}.`;
    }
    if (i.status === 'failed') return `❌ ${sym}: not done — ${r.reason || 'no reason given'}${Number(r.filled) > 0 ? ` (${r.filled} filled)` : ''}.`;
    if (i.status === 'expired') return `⌛ ${sym}: expired — nothing was sent.`;
    if (i.status === 'rejected') return `✖ ${sym}: rejected — nothing was sent.`;
    return null;
  }

  /** Waiting proposals → Telegram with buttons (once each); finished ones → their outcome (once each). */
  async function telegramApprovals({ settings, x, now, alerts }) {
    const out = { sent: 0, results: 0 };
    if (!_sendProposal || !settings?.telegramChatId || !x.telegramApprovals) return out;
    const since = new Date(now - 36 * 3600000).toISOString();
    const [intents, notices] = await Promise.all([db.getOrderIntents({ since, limit: 500 }), db.getTgNotices({ since })]);
    const noticed = new Map(notices.map(n => [n.intent_id, n]));
    const autoMode = x.mode === 'auto_sell' || x.mode === 'auto_full';
    for (const i of intents) {
      if (i.mode !== 'confirm' || i.status !== 'proposed' || noticed.has(i.id) || i.action === 'TEST_APPROVAL') continue;
      if (i.expires_at && Date.parse(i.expires_at) < now) continue;
      if (autoMode && i.detail && i.detail.autoEligible) continue;                 // the gateway approves these itself
      const al = i.alert_id ? alerts.find(a => a.id === i.alert_id) : null;
      const reason = (al && al.suggestion && al.suggestion.reason) || (i.detail && (i.detail.reason || i.detail.source || i.detail.note)) || '';
      const text = `🔔 APPROVE? ${i.symbol} · ${i.rule_id || i.action}\n${orderText(i)}${reason ? '\nReason: ' + reason : ''}`
        + (i.block_reasons && i.block_reasons.length ? `\nWarnings: ${i.block_reasons.join('; ')}` : '')
        + `\nExpires ${hhmm(i.expires_at)} IST. The gateway re-checks everything before sending.`;
      const messageId = await _sendProposal(settings.telegramChatId, text, i.id).catch(() => null);
      if (!messageId) continue;
      await db.insertTgNotice({ intent_id: i.id, chat_id: String(settings.telegramChatId), message_id: messageId });
      out.sent++;
    }
    const byId = new Map(intents.map(i => [i.id, i]));
    for (const n of notices) {
      if (n.result_sent_at) continue;
      const i = byId.get(n.intent_id);
      const text = i && resultText(i);
      if (!text) continue;
      const s = await root.TLMAlerts.notify(settings, text);
      if (s === 'sent' || s === 'skipped') { await db.updateTgNotice(n.id, { result_sent_at: new Date(now).toISOString() }); out.results++; }
    }
    return out;
  }

  /** @returns { outbox, raised: [ruleId] } */
  async function run({ settings, now = Date.now() }) {
    const out = { outbox: 0, raised: [] };
    const x = root.TLMOrders.execParams(settings);
    const dayStart = new Date(Date.parse(I.istDate(now) + 'T00:00:00+05:30')).toISOString();
    const alerts = await db.getAlerts({ since: dayStart, limit: 500 });

    // Outbox: the gateway cannot send Telegram itself; it leaves real alerts here marked 'pending'.
    for (const a of alerts.filter(a => a.mode === 'real' && a.telegram_status === 'pending')) {
      const fresh = now - Date.parse(a.created_at) <= 30 * 60000;
      const status = fresh ? await root.TLMAlerts.notify(settings, a.message || `${a.alert_type} · ${a.symbol}`) : 'skipped';
      await db.updateAlert(a.id, { telegram_status: status });
      a.telegram_status = status;
      if (status === 'sent') out.outbox++;
    }

    try { out.telegram = await telegramApprovals({ settings, x, now, alerts }); } catch (e) { out.telegramError = String(e.message || e); }

    if (x.mode === 'alert' || !isTradingDay(now, settings)) return out;       // gateway not in use, or market closed today
    const st = await db.getExecState();
    if (!st) return out;                                                       // the gateway has never been set up

    async function raise(rule, type, text, repeatMin, key = null) {
      const prior = alerts.filter(a => a.rule_id === rule);
      const last = prior.length ? prior.reduce((a, b) => (a.created_at > b.created_at ? a : b)) : null;
      if (last && (last.suggestion?.key ?? null) === key && now - Date.parse(last.created_at) < repeatMin * 60000) return;
      const message = `Alert type : ${type}\n${text}`;
      const telegram = await root.TLMAlerts.notify(settings, message);
      const row = await db.insertAlert({ trade_id: null, watchlist_id: null, mode: 'real', symbol: 'GATEWAY', rule_id: rule, alert_type: type, stage: null, cmp: null,
        suggestion: { kind: 'INFO', text: text.split('\n')[0], key }, message, status: 'New', telegram_status: telegram, created_at: new Date(now).toISOString() });
      alerts.push(row);
      out.raised.push(rule);
    }

    const minute = I.istMinutes(now);
    const beatAge = st.heartbeat_at ? (now - Date.parse(st.heartbeat_at)) / 1000 : Infinity;
    const online = beatAge <= x.gatewayStaleSec;
    const market = minute >= 555 && minute <= 930;                             // 09:15–15:30 IST
    const loggedIn = !!(st.broker_connected && st.token_valid_until && Date.parse(st.token_valid_until) > now);

    if (market && !online) {
      await raise(RULE.GATEWAY, 'Order Gateway OFFLINE',
        `The gateway last reported at ${st.heartbeat_at ? hhmm(st.heartbeat_at) : 'never'} IST.\nStop GTTs already at Zerodha stay active. Nothing else is being sent or checked: no exits, no Emergency Exit, no stop changes.\nStart it on the home machine: npm run og`, 30);
      return out;
    }
    if (online && !loggedIn && minute >= 525 && minute <= 930) {               // from 08:45 IST
      await raise(RULE.LOGIN, 'Kite login required',
        'Open the Order Gateway page and click "Log in to Kite".\nUntil then the broker is not read and nothing can be sent.', 30);
      return out;
    }
    // Price data stale (the engine-watched levels depend on it): from 09:20 to 15:28.
    const stale = (root.TLMRunner && root.TLMRunner.lastStale && root.TLMRunner.lastStale()) || [];
    if (stale.length && minute >= 560 && minute <= 928) {
      await raise(RULE.STALE, 'Price data stale',
        `No fresh 1-minute prices (newer than 5 min) for: ${stale.join(', ')}.\nTrails, profit-booking stops and EMA rules for these stocks are not being checked. The stop GTT at Zerodha still protects them.`, 30, stale.map(x => x.split(' ')[0]).sort().join(','));
    }
    if (root.TLMOrders.isConfirmLike(x.mode) && market && online && loggedIn) {
      const prot = await db.getBrokerSnapshot('protection');
      const fresh = prot && Array.isArray(prot.data) && now - Date.parse(prot.taken_at) < 300000;
      const bad = fresh ? prot.data.filter(p => p.state !== 'PROTECTED') : [];
      if (bad.length) {
        const key = bad.map(p => `${p.symbol}:${p.state}`).sort().join(',');
        await raise(RULE.PROTECTION, 'Position NOT protected',
          `${bad.length} open position${bad.length > 1 ? 's are' : ' is'} not fully covered by a stop GTT.\n` + bad.map(p => `${p.symbol} — ${p.state}: ${p.reason}`).join('\n')
          + '\nPropose and approve the stop GTT in Settings → Auto Trade – Broker Link, or place it on Kite.', 60, key);
      }
    }
    return out;
  }

  root.TLMExecWatch = { run, RULE, isTradingDay, setProposalSender, orderText, resultText };
})(typeof globalThis !== 'undefined' ? globalThis : this);
