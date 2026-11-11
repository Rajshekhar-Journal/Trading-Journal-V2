/**
 * engine/exec-watch.js — Telegram alerts about the Order Gateway, raised by the lifecycle engine.
 *
 * Runs once a minute in the backend runner (not on the gateway), so it still works when the
 * gateway machine is off. It only reads the journal database and sends alerts:
 *   outbox  alerts the gateway wrote with telegram_status = 'pending' (e.g. Emergency Exit) are sent
 *   EX-01   Order Gateway offline during market hours            (repeats every 30 min)
 *   EX-02   Kite login required, from 08:45 IST                  (repeats every 30 min)
 *   EX-03   Open position not protected by a stop GTT            (confirm mode; repeats every 60 min, or when the list changes)
 * Nothing here places, changes or cancels anything.
 */
(function (root) {
  const I = root.TLMIndicators;
  const RULE = Object.freeze({ GATEWAY: 'EX-01', LOGIN: 'EX-02', PROTECTION: 'EX-03' });
  const hhmm = iso => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' });

  function isTradingDay(now, settings) {
    const wd = I.istWeekday(now);
    if (wd === 0 || wd === 6) return false;
    const [y, m, d] = I.istDate(now).split('-');
    return !(settings?.marketHolidays || '').includes(`${d}-${m}-${y}`);
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
    if (x.mode === 'confirm' && market && online && loggedIn) {
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

  root.TLMExecWatch = { run, RULE, isTradingDay };
})(typeof globalThis !== 'undefined' ? globalThis : this);
