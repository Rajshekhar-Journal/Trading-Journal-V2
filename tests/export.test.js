/**
 * Chartbook export tests — run with:  npm test
 * The PDF and Word writers produce structurally valid files (offsets, parts, embedded images).
 * (Visual check during development: pypdf / python-docx / LibreOffice render the same files.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
require('../js/import/xlsx-lite.js');
const P = require('../js/export/pdf-lite.js');
require('../js/export/docx-lite.js');
const E = require('../js/export/chartbook-export.js');

const jpg = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/chart.jpg')));
const item = {
  t: { symbol: 'MARINE', sector: 'Shipping', initialStop: 417, entries: [{ date: '2026-10-05', price: 451, qty: 166 }],
       pyramids: [{ date: '2026-10-09', price: 485, qty: 166 }], stopRevisions: [{ date: '2026-10-09', oldStop: 417, newStop: 434 }],
       partialExits: [], finalExit: { date: '2026-10-28', price: 560, qty: 332 } },
  mode: 'real', m: { avgEntryPrice: 468, avgExitPrice: 560, totalBuyQty: 332, holdingDays: 23, currentStop: 434 },
  r: 2.5, pnl: 30544, status: 'Win', playbook: 'VCP', notes: 'Lesson — trail tighter after a climax bar (₹ test).', exitDate: '2026-10-28',
};
const charts = [{ label: 'Entry chart', bytes: jpg, w: 1100, h: 460 }, { label: 'Exit chart', missing: 'none' }];

test('timeline: events in date order with readable details', () => {
  const tl = E.timeline(item.t);
  assert.deepEqual(tl.map(r => r[1]), ['Entry', '1R add', 'Stop moved', 'Exit']);
  assert.match(tl[2][2], /Rs 417\.00 -> Rs 434\.00/);
});

test('PDF: valid header, xref offsets point at objects, one page per trade + cover, image embedded', () => {
  const md = E.buildModel(item, charts);
  const bytes = E.toPdf([md, md], { summary: [['Trades', '2']] });
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.equal((s.match(/\/Type \/Page\b/g) || []).length, 3);
  assert.equal((s.match(/\/Subtype \/Image/g) || []).length, 2);
  const xref = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.ok(s.slice(xref).startsWith('xref'));
  const offs = [...s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  offs.forEach((o, i) => assert.ok(s.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`));
  assert.ok(s.includes('\\(Rs  test\\)') && !s.includes('\u20b9'), 'rupee sign written as Rs (standard PDF fonts have no ₹)');
});

test('DOCX: zip with document, styles, relationships and the image', () => {
  const bytes = E.toDocx([E.buildModel(item, charts)], { summary: [['Trades', '1']] });
  const s = Buffer.from(bytes).toString('latin1');
  assert.equal(s.slice(0, 2), 'PK');
  for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'word/media/image1.jpeg']) {
    assert.ok(s.includes(part), part);
  }
  assert.ok(s.includes('r:embed="rIdImg1"'));
  assert.ok(Buffer.from(bytes).includes(Buffer.from(jpg.slice(0, 64))), 'JPEG stored unchanged');
});

test('PDF text wrap respects the width', () => {
  const lines = P.wrap('one two three four five six seven eight nine ten', 10, 60);
  assert.ok(lines.length > 1);
  lines.forEach(l => assert.ok(P.width(l, 10) <= 60 || !l.includes(' ')));
});
