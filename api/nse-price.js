/**
 * api/nse-price.js — Vercel Serverless Function
 * NSE India Unofficial API Proxy (Phase 2)
 * Bypasses CORS restriction by fetching NSE data server-side.
 * Usage: GET /api/nse-price?symbol=RELIANCE
 */

export default async function handler(req, res) {
  // CORS headers — allow our own domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol query param required. e.g. ?symbol=RELIANCE' });
  }

  const sym = symbol.trim().toUpperCase();

  try {
    // Step 1: Get NSE session cookie (required by NSE anti-bot)
    const sessionResp = await fetch('https://www.nseindia.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
    });

    const rawCookies = sessionResp.headers.get('set-cookie') || '';
    // Extract individual cookies (NSE needs nsit + nseappid)
    const cookies = rawCookies
      .split(',')
      .map(c => c.split(';')[0].trim())
      .filter(c => c.length > 0)
      .join('; ');

    // Step 2: Fetch the actual quote
    const quoteResp = await fetch(
      `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(sym)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://www.nseindia.com/',
          'Cookie': cookies,
          'Connection': 'keep-alive',
        },
      }
    );

    if (!quoteResp.ok) {
      // Fallback: try Yahoo Finance as backup
      return await _yahooFallback(sym, res);
    }

    const data = await quoteResp.json();
    const price = data?.priceInfo;

    if (!price) {
      return await _yahooFallback(sym, res);
    }

    return res.status(200).json({
      symbol: sym,
      price: price.lastPrice,
      open: price.open,
      high: price.intraDayHighLow?.max,
      low: price.intraDayHighLow?.min,
      previousClose: price.previousClose,
      change: price.change,
      changePercent: price.pChange,
      source: 'NSE',
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    // Graceful fallback to Yahoo Finance if NSE fails
    return await _yahooFallback(sym, res);
  }
}

// ── Yahoo Finance fallback ────────────────────────────────────────────────────
async function _yahooFallback(symbol, res) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS?interval=1d&range=1d`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    });
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) {
      return res.status(502).json({
        error: 'Price unavailable from both NSE and Yahoo Finance. Enter manually.',
        symbol,
      });
    }
    return res.status(200).json({
      symbol,
      price: meta.regularMarketPrice,
      previousClose: meta.previousClose,
      change: meta.regularMarketPrice - meta.previousClose,
      changePercent: (((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(2),
      source: 'Yahoo (fallback)',
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({
      error: 'Both NSE and Yahoo Finance unavailable. Enter CMP manually.',
      symbol,
    });
  }
}
