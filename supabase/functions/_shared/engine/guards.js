/**
 * engine/guards.js — self-guarding checks for an order intent. Pure: no I/O, no clock, no globals.
 *
 * evaluate(intent, g) → [{ id, ok, level: 'block' | 'warn', detail }]
 * A failed 'block' guard means the order must not be sent. Fail-safe rule: when a fact is unknown,
 * anything that ADDS risk (entry, add) is blocked; anything that REMOVES risk (stop, exit) is warned.
 */
(function (root) {
  const ADDS_RISK = new Set(['ENTRY', 'ADD']);
  const SELLS = new Set(['EXIT_PARTIAL', 'EXIT_ALL']);
  const UNPROTECTED_KINDS = new Set(['NO_STOP_GTT', 'GTT_QTY_MISMATCH', 'GTT_TRIGGER_MISMATCH', 'QTY_MISMATCH', 'JOURNAL_ONLY']);
  const norm = s => String(s || '').toUpperCase().trim().replace(/^(NSE|BSE):/, '').replace(/\.(NS|BO)$/, '');
  const inr = v => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

  /**
   * @param intent  from TLMOrders.plan()
   * @param g       { now, minute, x (execution params), execState, drift (array|null), brokerQty (map|null),
   *                  funds (number|null), intentsToday (number), ltp, quoteAt (ms|null), openQty, trigger, stop }
   */
  function evaluate(intent, g) {
    const x = g.x, out = [];
    const adds = ADDS_RISK.has(intent.action);
    const add = (id, ok, detail, level = 'block') => out.push({ id, ok: !!ok, level, detail });
    const softIfExit = adds ? 'block' : 'warn';

    // ── Switches ──
    add('MODE', ['shadow', 'confirm', 'auto'].includes(x.mode), `mode is ${x.mode}`);
    if (adds) add('KILL_SWITCH', !x.killSwitch, x.killSwitch ? 'kill switch is on' : 'off');

    const st = g.execState;
    const beatAge = st && st.heartbeat_at ? (g.now - Date.parse(st.heartbeat_at)) / 1000 : Infinity;
    add('GATEWAY_ONLINE', beatAge < x.gatewayStaleSec, Number.isFinite(beatAge) ? `last heartbeat ${Math.round(beatAge)} s ago` : 'gateway has never reported');
    add('BROKER_LOGIN', !!(st && st.broker_connected && st.token_valid_until && Date.parse(st.token_valid_until) > g.now), st && st.broker_connected ? 'logged in' : 'Kite login required');
    add('STATIC_IP', !!(st && st.ip_ok), st ? `static IP ${st.ip_status || 'not checked'}` : 'unknown');

    const [from, to] = adds ? x.entryWindow : x.exitWindow;
    // A stop GTT is a resting instruction, so the clock only warns for it.
    add('MARKET_WINDOW', g.minute >= from && g.minute <= to, `IST minute ${g.minute}, allowed ${from}–${to}`, intent.action === 'STOP_ENSURE' ? 'warn' : 'block');

    // ── Price ──
    const maxAge = adds ? x.dataMaxAgeSec : x.dataMaxAgeExitSec;
    const age = g.quoteAt ? (g.now - g.quoteAt) / 1000 : null;
    add('QUOTE_FRESH', age !== null && age <= maxAge, age === null ? 'quote time unknown' : `quote is ${Math.round(age)} s old (limit ${maxAge} s)`, softIfExit);

    if (intent.action === 'ENTRY') {
      const trigger = Number(g.trigger), stop = Number(g.stop), ltp = Number(g.ltp), r = trigger - stop;
      const gapOk = ltp <= trigger * (1 + x.maxGapUpPct / 100);
      const slipOk = r > 0 && (ltp - trigger) <= x.maxEntrySlipR * r;
      add('ENTRY_NOT_GAPPED', gapOk && slipOk, `price ${inr(ltp)} vs trigger ${inr(trigger)} (max gap ${x.maxGapUpPct}%, max slip ${x.maxEntrySlipR}R)`);
    }
    if (adds) add('PRICE_ABOVE_STOP', Number(g.ltp) > Number(g.stop), `price ${inr(g.ltp)}, stop ${inr(g.stop)}`);
    if (intent.action === 'STOP_ENSURE')
      add('STOP_BELOW_PRICE', Number(intent.trigger_price) < Number(g.ltp), `stop ${inr(intent.trigger_price)}, price ${inr(g.ltp)} — at or above price means Emergency Exit, not a GTT`);

    // ── Quantity, value, funds ──
    add('QTY_VALID', Number.isInteger(intent.qty) && intent.qty > 0, `qty ${intent.qty}`);
    if (adds) {
      const value = intent.qty * Number(intent.limit_price);
      add('ORDER_VALUE', !(x.maxOrderValue > 0) || value <= x.maxOrderValue, x.maxOrderValue > 0 ? `${inr(value)} vs cap ${inr(x.maxOrderValue)}` : `${inr(value)}, no cap set`);
      add('FUNDS', g.funds !== null && g.funds !== undefined && value <= g.funds * x.fundsUtilisationPct / 100,
        g.funds === null || g.funds === undefined ? 'broker funds unknown' : `${inr(value)} vs available ${inr(g.funds)}`);
    }
    add('ORDERS_PER_DAY', g.intentsToday < x.maxOrdersPerDay, `${g.intentsToday} so far, cap ${x.maxOrdersPerDay}`);

    if (SELLS.has(intent.action) || intent.action === 'STOP_ENSURE') {
      add('WITHIN_LIFECYCLE_QTY', intent.qty <= Number(g.openQty), `qty ${intent.qty}, lifecycle open ${g.openQty}`);
      const bq = g.brokerQty ? (g.brokerQty[norm(intent.symbol)] || 0) : null;
      add('WITHIN_BROKER_QTY', bq !== null && intent.qty <= bq, bq === null ? 'broker quantity unknown (no sync yet)' : `qty ${intent.qty}, broker holds ${bq}`, bq === null ? 'warn' : 'block');
    }

    // ── Protection: no new risk while any position is not protected ──
    if (adds) {
      const bad = g.drift ? g.drift.filter(d => UNPROTECTED_KINDS.has(d.kind)) : null;
      add('ALL_POSITIONS_PROTECTED', bad !== null && bad.length === 0,
        bad === null ? 'no reconcile report yet' : bad.length ? `not protected / mismatched: ${[...new Set(bad.map(d => d.symbol))].join(', ')}` : 'all positions protected');
    }
    return out;
  }

  const wouldSend = results => results.every(r => r.ok || r.level !== 'block');
  const blockReasons = results => results.filter(r => !r.ok && r.level === 'block').map(r => `${r.id}: ${r.detail}`);

  root.TLMGuards = { evaluate, wouldSend, blockReasons, UNPROTECTED_KINDS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
