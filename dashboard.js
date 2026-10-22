const C = UsageCore, U = UsageUI, Ch = UsageCharts;
const HAS_CHROME = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const params = new URLSearchParams(location.search);
let demo = params.get('demo') === '1' || !HAS_CHROME;
let state = { snapshots: [], org: null, lastStatus: null, lastRaw: null, settings: { notify: true } };

const $ = (id) => document.getElementById(id);
const DAY = C.DAY;

async function load() {
  if (HAS_CHROME) {
    state = Object.assign(state, await chrome.storage.local.get(['snapshots', 'org', 'lastStatus', 'lastRaw', 'settings', 'sync']));
    state.snapshots = state.snapshots || [];
    state.settings = state.settings || { notify: true };
  }
  render();
}

function data() {
  if (demo) return { snaps: UsageDemo.makeDemo(Date.now(), 21), plan: 'Max 5x' };
  return { snaps: state.snapshots, plan: state.org && state.org.plan };
}

function render() {
  const now = Date.now();
  const { snaps, plan } = data();
  $('plan').hidden = !plan || plan === 'Unknown';
  $('plan').textContent = (plan || '') + ' plan';
  $('demoPill').hidden = !demo;
  $('updated').textContent = demo ? '' : state.lastStatus && state.lastStatus.ok ? 'Updated ' + U.ago(state.lastStatus.at) : '';
  $('refresh').disabled = !HAS_CHROME;

  // banner
  let banner = '';
  if (!demo && state.lastStatus && !state.lastStatus.ok) banner = `<div class="banner err">Last reading failed: ${U.esc(state.lastStatus.error)}</div>`;
  if (demo && HAS_CHROME) banner = `<div class="banner">You're looking at sample data. <button id="realBtn">Show my data</button></div>`;
  $('banner').innerHTML = banner;
  if ($('realBtn')) $('realBtn').onclick = () => { demo = false; history.replaceState(null, '', location.pathname); render(); };

  const keys = C.allKeys(snaps);
  if (!keys.length) {
    $('main').innerHTML = `<div class="panel empty"><h2>No readings yet</h2>
      <p class="secondary">The tracker reads your usage every 15 minutes while Chrome is open and you're signed in to claude.ai.<br>Trends start showing up after a day or two.</p>
      <div class="tools" style="justify-content:center"><button class="primary" id="emptyRefresh">Take a reading now</button><button id="emptyDemo">Preview with sample data</button></div></div>`;
    $('emptyRefresh').onclick = refresh;
    $('emptyDemo').onclick = () => { demo = true; render(); };
    return;
  }

  const weeklyKey = keys.find((k) => k.endsWith('seven_day')) || C.headlineKey(keys);
  const sessionKey = keys.find((k) => k.endsWith('five_hour'));

  $('main').innerHTML = `
    <section class="cards" id="cards"></section>
    <section class="grid2">
      <div class="panel"><h2>Weekly usage over time</h2><p class="sub" id="wkSub"></p>
        <div class="legend"><span><i></i>Used</span><span><i class="pace"></i>Even pace to reset</span></div>
        <div id="wkChart"></div></div>
      <div class="panel"><h2>How much you use each day</h2><p class="sub" id="dSub"></p>
        <div class="legend"><span><i class="full"></i>Full day</span><span><i class="part"></i>Today so far</span></div>
        <div id="dChart"></div></div>
    </section>
    <section class="grid2">
      ${sessionKey ? `<div class="panel"><h2>5 hour sessions, last 48 hours</h2><p class="sub">Each climb is one session. A drop back to zero is a reset.</p><div id="sChart"></div></div>` : ''}
      <div class="panel"><h2>When you use Claude</h2><p class="sub" id="hSub"></p><div id="hChart"></div></div>
    </section>
    <section class="panel" style="margin-bottom:14px"><h2>Is your plan the right size?</h2><div id="fit"></div></section>
    <section class="panel"><h2>Your data</h2><div id="dataPanel"></div></section>`;

  renderCards(snaps, keys, now);
  if (weeklyKey) { renderWeekly(snaps, weeklyKey, now); renderDaily(snaps, weeklyKey, now); renderHourly(snaps, weeklyKey); }
  if (sessionKey) renderSession(snaps, sessionKey, now);
  renderFit(snaps, now, plan, weeklyKey);
  renderData(snaps, weeklyKey, now);
}

