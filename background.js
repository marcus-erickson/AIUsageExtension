/* Background worker: reads claude.ai usage on a timer and stores snapshots locally. */
importScripts('lib/core.js');
const C = self.UsageCore;

const POLL_MINUTES = 15;
const BASE = 'https://claude.ai';
const KEEP_DAYS = 120;

chrome.runtime.onInstalled.addListener(() => { schedule(); poll('install'); });
chrome.runtime.onStartup.addListener(() => { schedule(); poll('startup'); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') poll('timer'); });

// Also read right after you load a claude.ai page, since that's when usage is changing.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !tab.url.startsWith(BASE)) return;
  const { lastStatus } = await chrome.storage.local.get('lastStatus');
  if (!lastStatus || Date.now() - lastStatus.at > 5 * 60e3) poll('page');
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'poll') { poll('manual').then(reply); return true; }
  if (msg && msg.type === 'syncNow') { syncCloud().then(reply, (e) => reply({ ok: false, error: String(e.message || e) })); return true; }
  if (msg && msg.type === 'openDashboard') { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); reply({ ok: true }); }
  return false;
});

function schedule() { chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES, delayInMinutes: 1 }); }

let inFlight = null;
function poll(reason) {
  if (!inFlight) inFlight = doPoll(reason).finally(() => { inFlight = null; });
  return inFlight;
}

async function doPoll(reason) {
  const now = Date.now();
  try {
    const store = await chrome.storage.local.get(['org', 'snapshots']);
    let org = store.org;
    if (!org || !org.id || now - (org.fetchedAt || 0) > 24 * 3600e3) {
      const orgs = await getJSON('/api/organizations');
      org = C.pickOrg(orgs);
      if (!org) throw new Error('No Claude organization found on this account.');
      org.fetchedAt = now;
    }
    const raw = await getJSON(`/api/organizations/${org.id}/usage`);
    const limits = C.parseUsage(raw);
    if (!Object.keys(limits).length) throw new Error('Usage data came back in a format this version does not recognize. Open the dashboard and check "Raw response".');
    const snaps = C.appendSnapshot(store.snapshots || [], { t: now, l: limits }, KEEP_DAYS);
    const lastStatus = { ok: true, at: now, reason };
    await chrome.storage.local.set({ org, snapshots: snaps, lastRaw: { at: now, body: raw }, lastStatus });
    await updateBadge(snaps, now);
    await maybeNotify(snaps, now);
    await syncCloud().catch(() => {});
    return lastStatus;
  } catch (e) {
    const lastStatus = { ok: false, at: now, reason, error: String(e && e.message ? e.message : e) };
    await chrome.storage.local.set({ lastStatus });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#8a8984' });
    return lastStatus;
  }
}

// Try a direct request first. If claude.ai blocks it, run the same request inside an open claude.ai tab.
async function getJSON(path) {
  let firstErr;
  try {
    const res = await fetch(BASE + path, { credentials: 'include', headers: { accept: 'application/json' } });
    if (res.ok) return await res.json();
    firstErr = httpError(res.status);
  } catch (e) { firstErr = e; }

  const tabs = await chrome.tabs.query({ url: BASE + '/*' });
  for (const tab of tabs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (p) => {
          const r = await fetch(p, { credentials: 'include', headers: { accept: 'application/json' } });
          return { status: r.status, text: await r.text() };
        },
        args: [path],
      });
      if (result && result.status >= 200 && result.status < 300) return JSON.parse(result.text);
      firstErr = httpError(result ? result.status : 0);
    } catch (e) { /* tab may be closing or discarded, try the next one */ }
  }
  if (!tabs.length && firstErr) firstErr = new Error(String(firstErr.message || firstErr) + ' Opening a claude.ai tab usually fixes this.');
  throw firstErr || new Error('Could not reach claude.ai.');
}
function httpError(status) {
  if (status === 401 || status === 403) return new Error('Not signed in to claude.ai in this Chrome profile (HTTP ' + status + ').');
  return new Error('claude.ai returned HTTP ' + status + '.');
}

