/**
 * import/xlsx-lite.js — minimal Excel (.xlsx) and CSV reader/writer, no third-party library.
 *
 * Reads the FIRST worksheet of an .xlsx file into rows (arrays of cell values) and writes a
 * simple one-sheet .xlsx (used for import templates). Decompression uses the browser's built-in
 * DecompressionStream ('deflate-raw'), available in current Chrome, Edge, Firefox and Safari,
 * and in Node 18+ (unit tests).
 */
(function (root) {
  const td = new TextDecoder('utf-8');
  const te = new TextEncoder();

  // ── ZIP reading ──────────────────────────────────────────────────────────
  async function _inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Map of entry name → async () => Uint8Array, from the zip central directory. */
  function _zipEntries(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .xlsx file (zip directory not found).');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt .xlsx file.');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
      entries[name] = async () => {
        const lnameLen = dv.getUint16(local + 26, true), lextraLen = dv.getUint16(local + 28, true);
        const start = local + 30 + lnameLen + lextraLen;
        const data = u8.subarray(start, start + csize);
        if (method === 0) return data;
        if (method === 8) return _inflateRaw(data);
        throw new Error('Unsupported compression in .xlsx file.');
      };
      p += 46 + nameLen + extraLen + commLen;
    }
    return entries;
  }

  // ── XML helpers (regex-based: worksheet XML is regular and machine-written) ──
  const _unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
  const _texts = xml => [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => _unxml(m[1])).join('');
  const _colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

  /** Read the first worksheet of an .xlsx file → array of rows (each an array of strings/numbers/booleans). */
  async function readXlsx(arrayBuffer) {
    const z = _zipEntries(arrayBuffer);
    const text = async name => (z[name] ? td.decode(await z[name]()) : '');

    // First sheet's file, via workbook.xml → workbook.xml.rels
    const wb = await text('xl/workbook.xml');
    const firstRid = (wb.match(/<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/) || [])[1];
    const rels = await text('xl/_rels/workbook.xml.rels');
    let target = 'worksheets/sheet1.xml';
    if (firstRid) {
      const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => r.includes(`Id="${firstRid}"`));
      const t = rel && (rel.match(/Target="([^"]+)"/) || [])[1];
      if (t) target = t.replace(/^\/?xl\//, '');
    }
    const sheet = await text('xl/' + target.replace(/^\//, ''));
    if (!sheet) throw new Error('The workbook has no readable worksheet.');

    const shared = [...(await text('xl/sharedStrings.xml')).matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => _texts(m[1]));

    const rows = [];
    for (const rm of sheet.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = cm[1], inner = cm[2] || '';
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const type = (attrs.match(/\bt="(\w+)"/) || [])[1] || 'n';
        const v = (inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
        let val = '';
        if (type === 's') val = shared[+v] ?? '';
        else if (type === 'inlineStr') val = _texts(inner);
        else if (type === 'str' || type === 'e') val = v != null ? _unxml(v) : '';
        else if (type === 'b') val = v === '1';
        else val = v != null && v !== '' ? Number(v) : '';
        row[ref ? _colIndex(ref) : row.length] = val;
      }
      rows.push(Array.from(row, x => (x === undefined ? '' : x)));
    }
    return rows;
  }

  /** Parse CSV text (quotes, commas inside quotes, CRLF) → array of rows. */
  function parseCsv(text) {
    const rows = []; let row = [], field = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') q = false;
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  // ── ZIP writing (stored, no compression) ──────────────────────────────────
  const _crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const _crc32 = u8 => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  function _zip(files) {
    const parts = [], central = []; let offset = 0;
    for (const [name, content] of files) {
      const nameB = te.encode(name), data = typeof content === 'string' ? te.encode(content) : content, crc = _crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nameB.length, true);
      parts.push(new Uint8Array(lh.buffer), nameB, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameB);
      offset += 30 + nameB.length + data.length;
    }
    const cdSize = central.reduce((s, a) => s + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0)); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  const _xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const _colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  /** One-sheet .xlsx from rows; the first row is styled bold (header). Returns Uint8Array. */
  function writeXlsx(rows, sheetName = 'Sheet1', colWidths = []) {
    const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = _colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
      return typeof v === 'number' && isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${st}><is><t>${_xml(v ?? '')}</t></is></c>`;
    }).join('')}</row>`).join('');
    const cols = colWidths.length ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    return _zip([
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${_xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
      ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
      ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${sheetRows}</sheetData></worksheet>`],
    ]);
  }

  /** Read a File/Blob (.xlsx or .csv) → rows. */
  async function readFile(file) {
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.csv')) return parseCsv(await file.text());
    if (name.endsWith('.xlsx')) return readXlsx(await file.arrayBuffer());
    if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported — in Excel use File → Save As → Excel Workbook (.xlsx).');
    throw new Error('Choose an .xlsx or .csv file.');
  }

  const api = { readXlsx, parseCsv, writeXlsx, readFile, zip: _zip };
  root.XlsxLite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
