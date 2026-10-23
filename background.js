/* Background worker: reads claude.ai usage on a timer and stores snapshots locally. */
importScripts('lib/providers.js', 'lib/core.js', 'lib/grok.js', 'lib/gemini.js', 'lib/chatgpt.js');
const C = self.UsageCore;

const POLL_MINUTES = 15;
const GROK_MINUTES = 60; // opening a tab is heavier than a fetch, so Grok and Gemini are read less often
const GROK_URL = 'https://grok.com/?_s=usage';
const BASE = 'https://claude.ai';
const KEEP_DAYS = 120;

chrome.runtime.onInstalled.addListener((d) => {
  schedule();
  // First install: nothing is tracked until the person picks a provider, so send them to the dashboard to choose.
  if (d && d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html?providers=1') });
  poll('install');
});
chrome.runtime.onStartup.addListener(() => { schedule(); poll('startup'); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') poll('timer'); if (a.name === 'grok') pollGrok('timer'); if (a.name === 'gemini') pollGemini('timer'); if (a.name === 'chatgpt') pollChatGPT('timer'); });

// Also read right after you load a claude.ai page, since that's when usage is changing.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url || !tab.url.startsWith(BASE)) return;
  const { lastStatus } = await chrome.storage.local.get('lastStatus');
  if (!lastStatus || Date.now() - lastStatus.at > 5 * 60e3) poll('page');
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'poll') { Promise.all([poll('manual'), pollGrok('manual'), pollGemini('manual'), pollChatGPT('manual')]).then(([r]) => reply(r)); return true; }
  if (msg && msg.type === 'claudeToggled') { claudeEnabled().then(async (on) => { if (!on) { await refreshBadge(); reply({ ok: true }); } else reply(await poll('enable')); }); return true; }
  if (msg && msg.type === 'chatgptToggled') { chrome.alarms.create('chatgpt', { periodInMinutes: GROK_MINUTES, delayInMinutes: 1 }); pollChatGPT('enable').then(async (r) => { await refreshBadge(); reply(r); }); return true; }
  if (msg && msg.type === 'geminiToggled') { chrome.alarms.create('gemini', { periodInMinutes: GROK_MINUTES, delayInMinutes: 1 }); pollGemini('enable').then(async (r) => { await refreshBadge(); reply(r); }); return true; }
  if (msg && msg.type === 'grokToggled') { chrome.alarms.create('grok', { periodInMinutes: GROK_MINUTES, delayInMinutes: 1 }); pollGrok('enable').then(async (r) => { await refreshBadge(); reply(r); }); return true; }
  if (msg && msg.type === 'syncNow') { syncCloud().then(reply, (e) => reply({ ok: false, error: String(e.message || e) })); return true; }
  if (msg && msg.type === 'openDashboard') { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); reply({ ok: true }); }
  return false;
});

// A provider is turned on once its site permission is granted. The popup can close while Chrome's prompt is
// showing, so this finishes the job from here: the popup saved its intent in pendingOn before asking.
const PROVIDER_ORIGINS = {
  claude: { origin: 'https://claude.ai/*', key: 'claudeOn', poll: () => poll('enable') },
  grok: { origin: 'https://grok.com/*', key: 'grokOn', poll: () => { chrome.alarms.create('grok', { periodInMinutes: GROK_MINUTES, delayInMinutes: 1 }); return pollGrok('enable'); } },
  gemini: { origin: 'https://gemini.google.com/*', key: 'geminiOn', poll: () => { chrome.alarms.create('gemini', { periodInMinutes: GROK_MINUTES, delayInMinutes: 1 }); return pollGemini('enable'); } },
  chatgpt: { origin: 'https://chatgpt.com/*', key: 'chatgptOn', poll: () => { chrome.alarms.create('chatgpt', { periodInMinutes: GROK_MINUTES, delayInMinutes: 1 }); return pollChatGPT('enable'); } },
};
chrome.permissions.onAdded.addListener(async (perms) => {
  const { pendingOn = {} } = await chrome.storage.local.get('pendingOn');
  const now = Date.now();
  let changed = false;
  for (const [id, P] of Object.entries(PROVIDER_ORIGINS)) {
    if (!(perms.origins || []).includes(P.origin)) continue;
    const at = pendingOn[id];
    if (!at) continue;
    delete pendingOn[id];
    changed = true;
    if (now - at > 10 * 60e3) continue; // an old, abandoned request
    await chrome.storage.local.set({ [P.key]: true });
    P.poll().catch(() => {});
  }
  if (changed) await chrome.storage.local.set({ pendingOn });
});

