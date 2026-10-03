// tlm-runner — the Trade Lifecycle rule cycle, run on the server.
//
//   POST {action:"cron"}           pg_cron, every minute; header x-cron-secret = CRON_SECRET. Runs every user.
//   POST {action:"run"}            signed-in user ("Sync live data"): run this user's cycle now.
//   POST {action:"test-telegram"}  signed-in user: send a test message to the chat id in Settings.
//   POST {action:"status"}         signed-in user: heartbeat + whether Telegram is configured.
//
// The rule engine, data mapping and calculations are the SAME files the browser uses
// (copied into ../_shared/engine by `npm run sync-engine`; a test fails if the copies drift).
// Ports supplied here: db (service role, scoped to one user at a time), market data (direct
// Yahoo fetch), notifier (Telegram with the bot token held as a secret).
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json, getUser, safeEqual } from '../_shared/http.ts';
// The shared files attach themselves to globalThis and use each other at load time. Deno runs
// them as ES modules, which are evaluated in the order of these import lines.
import '../_shared/engine/calculations.js';
import '../_shared/engine/db-cloud.js';
import '../_shared/engine/indicators.js';
import '../_shared/engine/tlm-rules.js';
import '../_shared/engine/tlm-engine.js';
import '../_shared/engine/market-data.js';
import '../_shared/engine/alert-service.js';
import '../_shared/engine/executors.js';
import '../_shared/engine/runner.js';

// deno-lint-ignore no-explicit-any
const G = globalThis as any;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';
const HOLDER = 'server';

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// ── Ports ────────────────────────────────────────────────────────────────────
G.TLM_HOST = 'server';
let currentUid: string | null = null;
// db-cloud.js scopes every query with auth.getUser().id — here that is the user being processed.
G.auth = { getClient: () => admin, getUser: () => (currentUid ? { id: currentUid } : null) };

G.TLMMarketData.setSource(async (tk: string, interval: string, range: string) => {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tk)}?range=${range}&interval=${interval}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${tk}`);
  const data = await r.json();
  return data?.chart?.result?.[0] || null;
});

async function telegram(chatId: string | undefined, text: string): Promise<'sent' | 'failed' | 'skipped'> {
  if (!BOT_TOKEN || !chatId) return 'skipped';
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return r.ok ? 'sent' : 'failed';
  } catch { return 'failed'; }
}
// deno-lint-ignore no-explicit-any
G.TLMAlerts.setNotifier((text: string, settings: any) => telegram(settings?.telegramChatId, text));

// ── Helpers ──────────────────────────────────────────────────────────────────
async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  currentUid = uid;
  try { return await fn(); } finally { currentUid = null; }
}

async function lock(seconds = 90): Promise<boolean> {
  const { data, error } = await admin.rpc('tlm_runner_try_lock', { p_holder: HOLDER, p_seconds: seconds });
  if (error) throw new Error('lock: ' + error.message);
  return data === true;
}
const unlock = () => admin.rpc('tlm_runner_unlock', { p_holder: HOLDER });

async function writeStatus(patch: Record<string, unknown>) {
  await admin.from('runner_status').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 'tlm-runner');
}

async function runUser(uid: string, force: boolean) {
  return asUser(uid, async () => {
    const ran = await G.TLMRunner.runCycle({ force });
    return { ran, errors: G.TLMRunner.lastErrors().length };
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const body = await req.json().catch(() => ({}));
  const action = body?.action || 'cron';

  // Scheduled run for every user.
  if (action === 'cron') {
    if (!CRON_SECRET || !safeEqual(req.headers.get('x-cron-secret') || '', CRON_SECRET)) return json({ error: 'Forbidden' }, 403);
    if (!(await lock())) return json({ ran: false, reason: 'locked' });
    const started = new Date().toISOString();
    const result = { users: 0, ran: 0, errors: 0, failedUsers: 0 };
    try {
      const { data: users, error } = await admin.from('settings').select('user_id');
      if (error) throw new Error(error.message);
      for (const { user_id } of users || []) {
        result.users++;
        try {
          const r = await runUser(user_id, false);
          if (r.ran) result.ran++;
          result.errors += r.errors;
        } catch (e) {
          result.failedUsers++;
          console.error('tlm-runner user failed', user_id, e);
        }
      }
      await writeStatus({ last_started_at: started, last_finished_at: new Date().toISOString(), last_result: result });
      return json(result);
    } catch (e) {
      await writeStatus({ last_started_at: started, last_result: { ...result, fatal: String((e as Error).message) } });
      return json({ error: (e as Error).message }, 500);
    } finally {
      await unlock();
    }
  }

  // Everything else is for the signed-in user only.
  const user = await getUser(req);
  if (!user) return json({ error: 'Sign in required' }, 401);

  if (action === 'run') {
    // The cron run may hold the lock for a few seconds — wait briefly instead of failing.
    let got = false;
    for (let i = 0; i < 5 && !(got = await lock()); i++) await new Promise((r) => setTimeout(r, 2000));
    if (!got) return json({ error: 'The scheduled cycle is running — try again in a few seconds.' }, 409);
    try {
      const r = await runUser(user.id, true);
      return json({ ran: r.ran, errors: r.errors, at: new Date().toISOString() });
    } finally {
      await unlock();
    }
  }

  if (action === 'test-telegram') {
    if (!BOT_TOKEN) return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN secret is not set on the server.' }, 400);
    const settings = await asUser(user.id, () => G.db.getSettings());
    if (!settings?.telegramChatId) return json({ ok: false, error: 'Add your Telegram Chat ID in Settings first.' }, 400);
    const res = await telegram(settings.telegramChatId,
      `✅ Trading Journal test message\nSent by the server rule runner at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`);
    return res === 'sent' ? json({ ok: true }) : json({ ok: false, error: 'Telegram rejected the message — check the chat id and that you pressed Start in the bot.' }, 502);
  }

  if (action === 'status') {
    const { data } = await admin.from('runner_status').select('last_finished_at,last_result').eq('id', 'tlm-runner').maybeSingle();
    return json({ ...data, telegramConfigured: !!BOT_TOKEN, cronConfigured: !!CRON_SECRET });
  }

  return json({ error: 'Unknown action' }, 400);
});