function renderCards(snaps, keys, now) {
  $('cards').innerHTML = keys.map((k) => {
    const st = C.status(snaps, k, now);
    if (!st) return '';
    const d = U.describe(st, now);
    const u = st.stale ? 0 : st.u;
    return `<div class="card">
      <div class="lbl">${U.esc(st.label)}</div>
      <div class="big num">${U.pct(u)}<small>used</small></div>
      <div class="bar"><div class="fill" style="width:${u}%"></div>${st.pace != null && !st.stale ? `<div class="tick" style="left:calc(${st.pace}% - 1px)" title="Even pace: ${U.pct(st.pace)}"></div>` : ''}</div>
      <span class="status ${d.cls}"><span class="ic">${d.icon}</span>${d.label}</span>
      <div class="detail">${U.esc(d.detail)}</div>
      <div class="reset">${U.esc(d.resetTxt)}${st.pace != null && !st.stale ? ' · Even pace now: ' + U.pct(st.pace) : ''}</div>
    </div>`;
  }).join('');
}

function renderWeekly(snaps, key, now) {
  const pts = C.series(snaps, key);
  const xMin = Math.max(now - 14 * DAY, pts[0].t), xMax = now;
  const inRange = pts.filter((p) => p.t >= xMin).map((p) => ({ t: p.t, v: p.u, r: p.r }));
  const ws = C.windows(pts, key).filter((w) => w.end > xMin);
  const len = C.windowMs(key);
  const paceSeries = ws.map((w) => {
    const a = Math.max(w.start, xMin), b = Math.min(w.end, xMax);
    return { points: [{ t: a, v: ((a - w.start) / len) * 100 }, { t: b, v: ((b - w.start) / len) * 100 }], color: 'var(--pace)', dashed: true, width: 1.5, continuous: true };
  });
  Ch.line($('wkChart'), {
    xMin, xMax, height: 230,
    series: [{ points: inRange, color: 'var(--series-1)' }, ...paceSeries],
    markers: ws.map((w) => w.end).filter((t) => t < xMax),
    tip: (p) => `<b>${U.pct(p.v)}</b> of weekly limit<br><span class="muted">${new Date(p.t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`,
  });
  const st = C.status(snaps, key, now);
  $('wkSub').textContent = st && st.pace != null
    ? `Above the dashed line means you're using it faster than an even pace. Dotted lines mark weekly resets.`
    : 'Dotted lines mark weekly resets.';
}

function renderDaily(snaps, key, now) {
  const days = C.dailyUsage(snaps, key, 14, now);
  const full = days.filter((d) => !d.partial);
  const avg = full.length ? full.reduce((a, d) => a + d.value, 0) / full.length : 0;
  Ch.bars($('dChart'), {
    height: 230, yFmt: (v) => v + '%',
    bars: days.map((d) => ({
      label: new Date(d.date).toLocaleDateString(undefined, { weekday: 'narrow' }) + ' ' + new Date(d.date).getDate(),
      value: d.value, color: d.partial ? 'var(--series-1-soft)' : 'var(--series-1)',
      tip: `<b>${d.value.toFixed(1)}%</b> of weekly limit<br><span class="muted">${new Date(d.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}${d.partial ? ' (so far)' : ''}</span>`,
    })),
    ref: full.length ? { value: avg, label: 'avg ' + avg.toFixed(1) + '%' } : null,
  });
  $('dSub').textContent = full.length
    ? `Each bar is the share of your weekly limit used that day. An average day uses ${avg.toFixed(1)}%, so a full week at that rate comes to about ${Math.round(avg * 7)}%.`
    : 'Each bar is the share of your weekly limit used that day. The average shows up after the first full day.';
}

function renderSession(snaps, key, now) {
  const pts = C.series(snaps, key).filter((p) => p.t >= now - 2 * DAY).map((p) => ({ t: p.t, v: p.u }));
  if (!pts.length) { $('sChart').innerHTML = '<p class="muted">No session readings in the last 48 hours.</p>'; return; }
  Ch.line($('sChart'), {
    xMin: Math.max(now - 2 * DAY, pts[0].t), xMax: now, height: 200, tickMode: 'hour',
    series: [{ points: pts, color: 'var(--series-1)' }],
    tip: (p) => `<b>${U.pct(p.v)}</b> of session limit<br><span class="muted">${new Date(p.t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>`,
  });
}