function schedule() {
  chrome.alarms.create('poll', { periodInMinutes: POLL_MINUTES, delayInMinutes: 1 });
  chrome.alarms.create('grok', { periodInMinutes: GROK_MINUTES, delayInMinutes: 2 });
  chrome.alarms.create('gemini', { periodInMinutes: GROK_MINUTES, delayInMinutes: 3 });
  chrome.alarms.create('chatgpt', { periodInMinutes: GROK_MINUTES, delayInMinutes: 4 });
}

// Claude and Grok readings both read-modify-write the snapshot list, so they take turns.
let chain = Promise.resolve();
function exclusive(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

let inFlight = null;
function poll(reason) {
  if (!inFlight) inFlight = exclusive(() => doPoll(reason)).finally(() => { inFlight = null; });
  return inFlight;
}

// Claude is on if the person turned it on, or (for people who installed before v0.3) if it already has data.
async function claudeEnabled() {
  const { claudeOn, org, snapshots = [] } = await chrome.storage.local.get(['claudeOn', 'org', 'snapshots']);
  if (typeof claudeOn === 'boolean') return claudeOn;
  return !!org || snapshots.some((x) => !x.p || x.p === 'claude');
}

async function doPoll(reason) {
  const now = Date.now();
  if (!(await claudeEnabled())) return { skipped: true };
  try {
    if (!(await chrome.permissions.contains({ origins: ['https://claude.ai/*'] }))) {
      throw new Error('Claude tracking needs permission to read claude.ai. Open the Providers menu, uncheck Claude, then check it again.');
    }
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
    if (!Object.keys(limits).length) {
      // Plans change (Free to Pro), so confirm the plan with a fresh look before deciding.
      try { const again = C.pickOrg(await getJSON('/api/organizations')); if (again) { again.fetchedAt = now; org = again; } } catch (e) { /* keep the cached plan */ }
      if (org.plan === 'Free') {
        const lastStatus = { ok: true, at: now, reason, free: true };
        await chrome.storage.local.set({ org, lastRaw: { at: now, body: raw }, lastStatus });
        await refreshBadge();
        return lastStatus;
      }
      throw new Error('Claude did not report any usage limits for this account, or the data came back in a format this version does not recognize. Open the dashboard and check "Raw response".');
    }
    const snaps = C.appendSnapshot(store.snapshots || [], { t: now, p: 'claude', l: limits }, KEEP_DAYS);
    const lastStatus = { ok: true, at: now, reason };
    await chrome.storage.local.set({ org, snapshots: snaps, lastRaw: { at: now, body: raw }, lastStatus });
    await refreshBadge();
    await maybeNotify(snaps, now);
    await syncCloud().catch(() => {});
    return lastStatus;
  } catch (e) {
    const lastStatus = { ok: false, at: now, reason, error: String(e && e.message ? e.message : e) };
    await chrome.storage.local.set({ lastStatus });
    await refreshBadge({ error: true });
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

const STATE_COLORS = { ok: '#0ca30c', idle: '#0ca30c', ahead: '#c98500', tight: '#c98500', over: '#d03b3b', limit: '#d03b3b', reset: '#8a8984', early: '#8a8984', unknown: '#8a8984' };
// The badge shows the most urgent limit across every provider that is turned on. The tooltip lists each provider's most urgent limit.
const STATE_RANK = { limit: 6, over: 5, tight: 4, ahead: 3, ok: 2, idle: 2, early: 1, reset: 0, unknown: 0 };
const STATE_PHRASE = { limit: 'limit reached', over: 'will run out early', tight: 'cutting it close', ahead: 'ahead of pace' };
async function refreshBadge(opts) {
  const now = Date.now();
  const st = await chrome.storage.local.get(['snapshots', 'grokOn', 'geminiOn', 'chatgptOn']);
  const on = { claude: await claudeEnabled(), grok: !!st.grokOn, gemini: !!st.geminiOn, chatgpt: !!st.chatgptOn };
  const all = st.snapshots || [];
  const worse = (x, y) => !y || STATE_RANK[x.state] > STATE_RANK[y.state] || (STATE_RANK[x.state] === STATE_RANK[y.state] && x.u > y.u);
  const items = [];
  for (const pid of C.providersIn(all)) {
    if (!on[pid]) continue;
    const sn = C.forProvider(all, pid);
    let best = null;
    for (const key of C.allKeys(sn)) {
      const s = C.status(sn, key, now);
      if (s && worse(s, best)) best = s;
    }
    if (best) items.push({ pid, st: best });
  }
  if (!items.length) {
    if (opts && opts.error) { chrome.action.setBadgeText({ text: '!' }); chrome.action.setBadgeBackgroundColor({ color: '#8a8984' }); chrome.action.setTitle({ title: 'AI Usage Tracker: the last reading failed. Open the popup for details.' }); return; }
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'AI Usage Tracker' });
    return;
  }
  items.sort((x, y) => (worse(x.st, y.st) ? -1 : 1));
  const top = items[0].st;
  chrome.action.setBadgeText({ text: top.stale ? '0' : String(Math.round(top.u)) });
  chrome.action.setBadgeBackgroundColor({ color: STATE_COLORS[top.state] || '#8a8984' });
  const lines = items.map(({ pid, st: s }) => `${UsageProviders.name(pid)}: ${s.label} ${s.stale ? 'has reset' : Math.round(s.u) + '%'}${!s.stale && STATE_PHRASE[s.state] ? ' (' + STATE_PHRASE[s.state] + ')' : ''}`);
  chrome.action.setTitle({ title: lines.join('\n') });
}

// One alert per threshold per window, plus a heads-up when the weekly pace says you'll run out early.
async function maybeNotify(snaps, now) {
  const { settings = { notify: true }, notified = {} } = await chrome.storage.local.get(['settings', 'notified']);
  if (!settings.notify) return;
  const fresh = {};
  for (const [k, v] of Object.entries(notified)) if (v > now - 10 * 24 * 3600e3) fresh[k] = v;
  for (const pid of C.providersIn(snaps)) {
    const psn = C.forProvider(snaps, pid);
    const who = pid === 'claude' ? '' : UsageProviders.name(pid) + ': ';
    for (const key of C.allKeys(psn)) {
      const st = C.status(psn, key, now);
      if (!st || st.stale || !st.r) continue;
      const isSession = key.endsWith('five_hour');
      const alerts = [];
      for (const thr of isSession ? [90] : [75, 90]) if (st.u >= thr) alerts.push(['t' + thr, `${who}${st.label} is at ${Math.round(st.u)}%`, `Resets ${fmtWhen(st.r)}.`]);
      if (!isSession && st.state === 'over') alerts.push(['proj', `${who}${st.label}: on track to run out early`, `At this pace you'll hit the limit around ${fmtWhen(st.hitAt)}, before it resets ${fmtWhen(st.r)}.`]);
      for (const [tag, title, message] of alerts) {
        const id = `${key}|${Math.round(st.r / 3600e3)}|${tag}`;
        if (fresh[id]) continue;
        fresh[id] = now;
        chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 });
      }
    }
  }
  await chrome.storage.local.set({ notified: fresh });
}
function fmtWhen(t) {
  return new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

chrome.notifications.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));

