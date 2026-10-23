const C = UsageCore, U = UsageUI;

async function render() {
  const { snapshots: allSnaps = [], org, lastStatus, claudeOn: co, grokOn = false, geminiOn = false, chatgptOn = false, providerStatus = {}, plans = {} } = await chrome.storage.local.get(['snapshots', 'org', 'lastStatus', 'claudeOn', 'grokOn', 'geminiOn', 'chatgptOn', 'providerStatus', 'plans']);
  const planOf = (pid) => pid === 'claude' ? (org && org.plan && org.plan !== 'Unknown' ? org.plan : '') : (plans[pid] || '');
  const claudeOn = typeof co === 'boolean' ? co : !!org;
  // Providers that are turned off are hidden. Their saved history stays and comes back if they are turned on again.
  const on = { claude: claudeOn, grok: grokOn, gemini: geminiOn, chatgpt: chatgptOn };
  const snapshots = allSnaps.filter((s) => on[s.p || 'claude']);
  const now = Date.now();
  const rows = document.getElementById('rows');
  rows.classList.remove('cols'); document.body.classList.remove('wide');
  const err = [];
  if (claudeOn && lastStatus && !lastStatus.ok) err.push(lastStatus.error);
  for (const pid of ['grok', 'gemini', 'chatgpt']) if (on[pid] && providerStatus[pid] && !providerStatus[pid].ok) err.push(UsageProviders.name(pid) + ': ' + providerStatus[pid].error);
  document.getElementById('err').innerHTML = err.map((e) => `<div class="err">${U.esc(e)}</div>`).join('');
  const okAt = Math.max(claudeOn && lastStatus && lastStatus.ok ? lastStatus.at : 0, ...['grok', 'gemini', 'chatgpt'].map((pid) => on[pid] && providerStatus[pid] && providerStatus[pid].ok ? providerStatus[pid].at : 0));
  document.getElementById('updated').textContent = okAt ? 'Updated ' + U.ago(okAt) : '';
  document.getElementById('plan').textContent = '';

  if (!Object.values(on).some(Boolean) && !snapshots.length) {
    document.getElementById('title').textContent = 'AI usage';
    rows.innerHTML = '<div class="empty"><b>Nothing is being tracked yet.</b><br>Open the Providers menu above to choose what to track.</div>';
    return;
  }
  // A provider whose plan has no usage limit (ChatGPT Free, say) has no readings, but it still gets listed with its plan.
  const withData = C.providersIn(snapshots);
  const pids = UsageProviders.order.filter((pid) => withData.includes(pid) || (on[pid] && providerStatus[pid] && providerStatus[pid].ok && providerStatus[pid].noLimit));
  const noLimitMsg = '<div class="muted" style="padding:6px 0">No usage limit shown for this plan.</div>';
  document.getElementById('title').textContent = pids.length === 1 ? UsageProviders.name(pids[0]) + ' usage' : 'AI usage';
  if (pids.length === 1) document.getElementById('plan').textContent = planOf(pids[0]) ? 'Plan: ' + planOf(pids[0]) : '';
  if (pids.length > 1) {
    // Several providers: render each group under its name.
    // Three or more providers: widen the popup into two columns so it fits without scrolling.
    const wide = pids.length >= 3;
    rows.classList.toggle('cols', wide); document.body.classList.toggle('wide', wide);
    rows.innerHTML = pids.map((pid) => {
      const sn = C.forProvider(snapshots, pid);
      const body = C.allKeys(sn).map((k) => rowHTML(sn, k, now)).join('') || noLimitMsg;
      const pl = planOf(pid);
      return `<section class="pgroup"><div class="grp">${U.esc(UsageProviders.name(pid))}${pl ? ' <span class="grpplan">Plan: ' + U.esc(pl) + '</span>' : ''}</div>${body}</section>`;
    }).join('');
    return;
  }
  if (!pids.length) {
    // Something is on but no reading has arrived yet.
    if (claudeOn && org && org.plan === 'Free') {
      rows.innerHTML = '<div class="empty"><b>You\'re on Claude\'s Free plan.</b><br>Claude doesn\'t report usage percentages for free accounts, so there is nothing to track right now. If Claude starts reporting a limit for your account, it will show up here.</div>';
    } else {
      const which = UsageProviders.order.filter((pid) => on[pid]).map((pid) => UsageProviders.name(pid)).join(', ');
      rows.innerHTML = `<div class="empty">No readings yet for ${which}. Make sure you are signed in there in Chrome, then press Refresh.</div>`;
    }
    return;
  }
  const sn = C.forProvider(snapshots, pids[0]);
  rows.innerHTML = C.allKeys(sn).map((k) => rowHTML(sn, k, now)).join('') || noLimitMsg;
}

function rowHTML(snaps, k, now) {
    const st = C.status(snaps, k, now);
    if (!st) return '';
    const d = U.describe(st, now);
    const u = st.stale ? 0 : st.u;
    return `<div class="row">
      <div class="top"><span>${U.esc(st.label)}</span><span class="v num">${U.pct(u)}</span></div>
      <div class="bar"><div class="fill" style="width:${u}%"></div>${st.pace != null && !st.stale ? `<div class="tick" style="left:calc(${st.pace}% - 1px)" title="Where you'd be at an even pace"></div>` : ''}</div>
      <div class="meta"><span class="status ${d.cls}"><span class="ic">${d.icon}</span>${d.label}</span><span class="muted">${st.r && !st.stale ? 'Resets in ' + U.dur(st.r - now) : ''}</span></div>
    </div>`;
}

UsageMenu.mount(document.getElementById('provMenu'), { popup: true });
document.getElementById('open').onclick = () => { chrome.runtime.sendMessage({ type: 'openDashboard' }); window.close(); };
document.getElementById('refresh').onclick = async (e) => {
  e.target.disabled = true; e.target.textContent = 'Reading…';
  await chrome.runtime.sendMessage({ type: 'poll' });
  e.target.disabled = false; e.target.textContent = 'Refresh';
  render();
};
render();
