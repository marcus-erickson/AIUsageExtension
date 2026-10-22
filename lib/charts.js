/* Small hand-rolled SVG charts (extension pages can't load chart libraries from a CDN). */
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';

  function setup(el, height) {
    el.innerHTML = '';
    el.classList.add('chart');
    const W = Math.max(el.clientWidth || 600, 280);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${height}`);
    svg.setAttribute('height', height);
    const tip = document.createElement('div');
    tip.className = 'tip';
    el.appendChild(svg); el.appendChild(tip);
    return { svg, tip, W };
  }
  function add(parent, tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    parent.appendChild(n);
    return n;
  }
  function showTip(el, tip, html, px, py) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const w = tip.offsetWidth, cw = el.clientWidth;
    let left = px + 12;
    if (left + w > cw) left = px - w - 12;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, py - 10) + 'px';
  }
  function yAxis(g, m, W, H, yMax, ticks, fmt) {
    const y = (v) => m.t + (H - m.t - m.b) * (1 - v / yMax);
    for (const v of ticks) {
      add(g, 'line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'gridline' });
      add(g, 'text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmt(v));
    }
    return y;
  }

  // Line chart over time. series: [{points:[{t,v}], color, dashed, width}]; first series drives hover.
  function line(el, o) {
    const H = o.height || 220;
    const { svg, tip, W } = setup(el, H);
    const m = { l: 40, r: 12, t: 10, b: 26 };
    const yMax = o.yMax || 100;
    const axis = add(svg, 'g', { class: 'axis' });
    const y = yAxis(axis, m, W, H, yMax, o.yTicks || [0, 25, 50, 75, 100], o.yFmt || ((v) => v + '%'));
    const x = (t) => m.l + (W - m.l - m.r) * ((t - o.xMin) / (o.xMax - o.xMin));

    // x ticks
    const ticks = [];
    if (o.tickMode === 'hour') {
      const d = new Date(o.xMin); d.setMinutes(0, 0, 0); d.setHours(Math.ceil(d.getHours() / 6) * 6);
      for (let t = d.getTime(); t <= o.xMax; t += 6 * 3600e3) ticks.push(t);
    } else {
      const d = new Date(o.xMin); d.setHours(24, 0, 0, 0);
      const all = [];
      for (let t = d.getTime(); t <= o.xMax; ) { all.push(t); const n = new Date(t); n.setDate(n.getDate() + 1); t = n.getTime(); }
      const step = Math.ceil(all.length / Math.max(2, Math.floor((W - 60) / 70)));
      all.forEach((t, i) => { if (i % step === 0) ticks.push(t); });
    }
    for (const t of ticks) {
      const d = new Date(t);
      const lbl = o.tickMode === 'hour'
        ? (d.getHours() === 0 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleTimeString(undefined, { hour: 'numeric' }))
        : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
      add(axis, 'text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, lbl);
    }
    for (const t of o.markers || []) {
      if (t < o.xMin || t > o.xMax) continue;
      add(svg, 'line', { x1: x(t), x2: x(t), y1: m.t, y2: H - m.b, stroke: 'var(--pace)', 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.7 });
    }
    for (const s of o.series) {
      const segs = [];
      let cur = [];
      s.points.forEach((p, i) => {
        if (i && (p.t - s.points[i - 1].t > (s.gapMs || 2 * 3600e3) || p.v < s.points[i - 1].v - 3) && !s.continuous) { if (cur.length) segs.push(cur); cur = []; }
        cur.push(p);
      });
      if (cur.length) segs.push(cur);
      for (const seg of segs) {
        if (seg.length === 1) { add(svg, 'circle', { cx: x(seg[0].t), cy: y(seg[0].v), r: 2, fill: s.color }); continue; }
        const d = seg.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
        add(svg, 'path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(s.dashed ? { 'stroke-dasharray': '5 4' } : {}) });
      }
    }
    // hover
    const pts = o.series[0].points;
    if (!pts.length) return;
    const cross = add(svg, 'line', { y1: m.t, y2: H - m.b, stroke: 'var(--text-muted)', 'stroke-width': 1, visibility: 'hidden' });
    const dot = add(svg, 'circle', { r: 5, fill: o.series[0].color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
    const hit = add(svg, 'rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (W / r.width);
      const t = o.xMin + ((px - m.l) / (W - m.l - m.r)) * (o.xMax - o.xMin);
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid; else hi = mid; }
      const p = Math.abs(pts[lo].t - t) < Math.abs(pts[hi].t - t) ? pts[lo] : pts[hi];
      cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('visibility', 'visible');
      showTip(el, tip, o.tip(p), x(p.t) * (r.width / W), y(p.v) * (r.height / H));
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
  }

  // Bar chart. bars: [{label, value, color, tip, labelEvery}]; ref: {value, label}
  function bars(el, o) {
    const H = o.height || 200;
    const { svg, tip, W } = setup(el, H);
    const m = { l: 40, r: 12, t: 12, b: 26 };
    const maxV = Math.max(...o.bars.map((b) => b.value), o.ref ? o.ref.value : 0, 1);
    const step = niceStep(maxV / 4);
    const yMax = Math.ceil(maxV / step) * step;
    const ticks = []; for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(+v.toFixed(4));
    const axis = add(svg, 'g', { class: 'axis' });
    const y = yAxis(axis, m, W, H, yMax, ticks, o.yFmt || ((v) => v));
    const n = o.bars.length;
    const slot = (W - m.l - m.r) / Math.max(n, 1);
    const bw = Math.max(Math.min(slot - Math.max(2, slot * 0.28), 40), 2);
    const every = o.labelEvery || Math.ceil(n / Math.max(2, Math.floor((W - 60) / 46)));
    o.bars.forEach((b, i) => {
      const cx = m.l + slot * i + slot / 2;
      const top = y(b.value), base = y(0);
      if (b.value > 0) {
        const h = Math.max(base - top, 1), rr = Math.min(4, bw / 2, h);
        const x0 = cx - bw / 2;
        const d = `M${x0} ${base} V${top + rr} Q${x0} ${top} ${x0 + rr} ${top} H${x0 + bw - rr} Q${x0 + bw} ${top} ${x0 + bw} ${top + rr} V${base} Z`;
        add(svg, 'path', { d, fill: b.color || 'var(--series-1)' });
      }
      if ((n - 1 - i) % every === 0) add(axis, 'text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, b.label);
      const hit = add(svg, 'rect', { x: cx - slot / 2, y: m.t, width: slot, height: H - m.t - m.b, fill: 'transparent' });
      hit.addEventListener('mousemove', (e) => {
        const r = svg.getBoundingClientRect();
        showTip(el, tip, b.tip, cx * (r.width / W), (e.clientY - r.top));
      });
      hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
    if (o.ref && o.ref.value > 0) {
      const ry = y(o.ref.value);
      add(svg, 'line', { x1: m.l, x2: W - m.r, y1: ry, y2: ry, stroke: 'var(--text-secondary)', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'pointer-events': 'none' });
      add(svg, 'text', { x: W - m.r, y: ry - 5, 'text-anchor': 'end', fill: 'var(--text-secondary)', 'font-size': 11, 'font-weight': 600, 'pointer-events': 'none',
        stroke: 'var(--surface-1)', 'stroke-width': 4, 'stroke-linejoin': 'round', 'paint-order': 'stroke' }, o.ref.label);
    }
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  root.UsageCharts = { line, bars };
})(globalThis);
