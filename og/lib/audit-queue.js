/**
 * og/lib/audit-queue.js — makes the order_audit trail loss-free and says which machine wrote each row.
 *
 * Wraps the journal client so every order_audit insert:
 *   • gets detail.host (this machine's name) and detail.og (gateway version);
 *   • if the journal cannot be reached (rate limit, network), is saved to <dataDir>/audit-pending.jsonl
 *     and the caller is told it succeeded; flush() sends the saved rows later, oldest first.
 * A row the journal already has (409 duplicate) counts as sent. Rows without a user (written before sign-in) get it at flush time.
 */
'use strict';
const fs = require('fs');

function createAuditQueue({ file, host, version, log = () => {}, maxRows = 5000 }) {
  const stamp = rows => rows.map(r => ({ ...r, detail: { ...(r.detail || {}), host, og: version } }));
  const read = () => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
  function save(rows) {
    const all = [...read(), ...rows].slice(-maxRows);
    fs.writeFileSync(file + '.tmp', all.map(r => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  function rewrite(rows) {
    if (!rows.length) { try { fs.unlinkSync(file); } catch (_) { fs.writeFileSync(file, ''); } return; }
    fs.writeFileSync(file + '.tmp', rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  }
  const duplicate = e => /\b409\b|duplicate key/i.test(String(e && e.message));

  /** The journal client with a loss-free order_audit insert. */
  function wrap(store) {
    return { ...store, insert: async (table, rows) => {
      if (table !== 'order_audit') return store.insert(table, rows);
      const r = stamp(rows);
      try { return await store.insert(table, r); }
      catch (e) {
        if (duplicate(e)) return null;
        save(r);                                     // throws only if the disk itself fails — then the caller logs it as before
        log.warn ? log.warn('journal', 'audit_saved_locally', `Audit row kept on this machine, will be sent later: ${String(e.message).slice(0, 120)}`, { detail: { rows: r.length } })
          : log('[og] audit saved locally', JSON.stringify({ error: String(e.message).slice(0, 120) }));
        return null;
      }
    } };
  }
  /** Add a row without a user yet (e.g. gateway start before sign-in). */
  const enqueue = rows => save(stamp(rows));
  /** Send what was kept. Returns { sent, left }. */
  async function flush(store) {
    const rows = read();
    if (!rows.length) return { sent: 0, left: 0 };
    let uid = null, sent = 0;
    const left = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        if (!r.user_id) { uid = uid || await store.userId(); r.user_id = uid; }
        await store.insert('order_audit', [r]); sent++;
      } catch (e) {
        if (duplicate(e)) { sent++; continue; }
        left.push(...rows.slice(i)); break;          // still unreachable: keep the rest in order, try next time
      }
    }
    rewrite(left);
    if (sent && log.info) log.info('journal', 'audit_flushed', `Sent ${sent} audit row(s) kept on this machine`, { detail: { sent, left: left.length } });
    return { sent, left: left.length };
  }
  return { wrap, enqueue, flush, pending: () => read().length };
}

module.exports = { createAuditQueue };
