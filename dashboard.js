const C = UsageCore, U = UsageUI, Ch = UsageCharts;
const HAS_CHROME = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const params = new URLSearchParams(location.search);
let demo = params.get('demo') === '1' || !HAS_CHROME;
let state = { snapshots: [], org: null, lastStatus: null, lastRaw: null, settings: { notify: true } };

const $ = (id) => document.getElementById(id);
const DAY = C.DAY;

async function load() {
  if (HAS_CHROME) {
    state = Object.assign(state, await chrome.storage.local.get(['snapshots', 'org', 'lastStatus', 'lastRaw', 'settings', 'sync', 'plans', 'providerStatus', 'grokOn', 'geminiOn', 'chatgptOn', 'claudeOn']));
    state.claudeOn = typeof state.claudeOn === 'boolean' ? state.claudeOn : !!state.org;
    state.snapshots = state.snapshots || [];
    state.settings = state.settings || { notify: true };
  }
  render();
}

let provider = 'claude';
let pickedTab = false; // the Overview tab is the default until the person picks a tab

// Which providers are turned on. Turned-off providers are hidden, and their saved history comes back if they are turned on again.
function isOnP(pid) { return pid === 'claude' ? !!state.claudeOn : !!state[pid + 'On']; }
function enabledIds() { return UsageProviders.order.filter(isOnP); }

function data() {
  if (demo) return { snaps: UsageDemo.makeDemo(Date.now(), 21), plan: 'Max 5x' };
  // Claude's plan comes from its organization; other providers report theirs through their own readers.
  // Providers that are turned off are hidden. Their saved history stays and comes back if they are turned on again.
  const all = HAS_CHROME ? state.snapshots.filter((s) => isOnP(s.p || 'claude')) : state.snapshots;
  // Providers whose plan shows no usage limit (ChatGPT Free, say) have no readings but still get a tab with their plan.
  const withData = C.providersIn(all);
  const ids = HAS_CHROME ? UsageProviders.order.filter((pid) => withData.includes(pid) || (isOnP(pid) && state.providerStatus && state.providerStatus[pid] && state.providerStatus[pid].ok && state.providerStatus[pid].noLimit)) : withData;
  if (!pickedTab && ids.length >= 2) provider = 'all';
  if (provider === 'all' && ids.length < 2) provider = ids[0] || 'claude';
  if (provider === 'all') return { snaps: all, plan: null, ids };
  if (ids.length && !ids.includes(provider)) provider = ids[0];
  else if (!ids.length && enabledIds().length && !isOnP(provider)) provider = enabledIds()[0];
  return { snaps: C.forProvider(all, provider), plan: provider === 'claude' ? state.org && state.org.plan : (state.plans || {})[provider], ids };
}

function providerTabs(ids) {
  if (!ids || ids.length < 2) return '';
  return `<div class="tabs" role="tablist"><button role="tab" class="tab" data-p="all" aria-selected="${provider === 'all'}">Overview</button>${ids.map((id) => `<button role="tab" class="tab" data-p="${id}" aria-selected="${id === provider}">${U.esc(UsageProviders.name(id))}</button>`).join('')}</div>`;
}

// First run: nothing is tracked until the person picks what they use.
function renderWelcome() {
  $('main').innerHTML = `<div class="panel empty welcome"><h2>What do you want to track?</h2>
    <p class="secondary">Pick the AI tools you pay for. Each one asks for permission to read only its own site, and you can change this later from the Providers menu.</p>
    <div class="tools" style="justify-content:center">
      <button class="primary" id="wClaude">Track Claude</button>
      <button class="primary" id="wGrok">Track Grok</button>
      <button class="primary" id="wChatgpt">Track ChatGPT</button>
      <button class="primary" id="wGemini">Track Gemini</button>
      <button id="emptyDemo">Preview with sample data</button></div>
    <p class="secondary" style="margin-top:14px">ChatGPT reports usage for Codex and agents, not for ordinary chat.</p></div>`;
  const wire = (id, p) => { $(id).onclick = async (e) => { e.target.disabled = true; const ok = await UsageMenu.setProvider(p, true); if (!ok) e.target.disabled = false; }; };
  wire('wClaude', 'claude'); wire('wGrok', 'grok'); wire('wChatgpt', 'chatgpt'); wire('wGemini', 'gemini');
  $('emptyDemo').onclick = () => { demo = true; render(); };
}