function renderHourly(snaps, key) {
  const prof = C.hourlyProfile(snaps, key);
  const hl = (h) => (h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : h - 12 + 'p');
  Ch.bars($('hChart'), {
    height: 200, labelEvery: 3, yFmt: (v) => v + '%',
    bars: prof.map((p) => ({
      label: hl(p.hour), value: p.value,
      tip: `<b>${p.value.toFixed(2)}%</b> of weekly limit on a typical day<br><span class="muted">${hl(p.hour)} to ${hl((p.hour + 1) % 24)}</span>`,
    })),
  });
  const top = [...prof].sort((a, b) => b.value - a.value).slice(0, 3).filter((p) => p.value > 0).map((p) => hl(p.hour));
  $('hSub').textContent = top.length ? `Average usage by hour of the day. Your heaviest hours start at ${top.join(', ')}.` : 'Average usage by hour of the day.';
}

function renderFit(snaps, now, plan, weeklyKey) {
  const f = C.planFit(snaps, now, plan);
  const v = {
    collecting: ['neutral', '…', 'Still collecting'],
    upgrade: ['critical', '▲', 'Running tight'],
    downgrade: ['warning', '▼', 'More plan than you need'],
    fits: ['good', '✓', 'Plan fits'],
  }[f.verdict];
  const peaks = f.weeklyPeaks;
  $('fit').innerHTML = `
    <div class="verdict"><span class="status ${v[0]}"><span class="ic">${v[1]}</span>${v[2]}</span><span class="secondary">${U.esc(f.message)}</span></div>
    <div class="facts">
      <div class="fact"><div class="v num">${f.daysTracked < 1 ? '<1' : Math.floor(f.daysTracked)}</div><div class="k">days tracked</div></div>
      <div class="fact"><div class="v num">${f.avgWeeklyPeak == null ? '–' : U.pct(f.avgWeeklyPeak)}</div><div class="k">typical weekly peak</div></div>
      <div class="fact"><div class="v num">${f.sessionHits30d}</div><div class="k">session limits hit, last 30 days</div></div>
    </div>
    ${peaks.length ? '<p class="sub" style="margin-top:12px">Highest usage reached in each weekly window</p><div id="peakChart"></div>' : ''}`;
  if (peaks.length) {
    const st = weeklyKey ? C.status(snaps, weeklyKey, now) : null;
    Ch.bars($('peakChart'), {
      height: 170, yFmt: (x) => x + '%',
      bars: peaks.map((w) => ({
        label: (w.complete ? '' : 'Now ') + new Date(w.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        value: w.peak,
        color: w.peak >= 99.5 ? 'var(--critical)' : w.complete ? 'var(--series-1)' : 'var(--series-1-soft)',
        tip: `<b>${U.pct(w.peak)}</b> peak${w.complete ? '' : ' so far'}${!w.complete && st && st.projectedAtReset != null ? `<br>Projected ${U.pct(Math.min(st.projectedAtReset, 100))} by reset` : ''}<br><span class="muted">Week starting ${new Date(w.start).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>`,
      })),
      ref: { value: 100, label: 'limit' },
    });
  }
}

function renderData(snaps, weeklyKey, now) {
  const days = weeklyKey ? C.dailyUsage(snaps, weeklyKey, 14, now) : [];
  const raw = demo ? null : state.lastRaw;
  $('dataPanel').innerHTML = `
    <p class="sub">${state.sync && state.sync.token && !demo ? 'Readings are stored in this Chrome profile and copied to your cloud sync database.' : 'Everything stays in this Chrome profile. Nothing is sent anywhere.'} ${snaps.length.toLocaleString()} readings stored.</p>
    <div class="tools">
      <button id="csv">Download CSV</button><button id="json">Download JSON</button>
      ${HAS_CHROME && !demo ? '<button id="clear">Clear history</button>' : ''}
      ${HAS_CHROME ? `<label class="toggle"><input type="checkbox" id="notify" ${state.settings.notify !== false ? 'checked' : ''}> Alert me at 75% and 90%, and when I'm on track to run out early</label>` : ''}
    </div>
    <details><summary>Daily numbers as a table</summary>
      <table class="data"><tr><th>Day</th><th>Share of weekly limit used</th></tr>
      ${days.map((d) => `<tr><td>${new Date(d.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${d.partial ? ' (so far)' : ''}</td><td class="num">${d.value.toFixed(1)}%</td></tr>`).join('')}</table>
    </details>
    ${HAS_CHROME && !demo ? syncHTML() : ''}
    ${raw ? `<details><summary>Raw response from claude.ai (for troubleshooting)</summary><pre>${U.esc(JSON.stringify(raw.body, null, 2))}</pre></details>` : ''}`;
  wireSync();
  $('csv').onclick = () => download('claude-usage.csv', C.toCSV(snaps), 'text/csv');
  $('json').onclick = () => download('claude-usage.json', JSON.stringify(snaps), 'application/json');
  if ($('clear')) $('clear').onclick = async () => {
    if (!confirm('Delete all stored usage readings? This cannot be undone.')) return;
    await chrome.storage.local.set({ snapshots: [] });
    load();
  };
  if ($('notify')) $('notify').onchange = async (e) => {
    state.settings.notify = e.target.checked;
    await chrome.storage.local.set({ settings: state.settings });
  };
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function refresh() {
  if (!HAS_CHROME) return;
  const b = $('refresh'); b.disabled = true; b.textContent = 'Reading…';
  await chrome.runtime.sendMessage({ type: 'poll' });
  b.disabled = false; b.textContent = 'Refresh now';
  demo = false;
  load();
}

$('refresh').onclick = refresh;
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
if (HAS_CHROME) chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') load(); });
load();

// ---------- Cloud sync panel ----------
function syncHTML() {
  const sy = state.sync;
  if (!sy || !sy.token) {
    return `<div class="sync"><h3>Cloud sync <span class="muted">(optional)</span></h3>
      <p class="sub">Paste a sync code to also save readings to a database, so Claude can answer "how am I doing?" from any chat.</p>
      <div class="tools"><input id="syncCode" placeholder="Paste sync code" spellcheck="false"><button id="syncConnect">Connect</button></div>
      <p class="sub" id="syncMsg"></p></div>`;
  }
  const st = sy.lastError ? `<span class="status critical"><span class="ic">!</span>${U.esc(sy.lastError)}</span>`
    : sy.lastSyncAt ? `<span class="status good"><span class="ic">✓</span>Last synced ${U.ago(sy.lastSyncAt)}</span>` : '<span class="muted">Not synced yet</span>';
  return `<div class="sync"><h3>Cloud sync</h3>
    <p class="sub">Saving readings as <b>${U.esc(sy.name || 'this device')}</b>. ${st}</p>
    <div class="tools"><button id="syncNow">Sync now</button><button id="syncOff">Disconnect</button></div></div>`;
}
function wireSync() {
  if ($('syncConnect')) $('syncConnect').onclick = async () => {
    let cfg;
    try { cfg = JSON.parse(atob($('syncCode').value.trim())); } catch (e) { cfg = null; }
    if (!cfg || !cfg.u || !cfg.k || !cfg.t) { $('syncMsg').textContent = "That code doesn't look right. Copy it again, all on one line."; return; }
    const sync = { url: cfg.u, key: cfg.k, token: cfg.t, name: cfg.n || '', through: 0 };
    await chrome.storage.local.set({ sync });
    $('syncMsg').textContent = 'Connecting and uploading your history…';
    await chrome.runtime.sendMessage({ type: 'syncNow' });
    load();
  };
  if ($('syncNow')) $('syncNow').onclick = async (e) => { e.target.disabled = true; await chrome.runtime.sendMessage({ type: 'syncNow' }); load(); };
  if ($('syncOff')) $('syncOff').onclick = async () => {
    if (!confirm('Stop saving readings to the cloud? Readings already uploaded stay there.')) return;
    await chrome.storage.local.remove('sync'); state.sync = null; load();
  };
}
