/**
 * Tests for Excel/CSV import — run with:  node --test tests/
 * Fixtures in tests/fixtures/ were written by openpyxl (real Excel-style files: shared strings, date cells).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../js/engine/indicators.js');
require('../js/engine/tlm-rules.js');
require('../js/engine/tlm-engine.js');
const X = require('../js/import/xlsx-lite.js');
const IR = require('../js/import/import-rules.js');
const { STAGES } = require('../js/engine/tlm-rules.js');

const fixture = name => { const b = fs.readFileSync(path.join(__dirname, 'fixtures', name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const TODAY = '2026-10-01';

test('parseDate: Indian formats, ISO, month names, Excel serials; rejects invalid', () => {
  assert.equal(IR.parseDate('15-09-2026'), '2026-09-15');
  assert.equal(IR.parseDate('5/9/2026'), '2026-09-05');
  assert.equal(IR.parseDate('2026-09-05'), '2026-09-05');
  assert.equal(IR.parseDate('05-Sep-2026'), '2026-09-05');
  assert.equal(IR.parseDate('5 Sept 26'), '2026-09-05');
  assert.equal(IR.parseDate(46280), '2026-09-15');
  assert.equal(IR.parseDate('31-02-2026'), null);
  assert.equal(IR.parseDate('hello'), null);
});

test('parseNumber: commas, rupee sign, blanks, junk', () => {
  assert.equal(IR.parseNumber('1,500.50'), 1500.5);
  assert.equal(IR.parseNumber('₹ 2,000'), 2000);
  assert.equal(IR.parseNumber(''), null);
  assert.ok(Number.isNaN(IR.parseNumber('abc')));
});

test('xlsx reader: openpyxl positions file → rows with dates as serials', async () => {
  const rows = await X.readXlsx(fixture('positions_sample.xlsx'));
  assert.equal(rows[1][0], 'Symbol *');
  assert.equal(rows[3][0], 'RELIANCE');
  assert.equal(IR.parseDate(rows[3][1]), '2026-09-10');
});

test('positions: header found below a title row; valid, skipped and error rows', async () => {
  const rows = await X.readXlsx(fixture('positions_sample.xlsx'));
  const res = IR.validatePositions(rows, [{ symbol: 'INFY' }], { playbooks: [{ id: 'pb1', name: 'VCP', currentVersion: '2.0' }], today: TODAY });
  assert.equal(res.error, null);
  assert.deepEqual(res.unknownColumns, ['My column']);
  const by = Object.fromEntries(res.rows.map(r => [r.row + ':' + r.symbol, r]));
  const rel = by['4:RELIANCE'];
  assert.ok(rel.ok);
  assert.equal(rel.pos.playbookId, 'pb1');
  assert.equal(rel.pos.stage, STAGES.ENTERED);
  assert.equal(rel.pos.charges, null);
  const tcs = by['5:TCS'];
  assert.ok(tcs.ok, JSON.stringify(tcs.errors));
  assert.equal(tcs.pos.price, 4100);
  assert.equal(tcs.pos.exchange, 'BSE');
  assert.equal(tcs.pos.tradeType, 'Equity');
  assert.equal(tcs.pos.stage, STAGES.R1);
  assert.equal(tcs.pos.currentStop, 4050);
  assert.equal(by['6:INFY'].action, 'skip');                      // already open
  const bad = by['7:BAD'];
  assert.equal(bad.action, 'error');
  assert.ok(bad.errors.length >= 5, bad.errors.join(' | '));
  assert.equal(by['9:RELIANCE'].action, 'error');                 // duplicate in file
  assert.ok(!res.rows.some(r => r.symbol === 'EXAMPLE'));
});

test('positions: missing required column is reported', () => {
  const res = IR.validatePositions([['Symbol', 'Qty'], ['ABC', 1]], [], { today: TODAY });
  assert.match(res.error, /Entry Date, Entry Price, Initial Stop/);
});

test('planImportState: Entry fresh, 1R raises stop by 0.5R and halves first leg, 2R locks at entry', () => {
  const base = { price: 100, qty: 20, initialStop: 90, currentStop: 90 };
  const e = IR.planImportState({ ...base, stage: STAGES.ENTERED }, {}, 0);
  assert.equal(e.state.stage, STAGES.ENTERED); assert.equal(e.stop, 90); assert.equal(e.raised, false); assert.equal(e.state.firstQty, 20);
  const r1 = IR.planImportState({ ...base, stage: STAGES.R1 }, {}, 0);
  assert.equal(r1.stop, 95); assert.equal(r1.raised, true); assert.equal(r1.state.firstQty, 10);
  const r1b = IR.planImportState({ ...base, stage: STAGES.R1, currentStop: 97 }, {}, 0);
  assert.equal(r1b.stop, 97); assert.equal(r1b.raised, false);
  const r2 = IR.planImportState({ ...base, stage: STAGES.R2 }, {}, 0);
  assert.equal(r2.stop, 100); assert.equal(r2.state.hardStop, 100);
  const off = IR.planImportState({ ...base, stage: STAGES.R1 }, { enable1R: false }, 0);
  assert.equal(off.stop, 90);                                     // 1R target switched off → no raise
});

test('watchlist: aliases, modes, stop below trigger, existing skip / update', async () => {
  const rows = await X.readXlsx(fixture('watchlist_sample.xlsx'));
  const existing = [{ id: 'w1', symbol: 'SBIN', status: 'monitoring', sector: 'Banking' }];
  const res = IR.validateWatchlist(rows, existing, {});
  const by = Object.fromEntries(res.rows.map(r => [r.symbol, r]));
  assert.ok(by.HDFCBANK.ok); assert.equal(by.HDFCBANK.item.mode, 'paper');
  assert.equal(by.ITC.action, 'error');                           // stop above trigger
  assert.equal(by.SBIN.action, 'skip');
  assert.equal(by.LT.action, 'error');                            // unknown mode
  const upd = IR.validateWatchlist(rows, existing, { updateExisting: true });
  const s = upd.rows.find(r => r.symbol === 'SBIN');
  assert.equal(s.action, 'update'); assert.equal(s.item.id, 'w1'); assert.equal(s.item.rpt, 5000); assert.equal(s.item.sector, 'Banking');
});

test('template round-trip: writer output is read back and the EXAMPLE row is ignored', async () => {
  for (const kind of ['watchlist', 'positions']) {
    const t = IR.TEMPLATES[kind];
    const bytes = X.writeXlsx(IR.templateRows(kind), t.sheet, t.columns.map(c => c.width));
    const rows = await X.readXlsx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.equal(rows[0].length, t.columns.length);
    const res = kind === 'watchlist' ? IR.validateWatchlist(rows, []) : IR.validatePositions(rows, [], { today: TODAY });
    assert.equal(res.error, null);
    assert.equal(res.rows.length, 0);
  }
});

test('CSV: quoted commas and Excel serial text', () => {
  const rows = X.parseCsv('Symbol,Trigger,Stop,Notes\nABC,"1,200",1100,"cup, handle"\n');
  const res = IR.validateWatchlist(rows, []);
  assert.ok(res.rows[0].ok);
  assert.equal(res.rows[0].item.trigger_price, 1200);
  assert.equal(res.rows[0].item.notes, 'cup, handle');
});
