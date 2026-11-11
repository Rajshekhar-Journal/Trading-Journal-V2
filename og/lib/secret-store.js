/**
 * og/lib/secret-store.js — encrypted storage for broker and journal secrets.
 * AES-256-GCM. The master key is a random 32-byte file kept beside the data (og/data/master.key),
 * so the gateway can restart unattended. Secrets never leave this machine.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createSecretStore(dataDir) {
  const keyFile = path.join(dataDir, 'master.key');
  const file = path.join(dataDir, 'secrets.enc');

  function _key() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    const k = fs.readFileSync(keyFile);
    if (k.length !== 32) throw new Error('master.key is damaged (expected 32 bytes)');
    return k;
  }

  function readAll() {
    if (!fs.existsSync(file)) return {};
    const box = JSON.parse(fs.readFileSync(file, 'utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', _key(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  function writeAll(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', _key(), iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    const box = { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(box), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    get(name) { return readAll()[name]; },
    has(name) { const v = readAll()[name]; return v !== undefined && v !== null && v !== ''; },
    set(name, value) { const all = readAll(); all[name] = value; writeAll(all); },
    remove(name) { const all = readAll(); delete all[name]; writeAll(all); },
    names() { return Object.keys(readAll()); },
  };
}

/** Show only the last 4 characters of a secret. */
function mask(value) {
  const s = String(value || '');
  if (!s) return '';
  return '•'.repeat(Math.min(8, Math.max(0, s.length - 4))) + s.slice(-4);
}

module.exports = { createSecretStore, mask };
