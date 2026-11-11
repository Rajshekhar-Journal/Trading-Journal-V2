/**
 * engine/order-planner.js — turns an engine action on a REAL trade into an order intent.
 *
 * PHASE 2 = SHADOW. An intent is what the Auto Trade Engine WOULD send to Zerodha. It is checked by
 * the guards and written to `order_intents`; nothing is sent to the broker and the journal's alerts,
 * lifecycle state and trades are not changed by this file.
 */
(function (root) {
  const I = root.TLMIndicators;
  const G = root.TLMGuards;
  const { RULES } = root.TLMRules;

  /** Execution settings. Stored under settings.execution; every value can be changed without code. */
  const EXEC_DEFAULTS = Object.freeze({
    mode: 'alert',                 // alert | shadow | confirm (confirm = stop GTTs, and exits if confirmExits; the rest stays shadow)
    confirmExpiryMin: 15,          // a proposed stop GTT waits this long for your approval
    confirmExits: false,           // in confirm mode, also propose partial and full exits for your approval
    killSwitch: false,
    entryBandPct: 0.5,             // entry limit = price + 0.5%
    addBandPct: 1,                 // add limit   = price + 1%
    maxGapUpPct: 3,                // no entry when price is > 3% above the trigger
    maxEntrySlipR: 0.25,           // … or > 0.25R above the trigger
    gttBufferPct: 1.5,             // GTT sell limit = stop − 1.5%
    maxOrderValue: 0,              // ₹ per order, 0 = not set
    maxOrdersPerDay: 30,
    fundsUtilisationPct: 98,
    dataMaxAgeSec: 90,             // quote age limit for entries/adds
    dataMaxAgeExitSec: 180,        // … for stops and exits
    gatewayStaleSec: 180,
    entryWindow: [560, 915],       // IST minutes: 09:20–15:15
    exitWindow: [556, 925],        //              09:16–15:25
    intentExpirySec: 90,
  });
  const execParams = settings => ({ ...EXEC_DEFAULTS, ...((settings && settings.execution) || {}) });

  const norm = s => String(s || '').toUpperCase().trim().replace(/^(NSE|BSE):/, '').replace(/\.(NS|BO)$/, '');
  const round2 = v => Math.round(v * 100) / 100;

  /**
   * One engine action → one intent (or null when the action needs no broker order).
   * @param a    engine action { rule, kind, qty, price, stop, trail, trancheId }
   * @param ref  { symbol, exchange, tradeId, watchlistId, openQty, ltp }
   * @param x    execution params
   */
  function plan(a, ref, x) {
    const base = { symbol: ref.symbol, exchange: ref.exchange || 'NSE', trade_id: ref.tradeId || null, watchlist_id: ref.watchlistId || null,
      rule_id: a.rule, ref_price: ref.ltp ?? a.price ?? null, stop_price: a.stop ?? null, limit_price: null, trigger_price: null,
      gtt_limit_price: null, market_protection: null, detail: {} };
    const gttLimit = stop => I.roundTick(stop * (1 - x.gttBufferPct / 100));
    const price = Number(ref.ltp ?? a.price);

    switch (a.kind) {
      case 'BUY': {
        const entry = a.rule === RULES.ENTRY;
        return { ...base, action: entry ? 'ENTRY' : 'ADD', side: 'BUY', qty: Number(a.qty), route: 'LIMIT_IOC',
          limit_price: I.roundTick(price * (1 + (entry ? x.entryBandPct : x.addBandPct) / 100)),
          detail: { afterFill: `place/raise stop GTT for the held quantity: trigger ${a.stop}, limit ${gttLimit(a.stop)}`, trigger: a.trigger ?? null } };
      }
      case 'STOP':
      case 'BRIEF':
        return { ...base, action: 'STOP_ENSURE', side: 'SELL', qty: Number(ref.openQty), route: 'GTT',
          trigger_price: I.roundTick(a.stop), gtt_limit_price: gttLimit(a.stop),
          detail: a.trail ? { note: `trail ${a.trail} for qty ${a.trailQty} is tracked by the engine, not placed at the broker` } : {} };
      case 'TRAIL':
        return { ...base, action: 'TRAIL_TRACK', side: 'SELL', qty: Number(a.qty), route: 'NONE', stop_price: a.trail ?? null,
          detail: { note: 'Tranche trail is tracked by the engine. The broker keeps one hard-stop GTT for the whole position.', tranche: a.trancheId || null } };
      case 'SELL':
        return { ...base, action: 'EXIT_PARTIAL', side: 'SELL', qty: Number(a.qty), route: 'MARKET', market_protection: -1,
          detail: { before: `reduce stop GTT quantity to ${Number(ref.openQty) - Number(a.qty)}`, tranche: a.trancheId || null } };
      case 'EXIT_ALL':
        return { ...base, action: 'EXIT_ALL', side: 'SELL', qty: Number(a.qty), route: 'MARKET', market_protection: -1,
          detail: a.rule === RULES.HARD_EXIT
            ? { note: 'Hard stop. The stop GTT should fire first; this exit runs only through the Emergency Exit sequence (cancel, confirm, verify quantity, sell).' }
            : { after: 'delete the stop GTT' } };
      default:
        return null;
    }
  }

  /** Same signal → same key → at most one intent. A stop that moves to a new level is a new intent. */
  function intentKey(intent, a, day) {
    const ref = intent.trade_id || intent.watchlist_id || intent.symbol;
    const level = intent.action === 'STOP_ENSURE' ? ':' + intent.trigger_price : '';
    return `${ref}:${a.rule}:${a.trancheId || '-'}:${day}${level}`;
  }

  /** Broker delivery quantity per symbol = settled holdings + T1 + today's net CNC position. */
  function brokerQtyMap(holdings, positions) {
    if (!holdings && !positions) return null;
    const out = {};
    const add = (sym, q) => { if (q) out[sym] = (out[sym] || 0) + q; };
    for (const h of holdings || []) add(norm(h.tradingsymbol), (Number(h.quantity) || 0) + (Number(h.t1_quantity) || 0));
    for (const p of (positions && positions.net) || []) if (p.product === 'CNC') add(norm(p.tradingsymbol), Number(p.quantity) || 0);
    return out;
  }

  /** Everything the guards need, read once per cycle. Missing pieces stay null (guards treat null as unknown). */
  async function loadContext({ settings, now }) {
    const x = execParams(settings);
    const dayStart = new Date(Date.parse(I.istDate(now) + 'T00:00:00+05:30')).toISOString();
    const [execState, drift, holdings, positions, funds, gtts, today] = await Promise.all([
      db.getExecState(), db.getOpenDrift(), db.getBrokerSnapshot('holdings'), db.getBrokerSnapshot('positions'),
      db.getBrokerSnapshot('funds'), db.getBrokerGtts(), db.getOrderIntents({ since: dayStart, limit: 500 }),
    ]);
    const eq = funds && funds.data && funds.data.equity;
    return {
      x, execState,
      drift: execState && execState.last_sync_at ? drift : null,
      brokerQty: holdings || positions ? brokerQtyMap(holdings && holdings.data, positions && positions.data) : null,
      funds: eq ? Number((eq.available && eq.available.live_balance) ?? eq.net) : null,
      gtts: gtts || [],
      keys: new Set((today || []).map(i => i.intent_key)),
      intentsToday: (today || []).filter(i => i.route !== 'NONE' && i.status !== 'shadow_noop').length,
    };
  }

  /**
   * Plan, guard and store one shadow intent for an alert that was just raised on a real trade.
   * @returns the stored row, or null (no broker order needed, or the same intent already exists).
   */
  async function record({ alert, action, symbol, exchange, tradeId, watchlistId, openQty, market, trigger, exec, now }) {
    const x = exec.x;
    const ltp = market && market.ltp;
    const intent = plan(action, { symbol, exchange, tradeId, watchlistId, openQty, ltp }, x);
    if (!intent) return null;
    const key = intentKey(intent, action, I.istDate(now));
    if (exec.keys.has(key)) return null;

    let guards = [], status = 'shadow_tracked', would = false;
    if (intent.route !== 'NONE') {
      const last = market && market.intraday && market.intraday[market.intraday.length - 1];
      guards = G.evaluate(intent, { now, minute: I.istMinutes(now), x, execState: exec.execState, drift: exec.drift, brokerQty: exec.brokerQty,
        funds: exec.funds, intentsToday: exec.intentsToday, ltp, quoteAt: last ? last.time * 1000 + 60000 : null,
        openQty, trigger: trigger ?? action.trigger, stop: action.stop });
      would = G.wouldSend(guards);
      status = would ? 'shadow_ok' : 'shadow_blocked';
      if (intent.action === 'STOP_ENSURE') {                       // already resting at the broker with the same level and quantity?
        const same = exec.gtts.some(g => g.status === 'active' && norm(g.tradingsymbol) === norm(symbol)
          && (g.trigger_values || []).some(t => Math.abs(Number(t) - intent.trigger_price) < 0.051)
          && (g.orders || []).some(o => o.transaction_type === 'SELL' && Number(o.quantity) === intent.qty));
        if (same) { status = 'shadow_noop'; intent.detail = { ...intent.detail, note: 'Stop GTT already in place at the broker with this level and quantity.' }; }
      }
    }
    // CONFIRM mode covers stop GTTs only: a stop that passes the guards is PROPOSED for your approval.
    const isExit = intent.action === 'EXIT_PARTIAL' || intent.action === 'EXIT_ALL';
    const confirm = x.mode === 'confirm' && ((intent.action === 'STOP_ENSURE' && status !== 'shadow_noop') || (isExit && x.confirmExits));
    if (confirm) status = would ? 'proposed' : 'blocked';
    const row = await db.insertOrderIntent({
      ...intent, intent_key: key, mode: confirm ? 'confirm' : 'shadow', status, would_send: would, alert_id: alert ? alert.id : null,
      guards, block_reasons: G.blockReasons(guards),
      order_value: intent.limit_price ? round2(intent.qty * intent.limit_price) : null,
      expires_at: new Date(now + (confirm ? x.confirmExpiryMin * 60 : x.intentExpirySec) * 1000).toISOString(),
    });
    exec.keys.add(key);
    if (row && intent.route !== 'NONE' && status !== 'shadow_noop') exec.intentsToday++;
    return row;
  }

  const PENDING = new Set(['proposed', 'approved', 'sending', 'unknown']);

  /**
   * You ask for a stop GTT on a position from the protection report (journal stop, journal quantity).
   * Same guards as an engine stop. Returns the stored intent (status 'proposed' or 'blocked').
   * @param p  protection row { symbol, journalQty, journalStop, lastPrice }  @param takenAt  when the gateway read it
   */
  async function proposeStop({ p, takenAt, settings, now }) {
    const exec = await loadContext({ settings, now });
    if (exec.x.mode !== 'confirm') throw new Error('Switch the mode to Confirm first.');
    if (!(Number(p.journalStop) > 0)) throw new Error('This position has no stop in the journal.');
    const open = await db.getOrderIntents({ limit: 200 });
    if (open.some(i => i.mode === 'confirm' && i.action === 'STOP_ENSURE' && PENDING.has(i.status) && norm(i.symbol) === norm(p.symbol)))
      throw new Error('A stop GTT for this stock is already waiting or being sent.');
    const intent = plan({ rule: 'MANUAL', kind: 'STOP', stop: Number(p.journalStop) }, { symbol: p.symbol, openQty: Number(p.journalQty), ltp: p.lastPrice }, exec.x);
    const guards = G.evaluate(intent, { now, minute: I.istMinutes(now), x: exec.x, execState: exec.execState, drift: exec.drift, brokerQty: exec.brokerQty,
      funds: exec.funds, intentsToday: exec.intentsToday, ltp: p.lastPrice, quoteAt: takenAt ? Date.parse(takenAt) : null, openQty: Number(p.journalQty), stop: p.journalStop });
    const would = G.wouldSend(guards);
    return db.insertOrderIntent({ ...intent, intent_key: `${norm(p.symbol)}:MANUAL-STOP:${now}`, mode: 'confirm', status: would ? 'proposed' : 'blocked', would_send: would,
      alert_id: null, guards, block_reasons: G.blockReasons(guards), order_value: null, detail: { source: 'requested from the protection report' },
      expires_at: new Date(now + exec.x.confirmExpiryMin * 60000).toISOString() });
  }

  root.TLMOrders = { EXEC_DEFAULTS, execParams, plan, intentKey, brokerQtyMap, loadContext, record, proposeStop };
})(typeof globalThis !== 'undefined' ? globalThis : this);
