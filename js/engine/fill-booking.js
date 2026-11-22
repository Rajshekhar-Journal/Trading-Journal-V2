/**
 * engine/fill-booking.js — writes completed BUY orders and revised stops into the journal (Auto Trade Engine).
 *
 * The gateway only carries out orders. When it has bought shares, this module (run by the backend runner
 * every minute) records them, exactly as you would by hand, and then asks for the stop GTT for the new quantity:
 *   ENTRY done  → a new trade (same shape as ▶ Execute on the Watchlist); the watchlist item is marked executed
 *   ADD done    → a pyramid line on the open trade (same shape as the Pyramid action)
 *   STOP_ENSURE done → if the GTT level is higher than the journal stop, the journal stop is raised and a stop revision is added
 * Each intent is booked once: ids are derived from the intent id and the intent is marked through
 * exec_mark_booked(), so a repeat run or a second runner changes nothing.
 * It never talks to the broker.
 */
(function (root) {
  const norm = s => String(s || '').toUpperCase().replace(/-EQ$/, '').trim();
  const round2 = n => Math.round(n * 100) / 100;
  const dateOf = (iso, I) => I.istDate(Date.parse(iso) || Date.now());

  function charges(qty, price, exchange, settings) {
    try {
      if (typeof calc === 'undefined' || !calc.getZerodhaCharges) return 0;   // calc is a script-level const, not a window property
      return round2(calc.getZerodhaCharges('Equity', qty * price, 0, settings, exchange || 'NSE').total || 0);
    } catch (_) { return 0; }
  }

  async function mark(intent, text) { try { await db.markIntentBooked(intent.id, text); } catch (e) { console.error('mark booked failed', e.message); } }

  async function bookEntry(i, { settings, openTrades, watch, now }) {
    const I = root.TLMIndicators, E = root.TLMEngine;
    const id = 'tr_ax_' + i.id;
    if (openTrades.some(t => t.id === id) || (await db.getTradeById?.(id))) return 'booked_entry';
    const qty = Number(i.result.filled), price = Number(i.result.averagePrice);
    const stop = Number(i.stop_price);
    if (!(qty > 0) || !(price > 0) || !(stop > 0 && stop < price)) return 'not_booked: fill or stop missing';
    if (openTrades.some(t => norm(t.symbol) === norm(i.symbol))) return 'not_booked: the stock is already open in the journal';
    const item = watch.find(w => w.id === i.watchlist_id) || {};
    const date = dateOf(i.result.at || i.updated_at || new Date(now).toISOString(), I);
    const ch = charges(qty, price, i.exchange, settings);
    const params = { ...root.TLMRules.DEFAULT_PARAMS, ...(settings?.tlmParams || {}) };
    const sym = norm(i.symbol);
    const trade = {
      id, symbol: sym, sector: item.sector || 'Other', tradeType: 'Equity', direction: 'Long', exchange: i.exchange || 'NSE',
      playbookId: '', playbookVersion: '', initialStop: stop, currentStop: stop,
      rpt: Number(item.rpt) || round2((price - stop) * qty),
      tlmState: (root.TLMStrategies ? root.TLMStrategies.createState({ strategyId: item.strategy, entryPrice: price, firstQty: qty, initialStop: stop, params, settings, now })
        : E.createState({ entryPrice: price, firstQty: qty, initialStop: stop, params, now })),
      entries: [{ id: 'en_ax_' + i.id, date, price, qty, charges: ch, notes: `Auto Trade Engine buy (order ${i.result.orderId || i.broker_ref || ''})` }],
      pyramids: [], stopRevisions: [{ id: 'sr_ax_' + i.id, date, oldStop: 0, newStop: stop, actionSource: 'Auto', notes: 'Initial stop from the engine entry' }],
      partialExits: [], finalExit: null, notes: [], alerts: [], ruleFollowed: true, reviewStatus: 'Pending', rating: 0,
      chartLink: `https://www.tradingview.com/chart/?symbol=${i.exchange || 'NSE'}:${sym}`, tags: item.sector ? [item.sector] : [],
      cmp: price, createdAt: date, closedAt: null,
    };
    await db.saveTrade(trade);
    if (item.id) await db.saveWatchlistItem({ ...item, status: 'executed' }).catch(() => {});
    return 'booked_entry';
  }

  async function bookAdd(i, { settings, openTrades, now }) {
    const I = root.TLMIndicators;
    const t = openTrades.find(x => x.id === i.trade_id) || openTrades.find(x => norm(x.symbol) === norm(i.symbol));
    if (!t) return 'not_booked: no open trade for this stock';
    const pid = 'py_ax_' + i.id;
    if ((t.pyramids || []).some(p => p.id === pid)) return 'booked_add';
    const qty = Number(i.result.filled), price = Number(i.result.averagePrice);
    if (!(qty > 0) || !(price > 0)) return 'not_booked: fill missing';
    const date = dateOf(i.result.at || i.updated_at || new Date(now).toISOString(), I);
    const next = { ...t, pyramids: [...(t.pyramids || []), { id: pid, date, price, qty, charges: charges(qty, price, i.exchange, settings),
      actionSource: 'Auto', notes: `Auto Trade Engine add (order ${i.result.orderId || i.broker_ref || ''})` }] };
    await db.saveTrade(next);
    return 'booked_add';
  }

  async function bookStop(i, { openTrades, now }) {
    const I = root.TLMIndicators;
    const t = openTrades.find(x => norm(x.symbol) === norm(i.symbol));
    if (!t) return 'not_booked: no open trade';
    const newStop = Number(i.trigger_price);
    const cur = Number(t.currentStop ?? t.initialStop ?? 0);
    if (!(newStop > 0)) return 'not_booked: no stop level';
    if (newStop <= cur) return 'booked_stop';                       // placed at or below the journal stop: nothing to raise
    const rid = 'sr_ax_' + i.id;
    if ((t.stopRevisions || []).some(r => r.id === rid)) return 'booked_stop';
    const date = dateOf(i.updated_at || new Date(now).toISOString(), I);
    await db.saveTrade({ ...t, currentStop: newStop, stopRevisions: [...(t.stopRevisions || []),
      { id: rid, date, oldStop: cur, newStop, actionSource: 'Auto', notes: 'Stop GTT revised by the Auto Trade Engine' }] });
    return 'booked_stop';
  }

  /** After a buy is booked, make sure a stop GTT for the new quantity is proposed (retried every 5 minutes while none is pending or done). */
  async function ensureStops({ settings, now, recent, openTrades, all }) {
    const out = [];
    const bucket = Math.floor(now / 300000);
    for (const i of recent) {
      const t = openTrades.find(x => norm(x.symbol) === norm(i.symbol));
      if (!t || !(Number(t.currentStop) > 0)) continue;
      const after = Date.parse(i.booked_at || 0);
      const has = all.some(s => s.mode === 'confirm' && s.action === 'STOP_ENSURE' && norm(s.symbol) === norm(i.symbol) && Date.parse(s.created_at) >= after
        && ['proposed', 'approved', 'sending', 'unknown', 'done'].includes(s.status));
      if (has) continue;
      const qty = (t.entries || []).reduce((a, e) => a + (Number(e.qty) || 0), 0) + (t.pyramids || []).reduce((a, e) => a + (Number(e.qty) || 0), 0)
        - (t.partialExits || []).reduce((a, e) => a + (Number(e.qty) || 0), 0);
      if (!(qty > 0)) continue;
      try {
        const r = await root.TLMOrders.proposeStop({ p: { symbol: t.symbol, journalQty: qty, journalStop: Number(t.currentStop), lastPrice: Number(i.result.averagePrice) },
          takenAt: new Date(now).toISOString(), settings, now, source: 'after an automatic buy', key: `${norm(i.symbol)}:AUTO-STOP:${i.id}:${bucket}` });
        if (r) out.push(r.symbol);
      } catch (e) { console.error('auto stop proposal failed', e.message); }
    }
    return out;
  }

  /** @returns { booked, stops, notBooked } */
  async function run({ settings, now = Date.now() }) {
    const out = { booked: 0, stops: [], notBooked: 0 };
    const x = root.TLMOrders.execParams(settings);
    if (!root.TLMOrders.isConfirmLike(x.mode)) return out;
    const all = await db.getOrderIntents({ since: new Date(now - 36 * 3600000).toISOString(), limit: 500 });
    const todo = all.filter(i => i.mode === 'confirm' && ['ENTRY', 'ADD', 'STOP_ENSURE'].includes(i.action) && i.booking == null
      && (i.status === 'done' || (i.status === 'failed' && i.result && Number(i.result.filled) > 0)));
    const recent = all.filter(i => i.mode === 'confirm' && (i.action === 'ENTRY' || i.action === 'ADD') && /^booked_(entry|add)$/.test(i.booking || '')
      && now - Date.parse(i.booked_at || 0) < 2 * 3600000);
    if (!todo.length && !recent.length) return out;
    let openTrades = await db.getOpenTrades();
    const watch = todo.some(i => i.action === 'ENTRY') ? await db.getWatchlist() : [];
    for (const i of todo.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
      if (i.action !== 'STOP_ENSURE' && !(i.result && Number(i.result.filled) > 0)) continue;
      try {
        const r = i.action === 'ENTRY' ? await bookEntry(i, { settings, openTrades, watch, now })
          : i.action === 'ADD' ? await bookAdd(i, { settings, openTrades, now }) : await bookStop(i, { openTrades, now });
        await mark(i, r);
        if (r.startsWith('booked_')) { out.booked++; if (i.action !== 'STOP_ENSURE') recent.push({ ...i, booking: r, booked_at: new Date(now).toISOString() }); } else out.notBooked++;
        openTrades = await db.getOpenTrades();
      } catch (e) { console.error('booking failed', i.symbol, e.message); out.notBooked++; }
    }
    if (recent.length) out.stops = await ensureStops({ settings, now, recent, openTrades, all: await db.getOrderIntents({ since: new Date(now - 36 * 3600000).toISOString(), limit: 500 }) });
    return out;
  }

  root.TLMFills = { run };
})(typeof globalThis !== 'undefined' ? globalThis : window);
