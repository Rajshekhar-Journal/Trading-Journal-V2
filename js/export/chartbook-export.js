/**
 * export/chartbook-export.js — Chartbook → PDF / Word. One trade per page:
 * title, key numbers, entry chart, exit chart, lifecycle timeline, notes & lessons.
 *
 * buildModel() and toPdf() / toDocx() are pure (testable in Node); run() renders the charts in the
 * browser (ChartRender.toImage) and downloads the file.
 */
(function (root) {
  const num = v => Number(v) || 0;
  const inr = v => 'Rs ' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sgn = v => (v >= 0 ? '+' : '-');
  const fmtR = r => `${sgn(r)}${Math.abs(num(r)).toFixed(2)}R`;
  const d10 = d => String(d || '').slice(0, 10);

  /** Lifecycle events in date order: [[date, event, detail]]. */
  function timeline(t) {
    const ev = [];
    (t.entries || []).forEach(e => ev.push([d10(e.date), 'Entry', `Bought ${e.qty} @ ${inr(e.price)}`]));
    (t.pyramids || []).forEach(p => ev.push([d10(p.date), '1R add', `Bought ${p.qty} @ ${inr(p.price)}`]));
    (t.stopRevisions || []).filter(r => num(r.oldStop) > 0).forEach(r => ev.push([d10(r.date), 'Stop moved', `${inr(r.oldStop)} -> ${inr(r.newStop)}`]));
    (t.partialExits || []).forEach(p => ev.push([d10(p.date), 'Partial exit', `Sold ${p.qty} @ ${inr(p.price)}`]));
    if (t.finalExit) ev.push([d10(t.finalExit.date), 'Exit', `Sold ${t.finalExit.qty} @ ${inr(t.finalExit.price)}`]);
    return ev.sort((a, b) => a[0].localeCompare(b[0]));
  }

  /**
   * Page model for one trade.
   * @param item { t: trade, mode, m: calc.getTradeMetrics(t), r, pnl, status: 'Open'|'Win'|'Loss', playbook, notes, exitDate }
   * @param charts [{ label, bytes, w, h }] (JPEG)
   */
  function buildModel(item, charts = []) {
    const { t, mode, m } = item;
    const first = (t.entries || [])[0] || {};
    return {
      title: `${t.symbol}`,
      badge: `${mode === 'paper' ? 'PAPER' : 'REAL'} · ${item.status}`,
      subtitle: [item.playbook, t.sector, `${d10(first.date)} -> ${item.exitDate || 'open'}`, `${m.holdingDays ?? 0} days`].filter(Boolean).join('  ·  '),
      stats: [
        ['Avg entry', inr(m.avgEntryPrice)], ['Avg exit', m.avgExitPrice ? inr(m.avgExitPrice) : '-'],
        ['Qty bought', String(m.totalBuyQty ?? '')], ['Holding days', String(m.holdingDays ?? '')],
        ['Result (R)', fmtR(item.r)], ['P&L', `${sgn(item.pnl)}${inr(Math.abs(item.pnl))}`],
        ['Initial stop', inr(t.initialStop)], ['Last stop', inr(m.currentStop || t.currentStop)],
      ],
      charts,
      timeline: timeline(t),
      notes: item.notes || '',
    };
  }

  // ── PDF ────────────────────────────────────────────────────────────────
  function toPdf(models, meta = {}) {
    const P = root.PdfLite;
    const pdf = P.create();
    const L = 40, R = P.W - 40, CW = R - L;
    const ink = [0.12, 0.16, 0.23], muted = [0.45, 0.5, 0.58], line = [0.85, 0.87, 0.9];

    // Cover
    pdf.addPage();
    pdf.text(L, 90, 'Chartbook', { size: 28, bold: true, color: ink });
    pdf.text(L, 116, meta.subtitle || 'Trade charts and lessons', { size: 12, color: muted });
    let y = 160;
    for (const [k, v] of meta.summary || []) { pdf.text(L, y, k, { size: 11, color: muted }); pdf.text(L + 160, y, v, { size: 11, bold: true, color: ink }); y += 20; }
    pdf.text(L, P.H - 40, `Generated ${meta.generated || new Date().toISOString().slice(0, 10)} · Trading Journal`, { size: 9, color: muted });

    models.forEach((md, pi) => {
      pdf.addPage();
      let y = 50;
      pdf.text(L, y, md.title, { size: 20, bold: true, color: ink });
      const bw = P.width(md.badge, 9, true) + 14, tx = L + P.width(md.title, 20, true) + 10;
      pdf.rect(tx, y - 13, bw, 16, { fill: [0.93, 0.95, 0.98] });
      pdf.text(tx + 7, y - 1, md.badge, { size: 9, bold: true, color: [0.2, 0.3, 0.6] });
      y += 18;
      pdf.text(L, y, md.subtitle, { size: 9.5, color: muted });
      y += 14;
      // Key numbers: 4 columns × 2 rows
      const cw = CW / 4, ch = 30;
      md.stats.forEach(([k, v], i) => {
        const cx = L + (i % 4) * cw, cy = y + Math.floor(i / 4) * (ch + 6);
        pdf.rect(cx + 2, cy, cw - 4, ch, { fill: [0.97, 0.98, 0.99], stroke: line });
        pdf.text(cx + 8, cy + 11, k.toUpperCase(), { size: 7, color: muted });
        pdf.text(cx + 8, cy + 24, v, { size: 10, bold: true, color: ink });
      });
      y += 2 * (ch + 6) + 8;
      // Charts
      for (const c of md.charts) {
        pdf.text(L, y + 9, c.label, { size: 10, bold: true, color: ink });
        y += 14;
        if (c.bytes) {
          const h = CW * c.h / c.w;
          pdf.image(c.bytes, c.w, c.h, L, y, CW, h);
          pdf.rect(L, y, CW, h, { stroke: line });
          y += h + 10;
        } else {
          pdf.rect(L, y, CW, 34, { fill: [0.98, 0.98, 0.99], stroke: line });
          pdf.text(L + 10, y + 21, c.missing || 'No chart saved', { size: 9, color: muted });
          y += 44;
        }
      }
      // Timeline (as many rows as fit above the notes)
      const notesH = md.notes ? Math.min(90, 26 + P.wrap(md.notes, 9, CW - 16).length * 12) : 0;
      const maxY = P.H - 40 - notesH;
      if (md.timeline.length && y + 30 < maxY) {
        pdf.text(L, y + 9, 'Lifecycle', { size: 10, bold: true, color: ink });
        y += 16;
        const rows = md.timeline.slice(0, Math.max(0, Math.floor((maxY - y) / 13)));
        for (const [d, e, det] of rows) {
          pdf.text(L, y + 9, d, { size: 8.5, color: muted });
          pdf.text(L + 70, y + 9, e, { size: 8.5, bold: true, color: ink });
          pdf.text(L + 150, y + 9, det, { size: 8.5, color: ink });
          pdf.line(L, y + 12.5, R, y + 12.5, { color: [0.93, 0.94, 0.96], lineWidth: 0.5 });
          y += 13;
        }
        if (rows.length < md.timeline.length) { pdf.text(L, y + 9, `+ ${md.timeline.length - rows.length} more`, { size: 8, color: muted }); y += 13; }
        y += 8;
      }
      if (md.notes) {
        const top = Math.max(y, P.H - 40 - notesH);
        pdf.rect(L, top, CW, notesH - 6, { fill: [1, 0.98, 0.92], stroke: [0.96, 0.87, 0.6] });
        pdf.text(L + 8, top + 14, 'Notes & lessons', { size: 9, bold: true, color: [0.55, 0.36, 0.05] });
        pdf.textBox(L + 8, top + 27, CW - 16, md.notes, { size: 9, color: ink, lineGap: 1.33 });
      }
      pdf.text(R - 60, P.H - 22, `Page ${pi + 2}`, { size: 8, color: muted });
    });
    return pdf.save();
  }

  // ── Word ───────────────────────────────────────────────────────────────
  function toDocx(models, meta = {}) {
    const doc = root.DocxLite.create();
    doc.heading('Chartbook', 1);
    doc.para(meta.subtitle || 'Trade charts and lessons', { color: '64748B' });
    if ((meta.summary || []).length) doc.table(meta.summary.map(([k, v]) => [k, v]), { widths: [2.4, 4.5] });
    doc.para(`Generated ${meta.generated || new Date().toISOString().slice(0, 10)} · Trading Journal`, { size: 8, color: '94A3B8' });
    for (const md of models) {
      doc.pageBreak();
      doc.heading(`${md.title}   [${md.badge}]`, 1);
      doc.para(md.subtitle, { color: '64748B', size: 9 });
      const st = md.stats;
      doc.table([0, 1, 2, 3].map(i => [st[i][0], st[i][1], st[i + 4][0], st[i + 4][1]]), { widths: [1.5, 1.95, 1.5, 1.95] });
      for (const c of md.charts) {
        doc.heading(c.label, 2);
        if (c.bytes) doc.image(c.bytes, c.w, c.h, 6.9, 'jpeg'); else doc.para(c.missing || 'No chart saved', { italic: true, color: '94A3B8' });
      }
      if (md.timeline.length) {
        doc.heading('Lifecycle', 2);
        doc.table([['Date', 'Event', 'Detail'], ...md.timeline], { header: true, widths: [1.1, 1.3, 4.5] });
      }
      if (md.notes) { doc.heading('Notes & lessons', 2); doc.para(md.notes); }
    }
    return doc.save();
  }

  // ── Browser: render charts, build the file, download ─────────────────────
  async function run(items, format, { onProgress, meta } = {}) {
    const models = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      onProgress?.(i, items.length);
      const snaps = await db.getSnapshots(it.t.id);
      const kind = s => root.ChartRender.kindOf(s);
      const entry = snaps.filter(s => kind(s) === 'entry').sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)))[0];
      const exit = snaps.find(s => kind(s) === 'exit');
      const charts = [];
      for (const [label, sn, missing] of [
        ['Entry chart (daily, 20-day EMA)', entry, 'No entry chart saved yet — Chartbook → Build missing charts'],
        ['Exit chart (daily, stop-loss path)', exit, it.status === 'Open' ? 'Trade still open — the exit chart is saved after it closes' : 'No exit chart saved yet — Chartbook → Build missing charts'],
      ]) {
        if (!sn) { charts.push({ label, missing }); continue; }
        const img = await root.ChartRender.toImage(sn, { width: 1100, height: 460 });
        charts.push({ label, bytes: root.PdfLite.dataUrlBytes(img.dataUrl), w: img.width, h: img.height });
      }
      models.push(buildModel(it, charts));
    }
    onProgress?.(items.length, items.length);
    const bytes = format === 'pdf' ? toPdf(models, meta) : toDocx(models, meta);
    const type = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const name = `chartbook_${new Date().toISOString().slice(0, 10)}.${format === 'pdf' ? 'pdf' : 'docx'}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return { name, bytes: bytes.length };
  }

  const api = { timeline, buildModel, toPdf, toDocx, run };
  root.ChartbookExport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