function render() {
  const now = Date.now();
  const { snaps, plan, ids } = data();
  const h1 = document.querySelector('h1');
  if (h1) {
    const only = demo ? 'claude' : ids.length >= 2 ? null : ids.length === 1 ? ids[0] : enabledIds().length === 1 ? enabledIds()[0] : null;
    h1.textContent = (only ? UsageProviders.name(only) : 'AI') + ' usage';
  }
  $('plan').hidden = true; // the plan is shown per provider, in the line under the tabs
  $('demoPill').hidden = !demo;
  $('updated').textContent = demo || !state.claudeOn ? '' : state.lastStatus && state.lastStatus.ok ? 'Updated ' + U.ago(state.lastStatus.at) : '';
  $('refresh').disabled = !HAS_CHROME;

  // banner
  let banner = '';
  if (!demo && state.claudeOn && state.lastStatus && !state.lastStatus.ok) banner = `<div class="banner err">Last reading failed: ${U.esc(state.lastStatus.error)}</div>`;
  for (const pid of ['grok', 'gemini', 'chatgpt']) {
    const ps = state.providerStatus && state.providerStatus[pid];
    if (demo || !isOnP(pid) || !ps) continue;
    const nm = UsageProviders.name(pid);
    if (!ps.ok) banner += `<div class="banner err">${U.esc(nm)}: ${U.esc(ps.error)}</div>`;
  }
  if (demo && HAS_CHROME) banner = `<div class="banner">You're looking at sample data. <button id="realBtn">Show my data</button></div>`;
  const planLine = plan && plan !== 'Unknown' ? `<div class="planline">Plan: <b>${U.esc(plan)}</b></div>` : '';
  const noteTxt = demo ? '' : UsageProviders.note(provider);
  $('banner').innerHTML = (demo ? '' : providerTabs(ids)) + banner + planLine + (noteTxt ? `<div class="provnote secondary">${U.esc(noteTxt)}</div>` : '');
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { provider = b.dataset.p; pickedTab = true; render(); }; });
  if ($('realBtn')) $('realBtn').onclick = () => { demo = false; history.replaceState(null, '', location.pathname); render(); };

  const keys = provider === 'all' ? [] : C.allKeys(snaps);
  if (!demo && HAS_CHROME && !enabledIds().length) { renderWelcome(); return; }
  if (provider === 'all') { renderOverview(snaps, now); return; }
  if (!keys.length && !demo && provider === 'claude' && plan === 'Free') {
    $('main').innerHTML = `<div class="panel empty"><h2>You're on Claude's Free plan</h2>
      <p class="secondary">Claude doesn't report usage percentages for free accounts, so there is nothing to track right now.<br>If Claude starts reporting a limit for your account, or you move to a paid plan, readings will appear here on their own.</p></div>`;
    return;
  }
  const psNow = state.providerStatus && state.providerStatus[provider];
  if (!keys.length && !demo && psNow && psNow.ok && psNow.noLimit) {
    $('main').innerHTML = `<div class="panel empty"><h2>No usage limit on this plan</h2>
      <p class="secondary">${U.esc(UsageProviders.name(provider))}${plan ? ' (' + U.esc(plan) + ')' : ''} did not show a usage limit, so there is nothing to track right now.<br>If a limit appears, for example after a plan change, readings will show up here on their own.</p></div>`;
    return;
  }
  if (!keys.length) {
    const nm = UsageProviders.name(provider);
    const site = { grok: 'grok.com', gemini: 'gemini.google.com', chatgpt: 'chatgpt.com', claude: 'claude.ai' }[provider];
    const how = (provider === 'claude' ? 'every 15 minutes' : 'once an hour') + ' while Chrome is open and you are signed in to ' + site;
    $('main').innerHTML = `<div class="panel empty"><h2>No ${U.esc(nm)} readings yet</h2>
      <p class="secondary">The tracker reads your ${U.esc(nm)} usage ${how}.<br>Trends start showing up after a day or two.</p>
      <div class="tools" style="justify-content:center"><button class="primary" id="emptyRefresh">Take a reading now</button><button id="emptyDemo">Preview with sample data</button></div></div>`;
    $('emptyRefresh').onclick = refresh;
    $('emptyDemo').onclick = () => { demo = true; render(); };
    return;
  }

  // Only Claude's lone 5 hour limit falls back to the weekly-style charts. A monthly limit gets its own simple chart.
  const weeklyKey = keys.find((k) => k.endsWith('seven_day')) || (provider === 'claude' || demo ? C.headlineKey(keys) : null);
  const sessionKey = keys.find((k) => k.endsWith('five_hour'));

  if (!weeklyKey) {
    const hk = C.headlineKey(keys);
    $('main').innerHTML = `
      <section class="cards" id="cards"></section>
      <section class="panel" style="margin-bottom:14px"><h2>Usage over time</h2><p class="sub">${U.esc(C.labelFor(hk))}. The line fills in as readings come in, about one an hour.</p><div id="wkChart"></div></section>
      <section class="panel"><h2>Your data</h2><div id="dataPanel"></div></section>`;
    renderCards(snaps, keys, now);
    renderSimple(snaps, hk, now);
    renderData(snaps, null, now);
    return;
  }

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
      <div class="panel"><h2>When you use ${U.esc(UsageProviders.name(demo ? 'claude' : provider))}</h2><p class="sub" id="hSub"></p><div id="hChart"></div></div>
    </section>
    <section class="panel" style="margin-bottom:14px"><h2>Is your plan the right size?</h2><div id="fit"></div></section>
    <section class="panel"><h2>Your data</h2><div id="dataPanel"></div></section>`;

  renderCards(snaps, keys, now);
  if (weeklyKey) { renderWeekly(snaps, weeklyKey, now); renderDaily(snaps, weeklyKey, now); renderHourly(snaps, weeklyKey); }
  if (sessionKey) renderSession(snaps, sessionKey, now);
  renderFit(snaps, now, plan, weeklyKey);
  renderData(snaps, weeklyKey, now);
}

// Extra detail some providers report with a limit: where the usage went, and prepaid credits.
// One quick look at every provider that is turned on. Each row jumps to that provider's own tab.
const OV_RANK = { limit: 6, over: 5, tight: 4, ahead: 3, ok: 2, idle: 2, early: 1, reset: 0, unknown: 0 };
function renderOverview(all, now) {
  const rows = [];
  for (const pid of enabledIds()) {
    const sn = C.forProvider(all, pid);
    const sts = C.allKeys(sn).map((k) => C.status(sn, k, now)).filter(Boolean);
    sts.sort((a, b) => OV_RANK[b.state] - OV_RANK[a.state] || b.u - a.u);
    rows.push({ pid, sts, plan: pid === 'claude' ? state.org && state.org.plan : (state.plans || {})[pid] });
  }
  const worst = rows.filter((r) => r.sts.length).sort((a, b) => OV_RANK[b.sts[0].state] - OV_RANK[a.sts[0].state] || b.sts[0].u - a.sts[0].u)[0];
  let verdict = 'Nothing to report yet. Readings appear after the first check.';
  if (worst) {
    const t = worst.sts[0], nm = UsageProviders.name(worst.pid);
    if (t.state === 'limit' && !t.stale) verdict = `${nm}: ${t.label} has reached its limit.`;
    else if (t.state === 'over' && !t.stale) verdict = `${nm}: ${t.label} is on track to run out early.`;
    else if (t.state === 'tight' && !t.stale) verdict = `${nm}: ${t.label} is cutting it close. Everything else is fine.`;
    else verdict = 'Everything is on pace.';
  }
  const rowHTML = (r) => {
    const nm = UsageProviders.name(r.pid);
    const plan = r.plan && r.plan !== 'Unknown' ? `<span class="ovplan">${U.esc(r.plan)}</span>` : '';
    const ps = state.providerStatus && state.providerStatus[r.pid];
    let body;
    if (!r.sts.length) {
      body = `<p class="secondary ovnone">${ps && ps.noLimit ? 'No usage limit shown for this plan.' : ps && !ps.ok ? U.esc(ps.error || 'The last reading failed.') : 'No readings yet.'}</p>`;
    } else {
      body = r.sts.map((st) => {
        const d = U.describe(st, now), u = st.stale ? 0 : st.u;
        return `<div class="ovlim"><div class="ovlbl">${U.esc(st.label)}</div>
          <div class="bar"><div class="fill" style="width:${u}%"></div>${st.pace != null && !st.stale ? `<div class="tick" style="left:calc(${st.pace}% - 1px)"></div>` : ''}</div>
          <div class="ovpct num">${U.pct(u)}</div>
          <span class="status ${d.cls}"><span class="ic">${d.icon}</span>${d.label}</span>
          <div class="ovreset secondary">${U.esc(d.resetTxt)}</div></div>`;
      }).join('');
    }
    return `<section class="panel ovrow"><div class="ovhead"><button class="ovname" data-p="${r.pid}">${U.esc(nm)}</button>${plan}<button class="ovgo" data-p="${r.pid}">Details &rsaquo;</button></div>${body}</section>`;
  };
  $('main').innerHTML = `<div class="ovverdict panel">${U.esc(verdict)}</div><div class="ovgrid">${rows.map(rowHTML).join('')}</div>`;
  document.querySelectorAll('.ovname, .ovgo').forEach((b) => { b.onclick = () => { provider = b.dataset.p; pickedTab = true; render(); }; });
}

function extras(snaps, key) {
  let last = null;
  for (let i = snaps.length - 1; i >= 0; i--) if (snaps[i].l && snaps[i].l[key]) { last = snaps[i].l[key]; break; }
  if (!last) return '';
  const bits = [];
  if (last.parts) bits.push(Object.entries(last.parts).map(([n, v]) => `${U.esc(n.charAt(0).toUpperCase() + n.slice(1))} ${Math.round(v)}%`).join(', ') + ' of usage');
  if (last.credits != null) bits.push('Extra credits $' + last.credits.toFixed(2));
  return bits.length ? `<div class="reset">${bits.join(' · ')}</div>` : '';
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
      ${extras(snaps, k)}
    </div>`;
  }).join('');
}

function renderSimple(snaps, key, now) {
  const pts = C.series(snaps, key).map((p) => ({ t: p.t, v: p.u, r: p.r }));
  if (pts.length < 2) { $('wkChart').innerHTML = '<p class="secondary" style="padding:8px 0">Needs at least two readings to draw a line.</p>'; return; }
  Ch.line($('wkChart'), {
    xMin: pts[0].t, xMax: Math.max(now, pts[pts.length - 1].t), height: 200,
    series: [{ points: pts, color: 'var(--series-1)' }], markers: [],
    tip: (p) => `<b>${U.pct(p.v)}</b> used<br><span class="muted">${new Date(p.t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`,
  });
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
  const raw = demo || provider !== 'claude' ? null : state.lastRaw;
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
  $('csv').onclick = () => download(provider + '-usage.csv', C.toCSV(snaps), 'text/csv');
  $('json').onclick = () => download(provider + '-usage.json', JSON.stringify(snaps), 'application/json');
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
if (HAS_CHROME) {
  const pm = UsageMenu.mount($('provMenu'));
  if (params.get('providers') === '1') pm.open(true); // sent here from the popup to grant Grok permission
} else { $('provMenu').hidden = true; }
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
