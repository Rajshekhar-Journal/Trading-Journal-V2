/**
 * og/lib/admin-auth.js — password, sessions, CSRF and lock-out for the gateway pages.
 */
'use strict';
const crypto = require('crypto');

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

function createSessions({ minutes = 30, maxFails = 5, lockMinutes = 15, now = () => Date.now() } = {}) {
  const sessions = new Map();                 // id → { csrf, expires }
  let fails = 0, lockedUntil = 0;
  return {
    locked: () => now() < lockedUntil,
    lockedForSec: () => Math.max(0, Math.ceil((lockedUntil - now()) / 1000)),
    fail() { if (++fails >= maxFails) { lockedUntil = now() + lockMinutes * 60000; fails = 0; } },
    create() {
      fails = 0;
      const id = crypto.randomBytes(32).toString('hex');
      const s = { csrf: crypto.randomBytes(24).toString('hex'), expires: now() + minutes * 60000 };
      sessions.set(id, s);
      return { id, ...s };
    },
    get(id) {
      const s = id && sessions.get(id);
      if (!s) return null;
      if (s.expires < now()) { sessions.delete(id); return null; }
      s.expires = now() + minutes * 60000;      // sliding expiry
      return s;
    },
    destroy(id) { sessions.delete(id); },
    destroyAll() { sessions.clear(); },
  };
}

module.exports = { hashPassword, verifyPassword, createSessions };
