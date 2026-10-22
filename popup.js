const C = UsageCore, U = UsageUI;

async function render() {
  const { snapshots = [], org, lastStatus } = await chrome.storage.local.get(['snapshots', 'org', 'lastStatus']);
  const now = Date.now();
  document.getElementById('plan').textContent = org && org.plan && org.plan !== 'Unknown' ? org.plan : '';
  document.getElementById('err').innerHTML = lastStatus && !lastStatus.ok
    ? `<div class="err">${U.esc(lastStatus.error)}</div>` : '';
  document.getElementById('updated').textContent = lastStatus && lastStatus.ok ? 'Updated ' + U.ago(lastStatus.at) : '';

  const rows = document.getElementById('rows');
  const keys = C.allKeys(snapshots);
  if (!keys.length) {
    rows.innerHTML = '<div class="empty">No readings yet. Make sure you are signed in to claude.ai in Chrome, then press Refresh.</div>';
    return;
  }
  rows.innerHTML = keys.map((k) => {
    const st = C.status(snapshots, k, now);
    if (!st) return '';
    const d = U.describe(st, now);
    const u = st.stale ? 0 : st.u;
    return `<div class="row">
      <div class="top"><span>${U.esc(st.label)}</span><span class="v num">${U.pct(u)}</span></div>
      <div class="bar"><div class="fill" style="width:${u}%"></div>${st.pace != null && !st.stale ? `<div class="tick" style="left:calc(${st.pace}% - 1px)" title="Where you'd be at an even pace"></div>` : ''}</div>
      <div class="meta"><span class="status ${d.cls}"><span class="ic">${d.icon}</span>${d.label}</span><span class="muted">${st.r && !st.stale ? 'Resets in ' + U.dur(st.r - now) : ''}</span></div>
    </div>`;
  }).join('');
}

document.getElementById('open').onclick = () => { chrome.runtime.sendMessage({ type: 'openDashboard' }); window.close(); };
document.getElementById('refresh').onclick = async (e) => {
  e.target.disabled = true; e.target.textContent = 'Reading…';
  await chrome.runtime.sendMessage({ type: 'poll' });
  e.target.disabled = false; e.target.textContent = 'Refresh';
  render();
};
render();
