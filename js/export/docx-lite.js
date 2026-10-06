/**
 * export/docx-lite.js — small Word (.docx) writer: headings, paragraphs, tables, JPEG/PNG images,
 * page breaks. A4 portrait. Zipped with XlsxLite.zip (same in-house zip writer as the Excel templates).
 *
 *   const doc = DocxLite.create();
 *   doc.heading('Title', 1); doc.para('text', { bold: true }); doc.table([['A','B'],['1','2']], { header: true });
 *   doc.image(jpegBytes, 1000, 420, 6.5);   // pixel size, width in inches
 *   const bytes = doc.save();               // Uint8Array
 */
(function (root) {
  const x = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const EMU = 914400;   // per inch

  function run(text, { bold, size, color, italic } = {}) {
    const pr = [bold ? '<w:b/>' : '', italic ? '<w:i/>' : '', color ? `<w:color w:val="${color}"/>` : '', size ? `<w:sz w:val="${Math.round(size * 2)}"/>` : ''].join('');
    return String(text ?? '').split('\n').map((ln, i) => `${i ? '<w:r><w:br/></w:r>' : ''}<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(ln)}</w:t></w:r>`).join('');
  }

  function create() {
    const body = [];
    const media = [];   // { name, bytes, ext }
    const api = {
      heading(text, level = 1) { body.push(`<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${run(text)}</w:p>`); return api; },
      para(text, opts = {}) {
        const sp = opts.spaceAfter != null ? `<w:spacing w:after="${opts.spaceAfter * 20}"/>` : '';
        body.push(`<w:p>${sp ? `<w:pPr>${sp}</w:pPr>` : ''}${run(text, opts)}</w:p>`);
        return api;
      },
      /** rows: array of arrays of strings. widths in inches (optional). */
      table(rows, { header = false, widths } = {}) {
        const cols = Math.max(...rows.map(r => r.length));
        const grid = (widths || Array(cols).fill(6.9 / cols)).map(w => `<w:gridCol w:w="${Math.round(w * 1440)}"/>`).join('');
        const tr = rows.map((r, ri) => `<w:tr>${r.map((c, ci) => {
          const w = widths ? `<w:tcW w:w="${Math.round(widths[ci] * 1440)}" w:type="dxa"/>` : '';
          const shade = header && ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF2F7"/>' : '';
          return `<w:tc><w:tcPr>${w}${shade}</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(c, { bold: header && ri === 0, size: 9 })}</w:p></w:tc>`;
        }).join('')}</w:tr>`).join('');
        body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${tr}</w:tbl>`);
        body.push('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>');
        return api;
      },
      /** Image bytes (JPEG or PNG) of pixel size pw×ph, shown `inches` wide. */
      image(bytes, pw, ph, inches = 6.5, ext = 'jpeg') {
        const n = media.length + 1, rid = `rIdImg${n}`;
        media.push({ name: `image${n}.${ext}`, bytes, ext, rid });
        const cx = Math.round(inches * EMU), cy = Math.round(inches * EMU * ph / pw);
        body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Chart ${n}"/>` +
          `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
          `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr>` +
          `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
          `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
          `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`);
        return api;
      },
      pageBreak() { body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); return api; },
      save() {
        const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
        const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="864" w:right="864" w:bottom="864" w:left="864" w:header="432" w:footer="432" w:gutter="0"/></w:sectPr>';
        const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body.join('')}${sect}</w:body></w:document>`;
        const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="1E293B"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="334155"/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9DEE5"/><w:left w:val="single" w:sz="4" w:color="D9DEE5"/><w:bottom w:val="single" w:sz="4" w:color="D9DEE5"/><w:right w:val="single" w:sz="4" w:color="D9DEE5"/><w:insideH w:val="single" w:sz="4" w:color="D9DEE5"/><w:insideV w:val="single" w:sz="4" w:color="D9DEE5"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
        const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map(m => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')}</Relationships>`;
        const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
        const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
        const Z = root.XlsxLite || (typeof require === 'function' ? require('../import/xlsx-lite.js') : null);
        return Z.zip([
          ['[Content_Types].xml', types], ['_rels/.rels', rootRels],
          ['word/document.xml', doc], ['word/styles.xml', styles], ['word/_rels/document.xml.rels', rels],
          ...media.map(m => [`word/media/${m.name}`, m.bytes]),
        ]);
      },
    };
    return api;
  }

  const api = { create };
  root.DocxLite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
