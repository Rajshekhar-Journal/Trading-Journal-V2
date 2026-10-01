/**
 * import-rules.js — pure parsing & validation for Excel/CSV import (no DOM, no DB).
 * Turns sheet rows (arrays of cells) into validated Watchlist items / Position rows.
 * Used by js/modules/importer.js in the browser and by tests/import.test.js in Node.
 */
(function (root) {
  'use strict';

  const EXAMPLE_SYMBOL = 'EXAMPLE';   // template sample row — always ignored on import

  // ── Templates ──────────────────────────────────────────────────────────────
  const TEMPLATES = {
    watchlist: {
      file: 'watchlist_import_template.xlsx',
      sheet: 'Watchlist',
      columns: [
        { key: 'symbol',  label: 'Symbol',  required: true,  width: 14, aliases: ['ticker', 'stock', 'scrip'] },
        { key: 'trigger', label: 'Trigger', required: true,  width: 11, aliases: ['trigger price', 'buy above', 'entry', 'trigger buy price'] },
        { key: 'stop',    label: 'Stop',    required: true,  width: 11, aliases: ['stop loss', 'sl', 'stoploss'] },
        { key: 'sector',  label: 'Sector',  width: 12 },
        { key: 'rpt',     label: 'RPT',     width: 10, aliases: ['risk per trade'] },
        { key: 'mode',    label: 'Mode',    width: 10 },
        { key: 'notes',   label: 'Notes',   width: 36, aliases: ['setup', 'thesis', 'remarks'] },
      ],
      example: [EXAMPLE_SYMBOL, 1500, 1380, 'IT', '', 'Both', 'Sample row — ignored on import. Delete or overwrite it.'],
    },
    positions: {
      file: 'positions_import_template.xlsx',
      sheet: 'Positions',
      columns: [
        { key: 'symbol',      label: 'Symbol',       required: true, width: 14, aliases: ['ticker', 'stock', 'scrip'] },
        { key: 'date',        label: 'Entry Date',   required: true, width: 12, aliases: ['date', 'buy date'] },
        { key: 'price',       label: 'Entry Price',  required: true, width: 12, aliases: ['price', 'buy price', 'avg price', 'average price'] },
        { key: 'qty',         label: 'Qty',          required: true, width: 8,  aliases: ['quantity', 'shares'] },
        { key: 'initialStop', label: 'Initial Stop', required: true, width: 12, aliases: ['stop', 'stop loss', 'sl'] },
        { key: 'currentStop', label: 'Current Stop', width: 12, aliases: ['trailing stop', 'trail stop'] },
        { key: 'stage',       label: 'Stage',        width: 9,  aliases: ['lifecycle stage'] },
        { key: 'exchange',    label: 'Exchange',     width: 9 },
        { key: 'type',        label: 'Type',         width: 10, aliases: ['trade type'] },
        { key: 'sector',      label: 'Sector',       width: 12 },
        { key: 'playbook',    label: 'Playbook',     width: 14 },
        { key: 'charges',     label: 'Charges',      width: 10 },
        { key: 'notes',       label: 'Notes',        width: 36 },
      ],
      example: [EXAMPLE_SYMBOL, '15-09-2026', 1500, 20, 1380, '', 'Entry', 'NSE', 'Equity', 'IT', '', '', 'Sample row — ignored on import. Delete or overwrite it.'],
    },
  };

  const MODES   = { both: 'both', 'real + paper': 'both', 'real+paper': 'both', real: 'real', 'real only': 'real', paper: 'paper', 'paper only': 'paper' };
  const TYPES   = { equity: 'Equity', delivery: 'Equity', cnc: 'Equity', intraday: 'Intraday', mis: 'Intraday', futures: 'Futures', future: 'Futures', fut: 'Futures' };
  const EXCH    = { nse: 'NSE', bse: 'BSE' };
  // Stages a position can be imported at. Beyond 2R the engine catches up by itself (5R / 10R fire live).
  const STAGES_IN = { '': 1, entry: 1, entered: 1, s1: 1, '0r': 1, '1r': 2, s2: 2, '2r': 3, s3: 3,
    s1entered: 1, s21radded: 2, s32rlocked: 3 };
  const MONTHS  = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // ── Cell helpers ───────────────────────────────────────────────────────────
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/[*_]/g, ' ').replace(/\(.*?\)/g, '').replace(/[₹:]/g, '').replace(/\s+/g, ' ').trim();
  const text = v => String(v ?? '').trim();
  const isBlankRow = r => !r || r.every(c => text(c) === '');

  /** Number from a cell: accepts 1,500.50 / ₹1500 / " 1500 ". Blank → null; junk → NaN. */
  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    const s = text(v).replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
    if (s === '') return null;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  /**
   * Date from a cell → 'YYYY-MM-DD' or null. Accepts Excel serials, DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY,
   * YYYY-MM-DD, DD-MMM-YYYY / DD MMM YYYY (e.g. 05-Sep-2026). Day comes first (Indian format).
   */
  function parseDate(v) {
    const ok = (y, m, d) => {
      if (y < 100) y += 2000;
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };
    if (typeof v === 'number' && isFinite(v)) {
      if (v < 20000 || v > 80000) return null;                        // plausible Excel serial (1954–2119)
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return ok(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    const s = text(v);
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/))) return ok(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)))          return ok(+m[3], +m[2], +m[1]);
    if ((m = s.match(/^(\d{1,2})[-/. ]([a-z]{3,4})[a-z]*[-/., ]+(\d{2,4})$/i)) && MONTHS[m[2].toLowerCase()])
      return ok(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    if (/^\d+(\.\d+)?$/.test(s)) return parseDate(Number(s));       // serial typed as text (CSV)
    return null;
  }

  // ── Header mapping ─────────────────────────────────────────────────────────
  /**
   * Find the header row (first row naming every required column, within the first 10 rows) and
   * map column keys to indexes. Returns { headerIndex, map, missing, unknown }.
   */
  function mapHeader(rows, kind) {
    const cols = TEMPLATES[kind].columns;
    const lookup = {};
    cols.forEach(c => [c.label, c.key, ...(c.aliases || [])].forEach(n => { lookup[norm(n)] = c.key; }));
    let best = { headerIndex: -1, map: {}, missing: cols.filter(c => c.required).map(c => c.label), unknown: [] };
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const map = {}, unknown = [];
      (rows[i] || []).forEach((cell, ci) => {
        const n = norm(cell);
        if (!n) return;
        const key = lookup[n];
        if (key && map[key] === undefined) map[key] = ci; else if (!key) unknown.push(text(cell));
      });
      const missing = cols.filter(c => c.required && map[c.key] === undefined).map(c => c.label);
      if (missing.length < best.missing.length) best = { headerIndex: i, map, missing, unknown };
      if (!missing.length) break;
    }
    return best;
  }

  /** Rows after the header as objects keyed by column key, with their 1-based sheet row number. */
  function rowObjects(rows, kind) {
    const h = mapHeader(rows, kind);
    if (h.missing.length) return { error: `Missing column(s): ${h.missing.join(', ')}. Use the template's header row.`, header: h, items: [] };
    const items = [];
    for (let i = h.headerIndex + 1; i < rows.length; i++) {
      const r = rows[i];
      if (isBlankRow(r)) continue;
      const o = { _row: i + 1 };
      Object.entries(h.map).forEach(([k, ci]) => { o[k] = r[ci]; });
      if (text(o.symbol).toUpperCase() === EXAMPLE_SYMBOL) continue;
      items.push(o);
    }
    return { error: null, header: h, items };
  }

  const cleanSymbol = v => text(v).toUpperCase().replace(/^(NSE|BSE):/, '').replace(/\.(NS|BO)$/, '').replace(/\s+/g, '');

  // ── Watchlist ──────────────────────────────────────────────────────────────
  /**
   * @param rows      sheet rows (arrays)
   * @param existing  current watchlist items (db shape)
   * @param opts      { defaultRpt, updateExisting }
   * @returns { error, rows: [{ row, symbol, ok, action:'add'|'update'|'skip', errors[], warnings[], item }] }
   */
  function validateWatchlist(rows, existing = [], opts = {}) {
    const parsed = rowObjects(rows, 'watchlist');
    if (parsed.error) return { error: parsed.error, rows: [] };
    const active = new Map((existing || []).filter(w => w.status !== 'executed').map(w => [String(w.symbol).toUpperCase(), w]));
    const seen = new Set();
    const out = parsed.items.map(o => {
      const errors = [], warnings = [];
      const symbol = cleanSymbol(o.symbol);
      const trigger = parseNumber(o.trigger), stop = parseNumber(o.stop), rpt = parseNumber(o.rpt);
      const modeRaw = norm(o.mode), mode = modeRaw ? MODES[modeRaw] : 'both';
      if (!symbol) errors.push('Symbol is blank');
      else if (!/^[A-Z0-9&\-]+$/.test(symbol)) errors.push(`Symbol "${symbol}" has invalid characters`);
      if (!(trigger > 0)) errors.push('Trigger must be a number above 0');
      if (!(stop > 0)) errors.push('Stop must be a number above 0');
      if (trigger > 0 && stop > 0 && stop >= trigger) errors.push('Stop must be below Trigger');
      if (Number.isNaN(rpt) || (rpt !== null && rpt <= 0)) errors.push('RPT must be a positive number or blank');
      if (!mode) errors.push(`Mode "${text(o.mode)}" — use Real, Paper or Both`);
      if (symbol && seen.has(symbol)) errors.push('Duplicate symbol in this file');
      if (symbol) seen.add(symbol);
      if (trigger > 0 && stop > 0 && stop < trigger && (trigger - stop) / trigger > 0.2) warnings.push(`Stop is ${((trigger - stop) / trigger * 100).toFixed(1)}% below trigger`);

      const prev = symbol ? active.get(symbol) : null;
      let action = 'add';
      if (prev && !errors.length) {
        if (opts.updateExisting) { action = 'update'; warnings.push(`Will update existing ${symbol} (${prev.status})`); }
        else { action = 'skip'; warnings.push('Already on watchlist — skipped'); }
      }
      const item = errors.length ? null : {
        ...(action === 'update' ? prev : {}),
        symbol, trigger_price: trigger, stop_loss: stop,
        sector: text(o.sector) || (action === 'update' ? prev.sector : null) || null,
        notes:  text(o.notes)  || (action === 'update' ? prev.notes  : null) || null,
        rpt:    rpt || null,
        mode,
        status: action === 'update' ? prev.status : 'monitoring',
      };
      return { row: o._row, symbol, ok: !errors.length && action !== 'skip', action: errors.length ? 'error' : action, errors, warnings, item };
    });
    return { error: null, rows: out, unknownColumns: parsed.header.unknown };
  }

  // ── Positions ──────────────────────────────────────────────────────────────
  /**
   * @param rows      sheet rows
   * @param openTrades current open real trades (for duplicate check)
   * @param opts      { playbooks: [{id,name,currentVersion}], today: 'YYYY-MM-DD' }
   * @returns { error, rows: [{ row, symbol, ok, action:'add'|'skip'|'error', errors[], warnings[], pos }] }
   *   pos = { symbol, date, price, qty, initialStop, currentStop, stage, exchange, tradeType, sector, playbookId, playbookVersion, charges|null, notes }
   */
  function validatePositions(rows, openTrades = [], opts = {}) {
    const parsed = rowObjects(rows, 'positions');
    if (parsed.error) return { error: parsed.error, rows: [] };
    const open = new Set((openTrades || []).map(t => String(t.symbol).toUpperCase()));
    const pbs = new Map((opts.playbooks || []).map(p => [norm(p.name), p]));
    const today = opts.today || new Date().toISOString().slice(0, 10);
    const seen = new Set();
    const out = parsed.items.map(o => {
      const errors = [], warnings = [];
      const symbol = cleanSymbol(o.symbol);
      const date = parseDate(o.date);
      const price = parseNumber(o.price), qty = parseNumber(o.qty);
      const initialStop = parseNumber(o.initialStop), cs = parseNumber(o.currentStop), charges = parseNumber(o.charges);
      const stageKey = norm(o.stage).replace(/\s+/g, '');
      const stage = STAGES_IN[stageKey];
      const exchange = norm(o.exchange) ? EXCH[norm(o.exchange)] : 'NSE';
      const tradeType = norm(o.type) ? TYPES[norm(o.type)] : 'Equity';

      if (!symbol) errors.push('Symbol is blank');
      else if (!/^[A-Z0-9&\-]+$/.test(symbol)) errors.push(`Symbol "${symbol}" has invalid characters`);
      if (!date) errors.push(`Entry Date "${text(o.date)}" not understood — use DD-MM-YYYY`);
      else if (date > today) errors.push('Entry Date is in the future');
      if (!(price > 0)) errors.push('Entry Price must be a number above 0');
      if (!(qty > 0) || !Number.isInteger(qty)) errors.push('Qty must be a whole number above 0');
      if (!(initialStop > 0)) errors.push('Initial Stop must be a number above 0');
      if (price > 0 && initialStop > 0 && initialStop >= price) errors.push('Initial Stop must be below Entry Price (long trades only)');
      if (Number.isNaN(cs) || (cs !== null && cs <= 0)) errors.push('Current Stop must be a positive number or blank');
      if (cs > 0 && initialStop > 0 && cs < initialStop) errors.push('Current Stop cannot be below Initial Stop');
      if (Number.isNaN(charges) || (charges !== null && charges < 0)) errors.push('Charges must be a number ≥ 0 or blank');
      if (stage === undefined) errors.push(`Stage "${text(o.stage)}" — use Entry, 1R or 2R (blank = Entry)`);
      if (!exchange) errors.push(`Exchange "${text(o.exchange)}" — use NSE or BSE`);
      if (!tradeType) errors.push(`Type "${text(o.type)}" — use Equity, Intraday or Futures`);
      let pb = null;
      if (text(o.playbook)) {
        pb = pbs.get(norm(o.playbook)) || null;
        if (!pb) warnings.push(`Playbook "${text(o.playbook)}" not found among active playbooks — left blank`);
      }
      if (symbol && seen.has(symbol)) errors.push('Duplicate symbol in this file');
      if (symbol) seen.add(symbol);
      if (cs > 0 && price > 0 && cs >= price && (stage === 1)) warnings.push('Current Stop is at/above entry while Stage is Entry — consider Stage 1R or 2R');

      let action = errors.length ? 'error' : 'add';
      if (action === 'add' && open.has(symbol)) { action = 'skip'; warnings.push('Already an open position — skipped'); }
      const pos = errors.length ? null : {
        symbol, date, price, qty, initialStop,
        currentStop: cs > 0 ? cs : initialStop,
        stage, exchange, tradeType,
        sector: text(o.sector) || 'Other',
        playbookId: pb ? pb.id : '', playbookVersion: pb ? (pb.currentVersion || '1.0') : '',
        charges: charges === null ? null : charges,
        notes: text(o.notes),
      };
      return { row: o._row, symbol, ok: action === 'add', action, errors, warnings, pos };
    });
    return { error: null, rows: out, unknownColumns: parsed.header.unknown };
  }

  /**
   * Lifecycle state for an imported position, using the same engine as a manual New Trade.
   * Stage Entry → fresh state. Stage 1R / 2R → the stage is set and the hard stop is raised to
   * at least what that stage's rule would have set (1R: initial + stopRaiseAt1R·R; 2R: entry price),
   * never below the Current Stop from the sheet. Later targets (5R, 10R) fire live as usual.
   * Needs TLMEngine / TLMRules / TLMIndicators loaded (globals).
   * @returns { state, stop, raised } — stop is the effective hard stop; raised=true if above the sheet's stop.
   */
  function planImportState(pos, params, now) {
    const E = root.TLMEngine, Rr = root.TLMRules, I = root.TLMIndicators;
    const S = Rr.STAGES;
    const p = Object.assign({}, Rr.DEFAULT_PARAMS, params || {});
    // A 1R+ position already holds the 1R add (same qty as the first leg), so the first leg is half.
    const firstQty = pos.stage >= S.R1 ? Math.max(1, Math.floor(pos.qty / 2)) : pos.qty;
    const state = E.createState({ entryPrice: pos.price, firstQty, initialStop: pos.initialStop, params: p, now });
    if (!state) return { state: null, stop: pos.currentStop, raised: false };
    state.stage = pos.stage;
    let floor = pos.initialStop;
    const plan = Rr.planOf(state);
    if (pos.stage >= S.R1 && plan.T1.on) floor = Math.max(floor, I.roundTick(pos.initialStop + p.stopRaiseAt1R * state.r));
    if (pos.stage >= S.R2 && plan.T2.on) floor = Math.max(floor, I.roundTick(pos.price));
    const stop = Math.max(floor, pos.currentStop || 0);
    state.hardStop = Math.round(stop * 100) / 100;
    return { state, stop: state.hardStop, raised: state.hardStop > (pos.currentStop || 0) + 1e-9 };
  }

  /** Template rows (header + one sample row that import ignores). */
  function templateRows(kind) {
    const t = TEMPLATES[kind];
    return [t.columns.map(c => c.label + (c.required ? ' *' : '')), t.example];
  }

  const api = { TEMPLATES, EXAMPLE_SYMBOL, parseNumber, parseDate, mapHeader, validateWatchlist, validatePositions, planImportState, templateRows, cleanSymbol };
  root.ImportRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