// Open a page in a background tab, run a function in it, and return what it found. The caller closes the tab.
async function readTab(url, func, onTab) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  onTab(tabId);
  await new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onU); clearTimeout(to); resolve(); };
    const onU = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const to = setTimeout(done, 25000);
    chrome.tabs.onUpdated.addListener(onU);
  });
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [20000] });
  return result;
}

// ---------- Grok ----------
// Opt-in. Opens grok.com's Usage panel in a background tab, reads it, and closes the tab.
let grokFlight = null;
function pollGrok(reason) {
  if (!grokFlight) grokFlight = exclusive(() => doGrok(reason)).finally(() => { grokFlight = null; });
  return grokFlight;
}
async function setGrokStatus(st) {
  const { providerStatus = {} } = await chrome.storage.local.get('providerStatus');
  providerStatus.grok = st;
  await chrome.storage.local.set({ providerStatus });
}
async function doGrok(reason) {
  const { grokOn } = await chrome.storage.local.get('grokOn');
  if (!grokOn) return { skipped: true };
  const now = Date.now();
  let tabId = null;
  try {
    const allowed = await chrome.permissions.contains({ origins: ['https://grok.com/*'] });
    if (!allowed) throw new Error('Grok tracking needs permission to read grok.com. Turn it off and on again on the dashboard.');
    const result = await readTab(GROK_URL, UsageGrok.scrapeInPage, (id) => { tabId = id; });
    if (!result) throw new Error('Could not read grok.com.');
    if (result.signedOut) throw new Error('Not signed in to Grok in this Chrome profile.');
    const g = UsageGrok.parseText(result.text);
    const store = await chrome.storage.local.get(['snapshots', 'plans']);
    const plans = Object.assign({}, store.plans, g.plan ? { grok: g.plan } : {});
    if (g.u == null) {
      if (!result.text) throw new Error('Could not find the Usage panel on grok.com. Grok may have changed its layout.');
      await chrome.storage.local.set({ plans });
      await setGrokStatus({ ok: true, at: now, reason, noLimit: true, plan: g.plan });
      return { ok: true, noLimit: true };
    }
    const lim = { u: g.u };
    if (g.r) lim.r = g.r;
    if (g.parts) lim.parts = g.parts;
    if (g.credits != null) lim.credits = g.credits;
    const snaps = C.appendSnapshot(store.snapshots || [], { t: now, p: 'grok', l: { grok_seven_day: lim } }, KEEP_DAYS);
    await chrome.storage.local.set({ snapshots: snaps, plans });
    await setGrokStatus({ ok: true, at: now, reason, plan: g.plan });
    await refreshBadge();
    await maybeNotify(snaps, now);
    await syncCloud().catch(() => {});
    return { ok: true };
  } catch (e) {
    const st = { ok: false, at: now, reason, error: String(e && e.message ? e.message : e) };
    await setGrokStatus(st);
    return st;
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ---------- Gemini ----------
// Opt-in, like Grok: reads gemini.google.com/usage in a background tab about once an hour.
const GEMINI_URL = 'https://gemini.google.com/usage';
let geminiFlight = null;
function pollGemini(reason) {
  if (!geminiFlight) geminiFlight = exclusive(() => doGemini(reason)).finally(() => { geminiFlight = null; });
  return geminiFlight;
}
async function setProviderStatus(pid, st) {
  const { providerStatus = {} } = await chrome.storage.local.get('providerStatus');
  providerStatus[pid] = st;
  await chrome.storage.local.set({ providerStatus });
}
async function doGemini(reason) {
  const { geminiOn } = await chrome.storage.local.get('geminiOn');
  if (!geminiOn) return { skipped: true };
  const now = Date.now();
  let tabId = null;
  try {
    if (!(await chrome.permissions.contains({ origins: ['https://gemini.google.com/*'] }))) {
      throw new Error('Gemini tracking needs permission to read gemini.google.com. Turn it off and on again in the Providers menu.');
    }
    const result = await readTab(GEMINI_URL, UsageGemini.scrapeInPage, (id) => { tabId = id; });
    if (!result) throw new Error('Could not read gemini.google.com.');
    if (result.signedOut) throw new Error('Not signed in to Gemini in this Chrome profile.');
    const g = UsageGemini.parseText(result.text, now);
    const store = await chrome.storage.local.get(['snapshots', 'plans']);
    const plans = Object.assign({}, store.plans, g.plan ? { gemini: g.plan } : {});
    if (!g.session && !g.weekly) {
      if (!result.text) throw new Error('Could not find the usage meters on gemini.google.com. Gemini may have changed its layout.');
      await chrome.storage.local.set({ plans });
      await setProviderStatus('gemini', { ok: true, at: now, reason, noLimit: true, plan: g.plan });
      return { ok: true, noLimit: true };
    }
    const l = {};
    if (g.session) l.gemini_five_hour = g.session;
    if (g.weekly) l.gemini_seven_day = g.weekly;
    const snaps = C.appendSnapshot(store.snapshots || [], { t: now, p: 'gemini', l }, KEEP_DAYS);
    await chrome.storage.local.set({ snapshots: snaps, plans });
    await setProviderStatus('gemini', { ok: true, at: now, reason, plan: g.plan });
    await refreshBadge();
    await maybeNotify(snaps, now);
    await syncCloud().catch(() => {});
    return { ok: true };
  } catch (e) {
    const st = { ok: false, at: now, reason, error: String(e && e.message ? e.message : e) };
    await setProviderStatus('gemini', st);
    return st;
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ---------- ChatGPT ----------
// Opt-in, like Grok and Gemini: reads chatgpt.com/settings/usage in a background tab about once an hour.
const CHATGPT_URL = 'https://chatgpt.com/settings/usage';
const CHATGPT_BILLING = 'https://chatgpt.com/settings/billing';
const CHATGPT_HOME = 'https://chatgpt.com/';
let chatgptFlight = null;
function pollChatGPT(reason) {
  if (!chatgptFlight) chatgptFlight = exclusive(() => doChatGPT(reason)).finally(() => { chatgptFlight = null; });
  return chatgptFlight;
}
async function doChatGPT(reason) {
  const { chatgptOn } = await chrome.storage.local.get('chatgptOn');
  if (!chatgptOn) return { skipped: true };
  const now = Date.now();
  let tabId = null;
  try {
    if (!(await chrome.permissions.contains({ origins: ['https://chatgpt.com/*'] }))) {
      throw new Error('ChatGPT tracking needs permission to read chatgpt.com. Turn it off and on again in the Providers menu.');
    }
    const result = await readTab(CHATGPT_URL, UsageChatGPT.scrapeInPage, (id) => { tabId = id; });
    if (!result) throw new Error('Could not read chatgpt.com.');
    if (result.signedOut) throw new Error('Not signed in to ChatGPT in this Chrome profile.');
    const g = UsageChatGPT.parseText(result.text, now);
    const store = await chrome.storage.local.get(['snapshots', 'plans', 'planAt']);
    let plan = result.plan && result.plan.length < 30 ? result.plan : null;
    if (!plan) {
      // The usage page has no sidebar, so the plan name comes from the home page. It rarely changes, so look about once a day.
      const planAt = store.planAt || {};
      if (!(store.plans || {}).chatgpt || now - (planAt.chatgpt || 0) > 24 * 3600e3) {
        if (tabId != null) { await chrome.tabs.remove(tabId).catch(() => {}); tabId = null; }
        try {
          // The billing page names the plan outright. The home page sidebar is the backup.
          let pr = await readTab(CHATGPT_BILLING, UsageChatGPT.scrapeBillingInPage, (id) => { tabId = id; });
          if (!(pr && pr.plan)) {
            if (tabId != null) { await chrome.tabs.remove(tabId).catch(() => {}); tabId = null; }
            pr = await readTab(CHATGPT_HOME, UsageChatGPT.scrapePlanInPage, (id) => { tabId = id; });
          }
          if (pr && pr.plan) plan = pr.plan;
        } catch (e) { /* the plan label is a nicety, so a failure here is not an error */ }
        await chrome.storage.local.set({ planAt: Object.assign({}, planAt, { chatgpt: now }) });
      }
    }
    const plans = Object.assign({}, store.plans, plan ? { chatgpt: plan } : {});
    const keys = Object.keys(g.limits);
    if (!keys.length) {
      if (!result.text) throw new Error('Could not find the usage limits on chatgpt.com. ChatGPT may have changed its layout.');
      await chrome.storage.local.set({ plans });
      await setProviderStatus('chatgpt', { ok: true, at: now, reason, noLimit: true, plan });
      return { ok: true, noLimit: true };
    }
    // ChatGPT shows "Resets in 30d 0h", rounded down, so the estimated reset time wobbles by up to an hour between readings.
    // Keep the previous estimate while it stays close, so one window is not mistaken for many.
    const prev = C.forProvider(store.snapshots || [], 'chatgpt').pop();
    const l = {};
    for (const k of keys) {
      const lim = Object.assign({}, g.limits[k]);
      const pr = prev && prev.l && prev.l[k] && prev.l[k].r;
      if (lim.approx && pr && pr > now && Math.abs(pr - lim.r) < 100 * 60e3) lim.r = pr;
      delete lim.approx;
      l[k] = lim;
    }
    const snaps = C.appendSnapshot(store.snapshots || [], { t: now, p: 'chatgpt', l }, KEEP_DAYS);
    await chrome.storage.local.set({ snapshots: snaps, plans });
    await setProviderStatus('chatgpt', { ok: true, at: now, reason, plan });
    await refreshBadge();
    await maybeNotify(snaps, now);
    await syncCloud().catch(() => {});
    return { ok: true };
  } catch (e) {
    const st = { ok: false, at: now, reason, error: String(e && e.message ? e.message : e) };
    await setProviderStatus('chatgpt', st);
    return st;
  } finally {
    if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ---------- Optional cloud sync (Supabase) ----------
// settings.sync = { url, key, token, name, through (epoch ms of last synced reading) }
let syncing = null;
function syncCloud() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}
async function doSync() {
  const { sync, snapshots = [], org, plans = {} } = await chrome.storage.local.get(['sync', 'snapshots', 'org', 'plans']);
  if (!sync || !sync.url || !sync.token) return { ok: true, skipped: true };
  const pending = snapshots.filter((s) => s.t > (sync.through || 0));
  let sent = 0;
  try {
    for (let i = 0; i < pending.length; i += 200) {
      const batch = pending.slice(i, i + 200).map((s) => ({ t: s.t, l: s.l, plan: (s.p || 'claude') === 'claude' ? org && org.plan : plans[s.p], tool: s.p || 'claude' }));
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
