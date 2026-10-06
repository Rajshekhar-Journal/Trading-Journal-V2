/**
 * tests/helpers/memory-supabase.js — tiny in-memory stand-in for a supabase-js client.
 * Supports what db-cloud.js and the runner use: select/eq/gte/lte/order/limit/single/maybeSingle,
 * insert/upsert/update/delete and the two runner-lock RPCs from migration 006.
 */
function createMemoryClient(tables = {}) {
  const T = tables;
  const clone = o => JSON.parse(JSON.stringify(o));
  class Q {
    constructor(t) { this.t = t; this.f = []; this.o = null; this.lim = null; this.op = 'select'; this.payload = null; this.one = null; }
    select() { return this; }
    eq(k, v) { this.f.push(r => r[k] === v); return this; }
    gte(k, v) { this.f.push(r => r[k] >= v); return this; }
    lte(k, v) { this.f.push(r => r[k] <= v); return this; }
    neq(k, v) { this.f.push(r => r[k] !== v); return this; }
    order(k, o) { this.o = [k, o && o.ascending === false ? -1 : 1]; return this; }
    limit(n) { this.lim = n; return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    upsert(p, o) { this.op = 'upsert'; this.payload = p; this.conflict = o && o.onConflict; return this; }
    insert(p) { this.op = 'insert'; this.payload = p; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    delete() { this.op = 'delete'; return this; }
    then(res, rej) {
      const rows = T[this.t] || (T[this.t] = []);
      const out = { data: null, error: null };
      if (this.op === 'select') {
        let d = rows.filter(r => this.f.every(f => f(r)));
        if (this.o) { const [k, s] = this.o; d = d.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * s); }
        if (this.lim) d = d.slice(0, this.lim);
        d = clone(d);
        out.data = this.one ? d[0] || null : d;
        if (this.one === 'single' && !d[0]) out.error = { message: 'not found' };
      } else if (this.op === 'upsert' || this.op === 'insert') {
        (Array.isArray(this.payload) ? this.payload : [this.payload]).forEach(p => {
          const keys = (this.conflict || (this.t === 'settings' ? 'user_id' : 'id')).split(',');
          const i = rows.findIndex(r => keys.every(k => r[k] === p[k]));
          if (i >= 0) rows[i] = { ...rows[i], ...clone(p) }; else rows.push(clone(p));
        });
      } else if (this.op === 'update') {
        rows.filter(r => this.f.every(f => f(r))).forEach(r => Object.assign(r, clone(this.payload)));
      } else if (this.op === 'delete') {
        T[this.t] = rows.filter(r => !this.f.every(f => f(r)));
      }
      return Promise.resolve(out).then(res, rej);
    }
  }
  function rpc(name, args) {
    const st = (T.runner_status || (T.runner_status = [{ id: 'tlm-runner' }]))[0];
    const now = Date.now();
    if (name === 'tlm_runner_try_lock') {
      const free = !st.locked_until || Date.parse(st.locked_until) < now || st.locked_by === args.p_holder;
      if (free) { st.locked_until = new Date(now + (args.p_seconds || 90) * 1000).toISOString(); st.locked_by = args.p_holder; }
      return Promise.resolve({ data: free, error: null });
    }
    if (name === 'tlm_runner_unlock') {
      if (st.locked_by === args.p_holder) { st.locked_until = null; st.locked_by = null; }
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } });
  }
  return { from: t => new Q(t), rpc, tables: T };
}
module.exports = { createMemoryClient };
