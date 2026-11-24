// _shared/tg.ts — Telegram approval buttons: webhook secret and button signatures.
// Both are derived from the service-role key, so no extra secret has to be set; neither ever leaves the server.

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** The secret Telegram sends back in the X-Telegram-Bot-Api-Secret-Token header (setWebhook secret_token). */
export async function webhookSecret(serviceKey: string): Promise<string> {
  return (await sha256hex(serviceKey + ':tg-webhook')).slice(0, 48);
}
/** Short signature for one button: HMAC-SHA256(secret, verb:intentId), 12 hex chars. */
export async function signButton(secret: string, verb: string, intentId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${verb}:${intentId}`));
  return [...new Uint8Array(mac)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}
