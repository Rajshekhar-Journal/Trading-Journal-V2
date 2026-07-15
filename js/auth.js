/**
 * js/auth.js — Authentication Layer (Phase 2)
 * Manages Supabase session, login, logout.
 * All modules depend on auth.currentUser being set before init().
 */

const auth = (() => {
  const SUPABASE_URL = 'https://vzwbrhqnhnryytyxwjaa.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_5pVRi-kM6pUBa-0o8wBMBw_X5Ta-GCP';

  // Supabase client — initialised once
  const _client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