const STATE_COLORS = { ok: '#0ca30c', idle: '#0ca30c', ahead: '#c98500', tight: '#c98500', over: '#d03b3b', limit: '#d03b3b', reset: '#8a8984', unknown: '#8a8984' };
async function updateBadge(snaps, now) {
  const key = C.headlineKey(C.allKeys(snaps));
  const st = key ? C.status(snaps, key, now) : null;
  if (!st) { chrome.action.setBadgeText({ text: '' }); return; }
  chrome.action.setBadgeText({ text: st.stale ? '0' : String(Math.round(st.u)) });
  chrome.action.setBadgeBackgroundColor({ color: STATE_COLORS[st.state] || '#8a8984' });
  chrome.action.setTitle({ title: `${st.label}: ${Math.round(st.u)}% used` });
}

// One alert per threshold per window, plus a heads-up when the weekly pace says you'll run out early.
async function maybeNotify(snaps, now) {
  const { settings = { notify: true }, notified = {} } = await chrome.storage.local.get(['settings', 'notified']);
  if (!settings.notify) return;
  const fresh = {};
  for (const [k, v] of Object.entries(notified)) if (v > now - 10 * 24 * 3600e3) fresh[k] = v;
  for (const key of C.allKeys(snaps)) {
    const st = C.status(snaps, key, now);
    if (!st || st.stale || !st.r) continue;
    const isSession = key.endsWith('five_hour');
    const alerts = [];
    for (const thr of isSession ? [90] : [75, 90]) if (st.u >= thr) alerts.push(['t' + thr, `${st.label} is at ${Math.round(st.u)}%`, `Resets ${fmtWhen(st.r)}.`]);
    if (!isSession && st.state === 'over') alerts.push(['proj', `${st.label}: on track to run out early`, `At this pace you'll hit the limit around ${fmtWhen(st.hitAt)}, before it resets ${fmtWhen(st.r)}.`]);
    for (const [tag, title, message] of alerts) {
      const id = `${key}|${Math.round(st.r / 3600e3)}|${tag}`;
      if (fresh[id]) continue;
      fresh[id] = now;
      chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 });
    }
  }
  await chrome.storage.local.set({ notified: fresh });
}
function fmtWhen(t) {
  return new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

chrome.notifications.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));

// ---------- Optional cloud sync (Supabase) ----------
// settings.sync = { url, key, token, name, through (epoch ms of last synced reading) }
let syncing = null;
function syncCloud() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}
async function doSync() {
  const { sync, snapshots = [], org } = await chrome.storage.local.get(['sync', 'snapshots', 'org']);
  if (!sync || !sync.url || !sync.token) return { ok: true, skipped: true };
  const pending = snapshots.filter((s) => s.t > (sync.through || 0));
  let sent = 0;
  try {
    for (let i = 0; i < pending.length; i += 200) {
      const batch = pending.slice(i, i + 200).map((s) => ({ t: s.t, l: s.l, plan: org && org.plan, tool: 'claude' }));
      const res = await fetch(sync.url.replace(/\/$/, '') + '/rest/v1/rpc/aiusage_ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: sync.key, ...(sync.key.startsWith('eyJ') ? { authorization: 'Bearer ' + sync.key } : {}) },
        body: JSON.stringify({ p_token: sync.token, p_snapshots: batch }),
      });
      if (!res.ok) throw new Error('Sync failed (HTTP ' + res.status + '): ' + (await res.text()).slice(0, 200));
      sync.through = batch[batch.length - 1].t;
      sent += batch.length;
    }
    sync.lastSyncAt = Date.now();
    sync.lastError = null;
  } catch (e) {
    sync.lastError = String(e.message || e);
  }
  await chrome.storage.local.set({ sync });
  return { ok: !sync.lastError, sent, error: sync.lastError };
}
