/**
 * config.js — single source of app configuration.
 * Loaded first by index.html / login.html; also usable from Node tests.
 */
(function (root) {
  const APP_CONFIG = Object.freeze({
    SUPABASE_URL: 'https://zopskuwqlbteyiypwnid.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpvcHNrdXdxbGJ0ZXlpeXB3bmlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMTI3NTksImV4cCI6MjA5OTY4ODc1OX0.gG0TU9Uf3ODJOqUu4SqZs-Uk1CKlUb47DrfULVg6vHY',
    MARKET_TZ: 'Asia/Kolkata',
  });
  root.APP_CONFIG = APP_CONFIG;
  if (typeof module !== 'undefined' && module.exports) module.exports = APP_CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
