/*
 * Core logic shared by the background worker, popup, dashboard and tests.
 * No DOM or chrome.* calls in here, so it runs in Node too.
 *
 * Snapshot shape stored on disk:
 *   { t: <epoch ms>, l: { <limitKey>: { u: <percent used 0-100>, r: <reset epoch ms or null> } } }
 */
(function (root) {
  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const SAME_RESET_TOLERANCE = 15 * 60e3; // resets_at can wobble a little between reads

  // ---------- Parsing the claude.ai usage response ----------
  // The endpoint is undocumented, so parse defensively: any object with a numeric
  // "utilization" is treated as a limit, whatever its key is called.
  function parseUsage(json) {
    const limits = {};
    if (!json || typeof json !== 'object') return limits;
    const visit = (obj, prefix, depth) => {
      for (const [key, val] of Object.entries(obj)) {
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        const name = prefix ? prefix + '.' + key : key;
        const util = pickNumber(val, ['utilization', 'utilization_percent', 'percent_used', 'used_percent']);
        if (util !== null) {
          const resetRaw = val.resets_at ?? val.reset_at ?? val.resetsAt ?? null;
          const r = resetRaw ? Date.parse(resetRaw) : NaN;
          limits[name] = { u: clamp(util, 0, 100), r: Number.isFinite(r) ? r : null };
        } else if (depth < 1) {
          visit(val, name, depth + 1);
        }
      }
    };
    visit(json, '', 0);
    return limits;
  }

  function pickNumber(obj, keys) {
    for (const k of keys) if (typeof obj[k] === 'number' && Number.isFinite(obj[k])) return obj[k];
    return null;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Plan from the organizations list (capabilities like "claude_max", "claude_pro").
  function pickOrg(orgs) {
    if (!Array.isArray(orgs) || !orgs.length) return null;
    const caps = (o) => (o.capabilities || []).map(String);
    const paid = orgs.find((o) => caps(o).some((c) => /claude_(max|pro)|raven|team|enterprise/i.test(c)));
    const chosen = paid || orgs.find((o) => caps(o).includes('chat')) || orgs[0];
    return { id: chosen.uuid || chosen.id, name: chosen.name || '', plan: planFromCaps(caps(chosen), chosen) };
  }
  function planFromCaps(caps, org) {
    const c = caps.join(' ').toLowerCase();
    const tier = String(org.rate_limit_tier || '').toLowerCase();
    if (/max_20x|20x/.test(tier)) return 'Max 20x';
    if (/max_5x|5x/.test(tier)) return 'Max 5x';
    if (c.includes('claude_max')) return 'Max';
    if (c.includes('claude_pro')) return 'Pro';
    if (/raven|team/.test(c)) return 'Team';
    if (c.includes('enterprise')) return 'Enterprise';
    return 'Unknown';
  }

  // ---------- Labels and window lengths ----------
  function labelFor(key) {
    const base = key.split('.').pop();
    if (base === 'five_hour') return 'Current session (5 hr)';
    if (base === 'seven_day') return 'Weekly, all models';
    const m = base.match(/^seven_day_(.+)$/);
    if (m) return 'Weekly, ' + titleCase(m[1].replace(/_/g, ' '));
    return titleCase(base.replace(/_/g, ' '));
  }
  function titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }
  function windowMs(key) {
    const k = key.toLowerCase();
    if (/five_hour|5h|session/.test(k)) return 5 * HOUR;
    if (/seven_day|week/.test(k)) return 7 * DAY;
    if (/day/.test(k)) return DAY;
    return 7 * DAY;
  }
  // Sort order: session first, then weekly all-models, then per-model weeklies.
  function sortKeys(keys) {
    const rank = (k) => (k.endsWith('five_hour') ? 0 : k.endsWith('seven_day') ? 1 : 2);
    return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }
  function headlineKey(keys) {
    return keys.find((k) => k.endsWith('seven_day')) || keys.find((k) => k.endsWith('five_hour')) || keys[0] || null;
  }

  // ---------- Series and windows ----------
  function allKeys(snaps) {
    const s = new Set();
    for (const sn of snaps) for (const k of Object.keys(sn.l || {})) s.add(k);
    return sortKeys(s);
  }
  function series(snaps, key) {
    const out = [];
    for (const sn of snaps) {
      const v = sn.l && sn.l[key];
      if (v) out.push({ t: sn.t, u: v.u, r: v.r });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function isNewWindow(prev, cur) {
    if (prev.r && cur.r && Math.abs(prev.r - cur.r) > SAME_RESET_TOLERANCE) return true;
    if (prev.r && cur.t > prev.r + 60e3) return true; // passed the reset time
    if (cur.u < prev.u - 3) return true; // usage dropped, so the window rolled
    return false;
  }
  function windows(pts, key) {
    const len = windowMs(key);
    const out = [];
    let cur = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!cur || isNewWindow(pts[i - 1], p)) {
        cur = { start: p.r ? p.r - len : p.t, end: p.r || p.t + len, points: [], peak: 0 };
        out.push(cur);
      }
      cur.points.push(p);
      cur.peak = Math.max(cur.peak, p.u);
      if (p.r) { cur.end = p.r; cur.start = p.r - len; }
    }
    return out;
  }

  // ---------- Current status, pace, projection ----------
  function status(snaps, key, now) {
    const pts = series(snaps, key);
    if (!pts.length) return null;
    const last = pts[pts.length - 1];
    const len = windowMs(key);
    const out = { key, label: labelFor(key), u: last.u, r: last.r, readAt: last.t, windowMs: len };
    // A reset time in the past means the window has rolled and usage is back near 0.
    if (last.r && now > last.r) {
      out.stale = true;
      out.state = 'reset';
      return out;
    }
    if (!last.r) {
      out.state = last.u > 0 ? 'unknown' : 'idle';
      return out;
    }
    const start = last.r - len;
    const elapsed = Math.max(now - start, 1);
    out.pace = clamp((elapsed / len) * 100, 0, 100);
    out.remainingMs = last.r - now;
    if (last.u >= 99.5) {
      out.state = 'limit';
      return out;
    }
    if (last.u <= 0) {
      out.state = 'idle';
      out.projectedAtReset = 0;
      return out;
    }
    const rate = last.u / elapsed; // percent per ms, averaged over this window so far
    out.ratePerDay = rate * DAY;
    out.projectedAtReset = last.u + rate * (last.r - now);
    const hitAt = now + (100 - last.u) / rate;
    out.hitAt = hitAt < last.r ? hitAt : null;
    const ahead = last.u - out.pace;
    // A straight-line projection that lands just over 100% is "cutting it close", not a firm run-out.
    const firmRunOut = out.hitAt && (out.projectedAtReset >= 115 || out.hitAt - now < DAY && key.indexOf('five_hour') < 0 || key.endsWith('five_hour') && out.projectedAtReset >= 110);
    out.state = firmRunOut ? 'over' : out.hitAt ? 'tight' : ahead > 10 ? 'ahead' : 'ok';
    return out;
  }

  // ---------- Usage per day / hour ----------
  // Turns the running percentage into "points of the limit used" between readings.
  function deltas(pts) {
    const out = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = isNewWindow(a, b) ? b.u : b.u - a.u;
      if (d > 0) out.push({ t: b.t, d });
    }
    return out;
  }
  function dayKey(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dailyUsage(snaps, key, days, now) {
    const pts = series(snaps, key);
    if (!pts.length) return [];
    const byDay = {};
    for (const x of deltas(pts)) byDay[dayKey(x.t)] = (byDay[dayKey(x.t)] || 0) + x.d;
    const first = new Date(pts[0].t); first.setHours(0, 0, 0, 0);
    const out = [];
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      if (d < first) continue;
      const k = dayKey(d.getTime());
      out.push({ day: k, date: d.getTime(), value: byDay[k] || 0, partial: i === 0 });
    }
    return out;
  }
  function hourlyProfile(snaps, key) {
    const pts = series(snaps, key);
    const sums = new Array(24).fill(0);
    const ds = deltas(pts);
    for (const x of ds) sums[new Date(x.t).getHours()] += x.d;
    const spanDays = pts.length > 1 ? Math.max((pts[pts.length - 1].t - pts[0].t) / DAY, 1) : 1;
    return sums.map((s, h) => ({ hour: h, value: s / spanDays }));
  }

  // ---------- Plan fit ----------
  function planFit(snaps, now, plan) {
    const keys = allKeys(snaps);
    const weeklyKey = keys.find((k) => k.endsWith('seven_day'));
    const sessionKey = keys.find((k) => k.endsWith('five_hour'));
    const firstT = snaps.length ? snaps[0].t : now;
    const daysTracked = (now - firstT) / DAY;
    const res = { daysTracked, weeklyPeaks: [], sessionHits30d: 0, sessionWindows30d: 0, weeklyHits: 0, verdict: 'collecting' };
    if (weeklyKey) {
      const ws = windows(series(snaps, weeklyKey), weeklyKey);
      res.weeklyPeaks = ws.map((w) => ({ start: w.start, end: w.end, peak: w.peak, complete: w.end <= now }));
      res.weeklyHits = ws.filter((w) => w.peak >= 99.5).length;
    }
    if (sessionKey) {
      const ws = windows(series(snaps, sessionKey), sessionKey).filter((w) => w.end > now - 30 * DAY);
      res.sessionWindows30d = ws.length;
      res.sessionHits30d = ws.filter((w) => w.peak >= 99.5).length;
    }
    const weeks = Math.max(daysTracked / 7, 1 / 7);
    res.sessionHitsPerWeek = res.sessionHits30d / Math.min(weeks, 30 / 7);
    const weeklyStatus = weeklyKey ? status(snaps, weeklyKey, now) : null;
    const peaks = res.weeklyPeaks.map((w) => (w.complete ? w.peak : Math.max(w.peak, weeklyStatus?.projectedAtReset ?? w.peak)));
    res.avgWeeklyPeak = peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : null;

    if (daysTracked < 3) {
      res.verdict = 'collecting';
      res.message = 'Still learning your pattern. Give it about a week of normal use for a reliable read.';
      return res;
    }
    const isMax = /max/i.test(plan || '');
    if (res.weeklyHits > 0 || res.sessionHitsPerWeek >= 3 || (weeklyStatus && weeklyStatus.state === 'over')) {
      res.verdict = 'upgrade';
      res.message = res.weeklyHits > 0
        ? `You have hit the weekly limit ${res.weeklyHits === 1 ? 'once' : res.weeklyHits + ' times'} since tracking started. A bigger plan, or extra usage for heavy weeks, is worth pricing out.`
        : res.sessionHitsPerWeek >= 3
          ? `You are hitting the 5 hour session limit about ${res.sessionHitsPerWeek.toFixed(1)} times a week. If those interruptions cost you real work time, the next tier up is worth considering.`
          : 'At your current pace you will run out before this week resets. If this is a normal week for you, look at the next tier up.';
    } else if (isMax && res.avgWeeklyPeak !== null && res.avgWeeklyPeak < 35) {
      res.verdict = 'downgrade';
      res.message = `Your weeks peak around ${Math.round(res.avgWeeklyPeak)}% of the limit on average. A smaller plan would likely still cover you.`;
    } else {
      res.verdict = 'fits';
      res.message = res.avgWeeklyPeak !== null
        ? `Your weeks peak around ${Math.round(res.avgWeeklyPeak)}% of the weekly limit and you are not hitting caps. Your current plan fits.`
        : 'You are not hitting caps. Your current plan fits.';
    }
    if (daysTracked < 7) res.message += ' (Based on less than a week of data.)';
    return res;
  }

  // ---------- Storage helpers ----------
  function sameLimits(a, b) {
    const ka = Object.keys(a || {}), kb = Object.keys(b || {});
    if (ka.length !== kb.length) return false;
    return ka.every((k) => b[k] && b[k].u === a[k].u && b[k].r === a[k].r);
  }
  // Add a snapshot, skipping exact repeats less than an hour apart, and drop data older than keepDays.
  function appendSnapshot(snaps, snap, keepDays) {
    const last = snaps[snaps.length - 1];
    if (last && sameLimits(last.l, snap.l) && snap.t - last.t < HOUR) return snaps;
    const cutoff = snap.t - (keepDays || 120) * DAY;
    return snaps.filter((s) => s.t >= cutoff).concat([snap]);
  }
  function toCSV(snaps) {
    const keys = allKeys(snaps);
    const head = ['timestamp_iso'].concat(...keys.map((k) => [k + '_used_pct', k + '_resets_at_iso']));
    const rows = snaps.map((s) => [new Date(s.t).toISOString()].concat(
      ...keys.map((k) => (s.l[k] ? [s.l[k].u, s.l[k].r ? new Date(s.l[k].r).toISOString() : ''] : ['', '']))));
    return [head].concat(rows).map((r) => r.join(',')).join('\n');
  }

  const api = { HOUR, DAY, parseUsage, pickOrg, labelFor, windowMs, sortKeys, headlineKey, allKeys, series, windows,
    status, deltas, dailyUsage, hourlyProfile, planFit, appendSnapshot, toCSV, dayKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UsageCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
