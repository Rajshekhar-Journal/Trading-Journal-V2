/**
 * engine/market-data.js — candles for the rule engine via the `yahoo-finance` Edge Function.
 * One intraday (1-min) fetch per symbol per cycle; daily candles cached once per IST day.
 */
(function (root) {
  const I = root.TLMIndicators;
  const _dailyCache = {};   // { ticker: { day, candles } }

  function ticker(symbol, exchange) {
    if (symbol.includes('.')) return symbol;
    return symbol + (exchange === 'BSE' ? '.BO' : '.NS');
  }

  /**
   * Market-data port: (ticker, interval, range) → Yahoo-style chart result.
   * Browser default: the authenticated `yahoo-finance` Edge Function (auth.js attaches the user token).
   * The backend runner replaces it with a direct server-side fetch via setSource().
   */
  let _source = async (tk, interval, range) => {
    const url = `${APP_CONFIG.SUPABASE_URL}/functions/v1/yahoo-finance?ticker=${encodeURIComponent(tk)}&interval=${interval}&range=${range}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`price feed ${resp.status} for ${tk}`);
    const data = await resp.json();
    return data?.chart?.result?.[0] || null;
  };
  const setSource = fn => { _source = fn; };
  const _chart = (tk, interval, range) => _source(tk, interval, range);

  function _candles(result) {
    if (!result?.timestamp) return [];
    const q = result.indicators.quote[0];
    return result.timestamp.map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] }))
      .filter(c => c.open != null && c.high != null && c.low != null && c.close != null)
      .map(c => ({ time: c.time, open: +c.open.toFixed(2), high: +c.high.toFixed(2), low: +c.low.toFixed(2), close: +c.close.toFixed(2) }));
  }

  /** Intraday 1-min candles and last traded price. */
  async function intraday(symbol, exchange) {
    const r = await _chart(ticker(symbol, exchange), '1m', '1d');
    const candles = _candles(r);
    const ltp = r?.meta?.regularMarketPrice || candles[candles.length - 1]?.close || null;
    return { ltp, intraday: candles };
  }

  /** Daily candles (6 months), each tagged with its IST date. Cached per day. */
  async function daily(symbol, exchange) {
    const tk = ticker(symbol, exchange);
    const today = I.istDate(Date.now());
    if (_dailyCache[tk]?.day === today) return _dailyCache[tk].candles;
    const candles = _candles(await _chart(tk, '1d', '6mo')).map(c => ({ ...c, date: I.istDate(c.time * 1000) }));
    _dailyCache[tk] = { day: today, candles };
    return candles;
  }

  /**
   * Load market data for many symbols in parallel.
   * @param {Array<{symbol, exchange}>} list
   * @returns {Promise<Object>} { SYMBOL: { ltp, intraday, daily } } — failed symbols are omitted.
   */
  async function load(list) {
    const out = {};
    const seen = new Set();
    await Promise.all(list.filter(x => !seen.has(x.symbol) && seen.add(x.symbol)).map(async ({ symbol, exchange }) => {
      try {
        const [i, d] = await Promise.all([intraday(symbol, exchange), daily(symbol, exchange)]);
        out[symbol] = { ...i, daily: d };
      } catch (e) {
        console.warn('market data unavailable:', symbol, e.message);
      }
    }));
    return out;
  }

  const api = { load, intraday, daily, ticker, setSource };
  root.TLMMarketData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
