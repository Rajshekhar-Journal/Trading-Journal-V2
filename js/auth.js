/**
 * js/auth.js — Authentication Layer (Phase 2)
 * Manages Supabase session, login, logout.
 * All modules depend on auth.currentUser being set before init().
 */

const auth = (() => {
  const SUPABASE_URL = APP_CONFIG.SUPABASE_URL;
  const SUPABASE_KEY = APP_CONFIG.SUPABASE_ANON_KEY;

  // Supabase client — initialised once
  const _client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // Edge Functions accept only a signed-in user's token (the public anon key proves nothing),
  // so every call to /functions/v1/* gets the current session token attached here, in one place.
  const _FN_BASE = SUPABASE_URL + '/functions/v1/';
  const _fetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!url.startsWith(_FN_BASE)) return _fetch(input, init);
    const { data } = await _client.auth.getSession();
    const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    if (data?.session?.access_token) headers.set('Authorization', `Bearer ${data.session.access_token}`);
    headers.set('apikey', SUPABASE_KEY);
    return _fetch(input, { ...init, headers });
  };

  let currentUser = null;
  let _onAuthChange = null;

  // ── Initialise — check existing session ──────────────────────────────────
  async function init() {
    const { data: { session } } = await _client.auth.getSession();
    currentUser = session?.user ?? null;

    // Listen for auth state changes (login / logout / token refresh)
    _client.auth.onAuthStateChange((event, session) => {
      currentUser = session?.user ?? null;
      if (_onAuthChange) _onAuthChange(event, currentUser);
    });

    return currentUser;
  }

  // ── Login with email + password ──────────────────────────────────────────
  async function signIn(email, password) {
    const { data, error } = await _client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    return data.user;
  }

  // ── Logout ───────────────────────────────────────────────────────────────
  async function signOut() {
    await _client.auth.signOut();
    currentUser = null;
    window.location.href = '/login.html';
  }

  // ── Get Supabase client (used by db-cloud.js) ─────────────────────────────
  function getClient() {
    return _client;
  }

  // ── Get current user ──────────────────────────────────────────────────────
  function getUser() {
    return currentUser;
  }

  // ── Set callback for auth state changes ───────────────────────────────────
  function onAuthChange(fn) {
    _onAuthChange = fn;
  }

  // ── Check if user is authenticated — redirect to login if not ────────────
  async function requireAuth() {
    const user = await init();
    if (!user) {
      window.location.href = '/login.html';
      return false;
    }
    return true;
  }

  return { init, signIn, signOut, getClient, getUser, onAuthChange, requireAuth };
})();
