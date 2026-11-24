// tg-webhook — Telegram calls this when you tap Approve / Reject on a proposal message.
// Checks, in order: Telegram's secret header · the button signature · that this exact message was sent to this chat
// for this proposal (tg_notices) · that the chat is still your saved Telegram chat and Telegram approvals are on.
// Then it decides through exec_decide_intent_for() — the same rule as the journal button — and edits the message.
// It can only approve or reject a proposal the engine made. It never creates an order.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { safeEqual } from '../_shared/http.ts';
import { webhookSecret, signButton } from '../_shared/tg.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function tg(method: string, body: unknown) {
  if (!BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}
const ist = () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
const ok = () => new Response('ok');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const secret = await webhookSecret(SERVICE_KEY);
  if (!safeEqual(req.headers.get('x-telegram-bot-api-secret-token') || '', secret)) return new Response('Forbidden', { status: 403 });
  const update = await req.json().catch(() => ({}));
  const cq = update?.callback_query;
  if (!cq) return ok();                                                     // only button taps are handled
  const answer = (text: string) => tg('answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: text.length > 60 });

  const [verb, intentId, sig] = String(cq.data || '').split(':');
  if (!['a', 'r'].includes(verb) || !intentId || !sig || !safeEqual(sig, await signButton(secret, verb, intentId))) { await answer('Not recognised.'); return ok(); }
  const chatId = String(cq.message?.chat?.id ?? '');
  const messageId = cq.message?.message_id;

  const { data: notice } = await admin.from('tg_notices').select('*').eq('intent_id', intentId).eq('chat_id', chatId).maybeSingle();
  if (!notice || (messageId && Number(notice.message_id) !== Number(messageId))) { await answer('This message is not a proposal sent to this chat.'); return ok(); }
  const { data: st } = await admin.from('settings').select('data').eq('user_id', notice.user_id).maybeSingle();
  const s = st?.data || {};
  if (String(s.telegramChatId || '') !== chatId) { await answer('This chat is no longer the saved Telegram chat.'); return ok(); }
  if (!s.execution?.telegramApprovals) { await answer('Telegram approvals are switched off in the journal.'); return ok(); }

  const { data: result, error } = await admin.rpc('exec_decide_intent_for', { p_user: notice.user_id, p_id: intentId, p_approve: verb === 'a' });
  if (error) { await answer('Could not decide: ' + error.message); return ok(); }
  await admin.from('tg_notices').update({ decided: result }).eq('id', notice.id);

  const line = result === 'approved' ? `✅ Approved ${ist()} — the gateway sends it within seconds (after its checks).`
    : result === 'rejected' ? `✖ Rejected ${ist()} — nothing will be sent.`
    : result === 'expired' ? '⌛ Too late: the proposal had expired. Nothing was sent.'
    : `Already ${result} — nothing changed.`;
  await answer(line.split(' — ')[0]);
  await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: `${cq.message?.text || ''}\n\n${line}` });   // removes the buttons
  return ok();
});
