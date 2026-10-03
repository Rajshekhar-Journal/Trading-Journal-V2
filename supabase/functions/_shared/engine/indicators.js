/**
 * engine/indicators.js — pure market maths used by the TLM rule engine.
 * No DOM, no network, no database. Works in browser and Node.
 */
(function (root) {
  const TZ = 'Asia/Kolkata';

  /** 'YYYY-MM-DD' of an epoch-ms instant in IST. */
  function istDate(ms) {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
  }

  /** Minutes since IST midnight for an epoch-ms instant. */
  function istMinutes(ms) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(ms));
    const h = Number(parts.find(p => p.type === 'hour').value) % 24;
    const m = Number(parts.find(p => p.type === 'minute').value);
    return h * 60 + m;
  }

  /** IST weekday 0=Sun..6=Sat. */
  function istWeekday(ms) {
    const d = istDate(ms);
    return new Date(d + 'T12:00:00Z').getUTCDay();
  }

  /** EMA seeded with the SMA of the first `period` values. Returns null if not enough data. */
  function ema(values, period) {
    if (!values || values.length < period) return null;
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
    return e;
  }

  /** Wilder ATR over candles [{high,low,close}]. Returns null if not enough data. */
  function atr(candles, period = 14) {
    if (!candles || candles.length <= period) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
    return a;
  }

  /** NSE tick size by price band (same bands the app used before). */
  function tickSize(price) {
    if (price <= 250) return 0.05;
    if (price <= 1000) return 0.10;
    if (price <= 5000) return 0.50;
    if (price <= 18000) return 1.00;
    return 5.00;
  }

  /** Round to the nearest valid tick. */
  function roundTick(price) {
    if (!price || price <= 0) return 0;
    const t = tickSize(price);
    return Number((Math.round(price / t) * t).toFixed(2));
  }

  /** Completed 1-min candles: those whose minute has fully elapsed at `nowMs`. */
  function completedMinutes(intraday, nowMs) {
    return (intraday || []).filter(c => (c.time + 60) * 1000 <= nowMs);
  }

  /**
   * True when the last `minutes` completed 1-min closes all satisfy `test`
   * and the latest price satisfies it too. Data must be fresh (last candle
   * closed within 3 minutes of now), otherwise the check fails safe.
   */
  function _hold(intraday, minutes, ltp, nowMs, test) {
    const done = completedMinutes(intraday, nowMs);
    if (done.length < minutes || !(ltp > 0)) return false;
    const last = done.slice(-minutes);
    const newest = last[last.length - 1];
    if (nowMs - (newest.time + 60) * 1000 > 3 * 60 * 1000) return false;
    // candles must be consecutive minutes (no gap inside the window)
    for (let i = 1; i < last.length; i++) if (last[i].time - last[i - 1].time > 90) return false;
    return last.every(c => test(c.close)) && test(ltp);
  }

  const holdAbove = (intraday, level, minutes, ltp, nowMs) => _hold(intraday, minutes, ltp, nowMs, v => v >= level);
  const holdBelow = (intraday, level, minutes, ltp, nowMs) => _hold(intraday, minutes, ltp, nowMs, v => v < level);

  /** Daily candles strictly before `todayIso` (i.e. fully closed days). */
  function closedDays(daily, todayIso) {
    return (daily || []).filter(c => c.date < todayIso);
  }

  const api = { istDate, istMinutes, istWeekday, ema, atr, tickSize, roundTick, completedMinutes, holdAbove, holdBelow, closedDays };
  root.TLMIndicators = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
