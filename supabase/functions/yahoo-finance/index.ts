// yahoo-finance — authenticated proxy to Yahoo Finance chart data for the signed-in user.
// Only valid tickers and known range/interval values are forwarded (no open proxy).
import { corsHeaders, json, getUser } from '../_shared/http.ts';

const TICKER   = /^[A-Za-z0-9^&._=-]{1,25}$/;
const RANGES   = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const INTERVAL = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Sign in required' }, 401);

  const url = new URL(req.url);
  const ticker = url.searchParams.get('ticker') || '';
  const range = url.searchParams.get('range') || '1mo';
  const interval = url.searchParams.get('interval') || '1d';
  if (!TICKER.test(ticker)) return json({ error: 'Invalid ticker' }, 400);
  if (!RANGES.has(range) || !INTERVAL.has(interval)) return json({ error: 'Invalid range or interval' }, 400);

  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
    });
    if (!r.ok) return json({ error: `Yahoo Finance returned ${r.status}` }, 502);
    return json(await r.json(), 200, { 'Cache-Control': interval.endsWith('m') || interval === '1h' ? 'no-store' : 'private, max-age=300' });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
