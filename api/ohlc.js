/**
 * api/ohlc.js — Vercel serverless proxy for Yahoo Finance OHLC data
 * Called from the browser as /api/ohlc?symbol=ADANIGREEN.NS&range=1y
 * Bypasses browser CORS restrictions on Yahoo Finance API.
 */
module.exports = async function handler(req, res) {
  const { symbol, range = '1y', interval = '1d' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'symbol parameter is required' });
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Yahoo Finance returned HTTP ${response.status}` });
    }

    const data = await response.json();

    // Cache for 1 hour — daily candles don't change mid-day
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
