/**
 * export/pdf-lite.js — small PDF writer (A4, Helvetica, JPEG images, rectangles and lines).
 * Enough for the Chartbook export; no third-party library. Coordinates are in points from the TOP-left.
 *
 *   const pdf = PdfLite.create();
 *   pdf.addPage();
 *   pdf.text(40, 60, 'Hello', { size: 14, bold: true, color: [0.1, 0.1, 0.1] });
 *   pdf.image(jpegBytes, pixelW, pixelH, 40, 80, 515, 220);
 *   const bytes = pdf.save();            // Uint8Array
 */
(function (root) {
  const W = 595.28, H = 841.89;          // A4 in points

  /** Standard fonts use WinAnsi: keep Latin-1, map common symbols, replace the rest. */
  function winAnsi(s) {
    return String(s ?? '')
      .replace(/₹/g, 'Rs ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/…/g, '...').replace(/[→⟶]/g, '->').replace(/[·•]/g, '·').replace(/≥/g, '>=').replace(/≤/g, '<=')
      .replace(/[^\x20-\x7e -ÿ]/g, '?');
  }
  const esc = s => winAnsi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const f = n => (Math.round(n * 100) / 100).toString();
  const rgb = c => (c || [0, 0, 0]).map(v => f(v)).join(' ');

  // Helvetica widths (1/1000 em) for ASCII 32..126 — used to measure and wrap text.
  const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
  const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
  function width(s, size, bold) {
    const t = bold ? HELVB : HELV;
    let w = 0;
    for (const ch of winAnsi(s)) { const c = ch.charCodeAt(0); w += (c >= 32 && c <= 126 ? t[c - 32] : 556); }
    return w * size / 1000;
  }
  /** Split text into lines no wider than maxW. */
  function wrap(s, size, maxW, bold) {
    const out = [];
    for (const para of String(s ?? '').split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const t = line ? line + ' ' + word : word;
        if (width(t, size, bold) <= maxW || !line) line = t; else { out.push(line); line = word; }
      }
      out.push(line);
    }
    return out;
  }

  function create() {
    const pages = [];   // { ops: [], images: Set }
    const images = [];  // { bytes, w, h }
    let cur = null;
    const te = new TextEncoder();

    const api = {
      W, H, width, wrap,
      addPage() { cur = { ops: [], images: new Set() }; pages.push(cur); return api; },
      text(x, y, s, { size = 10, bold = false, color } = {}) {
        cur.ops.push(`BT /${bold ? 'F2' : 'F1'} ${f(size)} Tf ${rgb(color)} rg ${f(x)} ${f(H - y)} Td (${esc(s)}) Tj ET`);
        return api;
      },
      /** Wrapped text; returns the y below the last line. */
      textBox(x, y, w, s, { size = 10, bold = false, color, lineGap = 1.35 } = {}) {
        for (const ln of wrap(s, size, w, bold)) { api.text(x, y, ln, { size, bold, color }); y += size * lineGap; }
        return y;
      },
      rect(x, y, w, h, { fill, stroke, lineWidth = 0.75 } = {}) {
        const parts = [];
        if (fill) parts.push(`${rgb(fill)} rg`);
        if (stroke) parts.push(`${rgb(stroke)} RG ${f(lineWidth)} w`);
        parts.push(`${f(x)} ${f(H - y - h)} ${f(w)} ${f(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
        cur.ops.push(parts.join(' '));
        return api;
      },
      line(x1, y1, x2, y2, { color = [0.85, 0.87, 0.9], lineWidth = 0.75 } = {}) {
        cur.ops.push(`${rgb(color)} RG ${f(lineWidth)} w ${f(x1)} ${f(H - y1)} m ${f(x2)} ${f(H - y2)} l S`);
        return api;
      },
      /** JPEG bytes (Uint8Array) of pixel size pw×ph, drawn into the box x,y,w,h. */
      image(bytes, pw, ph, x, y, w, h) {
        images.push({ bytes, w: pw, h: ph });
        const name = `Im${images.length}`;
        cur.images.add(name);
        cur.ops.push(`q ${f(w)} 0 0 ${f(h)} ${f(x)} ${f(H - y - h)} cm /${name} Do Q`);
        return api;
      },
      save() {
        const chunks = []; let len = 0; const offsets = [];
        const push = b => { const u = typeof b === 'string' ? te.encode(b) : b; chunks.push(u); len += u.length; };
        const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
        push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
        // 1 catalog, 2 pages, 3 F1, 4 F2, then images, then page + content pairs
        const imgBase = 5, pageBase = imgBase + images.length;
        const pageIds = pages.map((_, i) => pageBase + i * 2);
        obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
        obj(2, () => push(`<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pages.length} >>`));
        obj(3, () => push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
        obj(4, () => push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
        images.forEach((im, i) => obj(imgBase + i, () => {
          push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`);
          push(im.bytes); push('\nendstream');
        }));
        pages.forEach((pg, i) => {
          const pid = pageIds[i], cid = pid + 1;
          const xo = [...pg.images].map(n => `/${n} ${imgBase + Number(n.slice(2)) - 1} 0 R`).join(' ');
          obj(pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Contents ${cid} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo ? ` /XObject << ${xo} >>` : ''} >> >>`));
          const content = latin1(pg.ops.join('\n'));
          obj(cid, () => { push(`<< /Length ${content.length} >>\nstream\n`); push(content); push('\nendstream'); });
        });
        const total = pageBase + pages.length * 2;
        const xref = len;
        let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
        for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
        push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
        const out = new Uint8Array(len); let p = 0;
        for (const c of chunks) { out.set(c, p); p += c.length; }
        return out;
      },
    };
    return api;
  }

  /** Content streams are Latin-1 bytes (WinAnsi), not UTF-8. */
  function latin1(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }

  /** data:image/jpeg;base64,... → Uint8Array */
  function dataUrlBytes(url) {
    const b64 = String(url).split(',')[1] || '';
    if (typeof atob === 'function') { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  const api = { create, width, wrap, winAnsi, dataUrlBytes, W, H };
  root.PdfLite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
