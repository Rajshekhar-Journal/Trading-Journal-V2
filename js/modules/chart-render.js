/**
 * chart-render.js — draws saved trade charts (trade_snapshots rows) with Lightweight Charts.
 * Used by the Trade lifecycle panel, the Chartbook page and the PDF / Word export.
 *
 *   daily(el, snap)      daily candles + 20-day EMA, fill / stop / target lines, entry-add-exit markers,
 *                        and on exit charts the stop-loss path
 *   intraday(el, snap)   the event day's 1-minute candles (IST)
 *   enlarge(snap, title) full-size view in a dialog, with a Daily / 1-min switch
 *   toImage(snap, opts)  render off-screen and return a JPEG/PNG data URL (for export)
 */
const ChartRender = (() => {
  const IST = 19800;   // seconds: Lightweight Charts shows UTC, candles are shifted to read in IST
  const COL = { up: '#10b981', down: '#ef4444', fill: '#2563eb', sl: '#dc2626', stop: '#dc2626', target: '#94a3b8', ema: '#f59e0b', exit: '#7c3aed', add: '#0d9488' };
  const KIND_LABEL = { entry: 'Entry', add: '1R add', exit: 'Exit' };
  const kindOf = sn => sn.kind || (sn.rule_id === 'LC-02' ? 'add' : sn.rule_id === 'EXIT' ? 'exit' : 'entry');
  const num = v => Number(v) || 0;

  function _chart(el, height, { interactive = true, timeVisible = false } = {}) {
    const chart = LightweightCharts.createChart(el, {
      height, width: el.clientWidth || 640,
      localization: { locale: 'en-IN' },
      layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#475569', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: '#eef1f5' } },
      timeScale: { borderVisible: false, timeVisible, secondsVisible: false },
      rightPriceScale: { borderVisible: false },
      handleScroll: interactive, handleScale: interactive,
    });
    if (interactive && window.ResizeObserver) {
      new ResizeObserver(() => { if (el.clientWidth) { chart.applyOptions({ width: el.clientWidth }); chart.__fit?.(); } }).observe(el);
    }
    return chart;
  }

  function _candles(chart, keep) {
    const levels = keep.filter(v => v > 0);
    return chart.addCandlestickSeries({
      upColor: COL.up, downColor: COL.down, wickUpColor: COL.up, wickDownColor: COL.down, borderVisible: false, priceLineVisible: false,
      autoscaleInfoProvider: original => {
        const r = original();
        if (!r || !levels.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...levels), maxValue: Math.max(r.priceRange.maxValue, ...levels) } };
      },
    });
  }

  /**
   * Volume bars in the bottom fifth of the chart (green on up days, red on down days).
   * Charts saved before volume was recorded have none — Chartbook → Rebuild all adds it.
   */
  function _volume(chart, series, rows) {
    if (!rows.some(c => c.volume > 0)) return;
    series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });
    const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, title: 'Vol' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vol.setData(rows.map(c => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(16,185,129,0.45)' : 'rgba(239,68,68,0.45)' })));
  }

  /** Show every candle with a little room on the right for the last marker and labels. */
  function _fit(chart, n, win = n) {
    chart.__fit = () => _fit(chart, n, win);
    if (n > 1) chart.timeScale().setVisibleLogicalRange({ from: Math.max(-1, n - win - 1), to: n + 3 }); else chart.timeScale().fitContent();
  }

  /** First candle date on or after `d` (markers must sit on a candle). */
  // The event's own candle, or the next trading day's; never an earlier day (that would mislabel the chart).
  const snapDate = (dates, d) => dates.find(x => x >= d) || null;

  /** Daily chart of a snapshot. Returns the chart (call .remove() when done). */
  function daily(el, snap, { height = 360, interactive = true, window: win } = {}) {
    const kind = kindOf(snap), lv = snap.levels || {};
    const data = (snap.daily || []).map(c => ({ time: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
    const chart = _chart(el, height, { interactive });
    const stops = (lv.stopPath || []).map(s => num(s.stop));
    const keep = kind === 'exit' ? [num(lv.fill), num(lv.exitPrice), ...stops] : [num(lv.fill), num(lv.initialStop), num(lv.targets?.T1)];
    const series = _candles(chart, keep);
    series.setData(data.map(({ volume, ...c }) => c));
    _volume(chart, series, data);
    const dates = data.map(c => c.time);

    // 20-day EMA
    const ema = TLMIndicators.emaSeries(data.map(c => c.close), 20);
    const emaLine = chart.addLineSeries({ color: COL.ema, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'EMA 20', crosshairMarkerVisible: false });
    emaLine.setData(data.map((c, i) => (ema[i] == null ? null : { time: c.time, value: +ema[i].toFixed(2) })).filter(Boolean));

    const line = (price, color, title, style = 2) => num(price) > 0 && series.createPriceLine({ price: num(price), color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    let markers = [];
    if (kind === 'exit') {
      // Stop-loss path as a step line from the first entry to the exit day
      const path = (lv.stopPath || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      if (path.length) {
        const pts = [];
        for (const d of dates.filter(d => d >= path[0].date && d <= (lv.exitDate || dates.at(-1)))) {
          let v = path[0].stop;
          for (const p of path) if (p.date <= d) v = p.stop;
          pts.push({ time: d, value: v });
        }
        const sl = chart.addLineSeries({ color: COL.stop, lineWidth: 2, lineStyle: 2, lineType: 1, priceLineVisible: false, lastValueVisible: false, title: 'Stop', crosshairMarkerVisible: false });
        sl.setData(pts);
      }
      line(lv.fill, COL.fill, 'Entry');
      line(lv.exitPrice, COL.exit, 'Exit');
      const style = {
        entry:   { position: 'belowBar', color: COL.fill, shape: 'arrowUp', text: 'Entry' },
        add:     { position: 'belowBar', color: COL.add, shape: 'arrowUp', text: 'Add' },
        partial: { position: 'aboveBar', color: COL.exit, shape: 'arrowDown', text: 'Partial' },
        exit:    { position: 'aboveBar', color: COL.exit, shape: 'arrowDown', text: 'Exit' },
      };
      markers = (lv.markers || []).filter(m => snapDate(dates, m.date)).map(m => ({ time: snapDate(dates, m.date), ...style[m.type] || style.entry, text: `${(style[m.type] || style.entry).text} ${m.qty || ''}`.trim() }));
    } else {
      line(lv.fill, COL.fill, kind === 'add' ? 'Add' : 'Fill');
      line(lv.initialStop, COL.sl, 'SL');
      if (kind === 'add' && num(lv.stop) > num(lv.initialStop)) line(lv.stop, COL.sl, 'Stop', 0);
      Object.entries(lv.targets || {}).forEach(([k, v]) => line(v, COL.target, k.replace('T', '') + 'R', 3));
      if (snap.entry_date && snapDate(dates, snap.entry_date)) markers = [{ time: snapDate(dates, snap.entry_date), position: 'belowBar', color: kind === 'add' ? COL.add : COL.fill, shape: 'arrowUp', text: KIND_LABEL[kind] }];
    }
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    if (markers.length) series.setMarkers(markers);
    // Entry / add charts open on the last ~6 months (scroll or zoom out for the full year); exit charts show the whole trade.
    _fit(chart, data.length, win ?? (kind === 'exit' ? data.length : 130));
    return chart;
  }

  /** 1-minute chart of the event day (IST times). */
  function intraday(el, snap, { height = 360, interactive = true } = {}) {
    const lv = snap.levels || {};
    const data = (snap.intraday || []).map(c => ({ time: c.time + IST, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }));
    const chart = _chart(el, height, { interactive, timeVisible: true });
    const series = _candles(chart, [num(lv.fill), num(lv.initialStop)]);
    series.setData(data.map(({ volume, ...c }) => c));
    _volume(chart, series, data);
    const line = (price, color, title) => num(price) > 0 && series.createPriceLine({ price: num(price), color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title });
    line(lv.fill || lv.exitPrice, COL.fill, kindOf(snap) === 'exit' ? 'Exit' : 'Fill');
    line(lv.initialStop, COL.sl, 'SL');
    _fit(chart, data.length);
    return chart;
  }

  const legendHtml = snap => {
    const exit = kindOf(snap) === 'exit';
    const dot = (c, t, dash) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><span style="width:14px;height:0;border-top:2px ${dash ? 'dashed' : 'solid'} ${c}"></span>${t}</span>`;
    return `<div class="cr-legend">${dot(COL.ema, 'EMA 20')}${(snap.daily || []).some(c => c.volume > 0) ? dot('rgba(16,185,129,0.6)', 'Volume') : ''}${exit ? dot(COL.stop, 'Stop path', 1) + dot(COL.fill, 'Entry', 1) + dot(COL.exit, 'Exit', 1) : dot(COL.fill, 'Fill', 1) + dot(COL.sl, 'Stop loss', 1) + dot(COL.target, 'Targets', 1)}</div>`;
  };

  /** Full-size view in the app dialog, with a Daily / 1-min switch when 1-min candles exist. */
  function enlarge(snap, title) {
    const has1m = (snap.intraday || []).length > 0;
    app.openModal(title, `
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button class="filter-btn active" data-cr-view="daily">Daily</button>
        ${has1m ? '<button class="filter-btn" data-cr-view="intraday">1-min (event day)</button>' : '<span style="font-size:12px;color:var(--text-muted);align-self:center">1-min candles are only kept for the last few days</span>'}
      </div>
      <div id="cr-big" style="height:560px"></div>${legendHtml(snap)}`, [{ id: 'close', label: 'Close', class: 'btn-secondary', onClick: app.closeModal }]);
    document.getElementById('modal-container')?.classList.add('modal-wide');
    let chart = null;
    const show = view => {
      const el = document.getElementById('cr-big');
      if (!el) return;
      if (chart) chart.remove();
      chart = view === 'intraday' ? intraday(el, snap, { height: 560 }) : daily(el, snap, { height: 560, window: (snap.daily || []).length });
      document.querySelectorAll('[data-cr-view]').forEach(b => b.classList.toggle('active', b.dataset.crView === view));
    };
    document.querySelectorAll('[data-cr-view]').forEach(b => b.addEventListener('click', () => show(b.dataset.crView)));
    setTimeout(() => show('daily'), 30);
  }

  /** Render off-screen and return { dataUrl, width, height } (for PDF / Word export). */
  async function toImage(snap, { width = 1000, height = 420, view = 'daily', type = 'image/jpeg' } = {}) {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;background:#fff`;
    document.body.appendChild(el);
    try {
      const chart = view === 'intraday' ? intraday(el, snap, { height, interactive: false }) : daily(el, snap, { height, interactive: false });
      chart.applyOptions({ width });
      (chart.__fit || (() => chart.timeScale().fitContent()))();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const canvas = chart.takeScreenshot();
      const dataUrl = canvas.toDataURL(type, 0.92);
      chart.remove();
      return { dataUrl, width: canvas.width, height: canvas.height };
    } finally {
      el.remove();
    }
  }

  return { daily, intraday, enlarge, toImage, legendHtml, kindOf, KIND_LABEL };
})();
window.ChartRender = ChartRender;
