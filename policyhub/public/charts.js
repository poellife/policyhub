/* =====================================================================
   Minimal SVG charts — no external libraries.
   Forms follow the data's job: line for trend over time, horizontal bar
   for magnitude comparison. One y-axis per chart, never two.
   ===================================================================== */

const SERIES_VARS = ['--series-1', '--series-2', '--series-3'];
export const seriesColor = (i) =>
  getComputedStyle(document.documentElement).getPropertyValue(SERIES_VARS[i % 3]).trim();

export const fmtMoney = (v, dp = 0) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? '—'
    : Number(v).toLocaleString('en-US', {
        style: 'currency', currency: 'USD',
        minimumFractionDigits: dp, maximumFractionDigits: dp,
      });

export const fmtCompact = (v) => {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ------------------------------ tooltip ------------------------------ */

let tipEl = null;
function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.style.display = 'none';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html;
  t.style.display = 'block';
  const r = t.getBoundingClientRect();
  let left = x + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  let top = y - r.height / 2;
  top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8));
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}
export function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

/* --------------------------- niceness helpers ------------------------ */

function niceTicks(min, max, count = 4) {
  if (min === max) { min = Math.min(0, min); max = max === 0 ? 1 : max * 1.2; }
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { ticks, lo, hi: ticks[ticks.length - 1] };
}

const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
};

/* ---------------------------- line chart ----------------------------- */
/**
 * lineChart(container, { points, series, height })
 *   points : [{ x: 'YYYY-MM-DD', label?, values: { key: number|null } }]
 *   series : [{ key, name }]   max 3
 */
export function lineChart(container, { points, series, height = 210, valueFmt = fmtMoney }) {
  container.innerHTML = '';
  const usable = points.filter((p) =>
    series.some((s) => p.values[s.key] !== null && p.values[s.key] !== undefined)
  );
  if (usable.length === 0) {
    container.innerHTML = '<div class="empty">No data recorded yet</div>';
    return;
  }

  if (series.length > 1) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    series.forEach((s, i) => {
      lg.insertAdjacentHTML('beforeend',
        `<span class="item"><span class="swatch" style="background:${seriesColor(i)}"></span>${s.name}</span>`);
    });
    container.appendChild(lg);
  }

  const W = Math.max(320, container.clientWidth || 560);
  const H = height;
  const m = { top: 12, right: 14, bottom: 26, left: 58 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;

  const all = [];
  usable.forEach((p) => series.forEach((s) => {
    const v = p.values[s.key];
    if (v !== null && v !== undefined && !Number.isNaN(Number(v))) all.push(Number(v));
  }));
  const { ticks, lo, hi } = niceTicks(Math.min(0, ...all), Math.max(...all));

  const xAt = (i) => (usable.length === 1 ? iw / 2 : (i / (usable.length - 1)) * iw);
  const yAt = (v) => ih - ((v - lo) / (hi - lo || 1)) * ih;

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
    role: 'img', 'aria-label': `Trend chart: ${series.map((s) => s.name).join(', ')}`,
  });
  const g = el('g', { transform: `translate(${m.left},${m.top})` });
  svg.appendChild(g);

  ticks.forEach((t) => {
    g.appendChild(el('line', { class: 'gridline', x1: 0, x2: iw, y1: yAt(t), y2: yAt(t) }));
    g.appendChild(el('text', { x: -9, y: yAt(t) + 4, 'text-anchor': 'end' }, fmtCompact(t)));
  });
  g.appendChild(el('line', { class: 'axis-line', x1: 0, x2: iw, y1: ih, y2: ih }));

  // Evenly spaced tick labels including both ends, so they never collide.
  // Ends anchor inward so they can't clip the frame.
  // Roughly 78px of room per label, so narrow charts thin the axis out.
  const tickCount = Math.max(2, Math.min(7, Math.floor(iw / 78), usable.length));
  const idxs = tickCount === 1 ? [0] : Array.from({ length: tickCount },
    (_, k) => Math.round((k * (usable.length - 1)) / (tickCount - 1)));
  [...new Set(idxs)].forEach((i) => {
    const p = usable[i];
    g.appendChild(el('text', {
      x: xAt(i), y: ih + 17,
      'text-anchor': i === 0 ? 'start' : i === usable.length - 1 ? 'end' : 'middle',
    }, p.label || shortDate(p.x)));
  });

  series.forEach((s, si) => {
    const color = seriesColor(si);
    const segs = [];
    let cur = [];
    usable.forEach((p, i) => {
      const v = p.values[s.key];
      if (v === null || v === undefined || Number.isNaN(Number(v))) {
        if (cur.length) segs.push(cur);
        cur = [];
      } else cur.push([xAt(i), yAt(Number(v))]);
    });
    if (cur.length) segs.push(cur);

    segs.forEach((seg) => {
      if (seg.length === 1) return;
      g.appendChild(el('path', {
        class: 'line', stroke: color,
        d: seg.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(' '),
      }));
    });
    // Markers only when the series is short enough to stay readable.
    if (usable.length <= 24) {
      segs.flat().forEach(([x, y]) =>
        g.appendChild(el('circle', { class: 'marker', cx: x, cy: y, r: 4, fill: color })));
    } else {
      const last = segs.flat().at(-1);
      if (last) g.appendChild(el('circle', { class: 'marker', cx: last[0], cy: last[1], r: 4.5, fill: color }));
    }
  });

  // Hover crosshair + tooltip
  const cross = el('line', { class: 'crosshair', y1: 0, y2: ih, x1: 0, x2: 0, opacity: 0 });
  g.appendChild(cross);
  const hit = el('rect', { class: 'hit', x: 0, y: 0, width: iw, height: ih });
  g.appendChild(hit);

  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const scale = W / box.width;
    const px = (ev.clientX - box.left) * scale - m.left;
    let idx = 0;
    if (usable.length > 1) idx = Math.round((px / iw) * (usable.length - 1));
    idx = Math.max(0, Math.min(usable.length - 1, idx));
    const p = usable[idx];
    cross.setAttribute('x1', xAt(idx));
    cross.setAttribute('x2', xAt(idx));
    cross.setAttribute('opacity', 1);
    const rows = series.map((s, i) => {
      const v = p.values[s.key];
      return `<div class="t-row"><span class="swatch" style="background:${seriesColor(i)}"></span>
              <span>${s.name}</span><span class="v">${v === null || v === undefined ? '—' : valueFmt(v)}</span></div>`;
    }).join('') + (p.extra || []).map((e) =>
      `<div class="t-row muted"><span style="width:9px"></span><span>${e.name}</span>
       <span class="v">${e.value === null || e.value === undefined ? '—' : valueFmt(e.value)}</span></div>`
    ).join('');
    showTip(`<div class="t-title">${p.tooltipTitle || p.label || shortDate(p.x)}</div>${rows}`,
      ev.clientX, ev.clientY);
  };
  hit.addEventListener('mousemove', move);
  hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); hideTip(); });

  container.appendChild(svg);
}

