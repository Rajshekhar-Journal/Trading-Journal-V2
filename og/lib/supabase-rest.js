/**
 * og/lib/supabase-rest.js — minimal Supabase client for the gateway (no dependencies).
 * The gateway signs in AS THE JOURNAL USER, so row-level security applies to everything it does.
 * It holds a refresh token (encrypted), never the journal password and never a service-role key.
 */
'use strict';

function createSupabase({ url, anonKey, getRefreshToken, setRefreshToken, fetchImpl }) {
  const _fetch = fetchImpl || globalThis.fetch;
  const base = String(url || '').replace(/\/$/, '');
  let session = null;                                   // { accessToken, expiresAt, userId }

  async function _auth(grant, body) {
    const res = await _fetch(`${base}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error('Journal sign-in failed: ' + (j.error_description || j.msg || j.error || res.status));
    session = { accessToken: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, userId: j.user && j.user.id };
    if (j.refresh_token) setRefreshToken(j.refresh_token);
    return session;
  }

  /** One-time link from the setup page. The password is used once and not stored. */
  const signInWithPassword = (email, password) => _auth('password', { email, password });

  async function _session() {
    if (session && session.expiresAt - Date.now() > 60000) return session;
    const rt = getRefreshToken();
    if (!rt) throw new Error('Journal account is not linked');
    return _auth('refresh_token', { refresh_token: rt });
  }

  async function _rest(method, pathAndQuery, { body, prefer } = {}) {
    const s = await _session();
    const headers = { apikey: anonKey, Authorization: `Bearer ${s.accessToken}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await _fetch(`${base}/rest/v1/${pathAndQuery}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error(`Journal database ${method} ${pathAndQuery.split('?')[0]} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    signInWithPassword,
    isLinked: () => !!getRefreshToken(),
    userId: async () => (await _session()).userId,
    select: (table, query = 'select=*') => _rest('GET', `${table}?${query}`),
    upsert: (table, rows, onConflict) => rows.length
      ? _rest('POST', `${table}?on_conflict=${encodeURIComponent(onConflict)}`, { body: rows, prefer: 'resolution=merge-duplicates,return=minimal' })
      : Promise.resolve(null),
    update: (table, filter, patch) => _rest('PATCH', `${table}?${filter}`, { body: patch, prefer: 'return=minimal' }),
  };
}

module.exports = { createSupabase };