/* ------------------------- horizontal bar chart ---------------------- */
/**
 * Magnitude comparison — one hue, sequential by construction.
 * rows: [{ label, value, note? }]
 */
export function barChart(container, { rows, height, valueFmt = fmtCompact, max }) {
  container.innerHTML = '';
  if (!rows.length) { container.innerHTML = '<div class="empty">No data yet</div>'; return; }

  const rowH = 30;
  const W = Math.max(320, container.clientWidth || 560);
  const H = height || rows.length * rowH + 12;
  const labelW = Math.min(190, Math.max(90, W * 0.32));
  const valueW = 74;
  const barW = W - labelW - valueW - 10;
  const top = Number(max) || Math.max(...rows.map((r) => Math.abs(Number(r.value) || 0)), 1);
  const color = seriesColor(0);

  const svg = el('svg', {
    class: 'chart', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
    role: 'img', 'aria-label': 'Comparison chart',
  });

  rows.forEach((r, i) => {
    const y = i * rowH + 6;
    const v = Number(r.value) || 0;
    const w = Math.max(2, (Math.abs(v) / top) * barW);
    const label = r.label && r.label.length > 26 ? `${r.label.slice(0, 25)}…` : (r.label || '—');

    svg.appendChild(el('text',
      { x: labelW - 10, y: y + rowH / 2 - 2, 'text-anchor': 'end', 'dominant-baseline': 'middle' },
      label));

    // 2px surface gap between adjacent bars is achieved by the 4px row inset.
    const bar = el('rect', {
      class: 'bar', x: labelW, y: y + 5, width: w, height: rowH - 14, fill: color, rx: 4,
    });
    svg.appendChild(bar);

    const t = el('text', {
      class: 'value-label', x: labelW + w + 8, y: y + rowH / 2 - 2, 'dominant-baseline': 'middle',
    }, valueFmt(v));
    svg.appendChild(t);

    const hit = el('rect', { class: 'hit', x: 0, y, width: W, height: rowH });
    hit.addEventListener('mousemove', (ev) =>
      showTip(`<div class="t-title">${r.label || '—'}</div>
        <div class="t-row"><span class="swatch" style="background:${color}"></span>
        <span>${r.seriesName || 'Total'}</span><span class="v">${valueFmt(v)}</span></div>
        ${r.note ? `<div class="t-row muted"><span>${r.note}</span></div>` : ''}`,
        ev.clientX, ev.clientY));
    hit.addEventListener('mouseleave', hideTip);
    svg.appendChild(hit);
  });

  container.appendChild(svg);
}

/* ------------------------------ sparkline ---------------------------- */

export function sparkline(container, values, { height = 34 } = {}) {
  container.innerHTML = '';
  const nums = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
  if (nums.length < 2) return;
  const W = Math.max(80, container.clientWidth || 120);
  const min = Math.min(...nums), max = Math.max(...nums);
  const span = max - min || 1;
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${height}`, width: '100%', height });
  const d = nums.map((v, i) =>
    `${i ? 'L' : 'M'}${((i / (nums.length - 1)) * (W - 4) + 2).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`
  ).join(' ');
  svg.appendChild(el('path', { class: 'line', d, stroke: seriesColor(0) }));
  container.appendChild(svg);
}
