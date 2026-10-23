/* Formatting and status wording shared by the popup and dashboard. */
(function (root) {
  function dur(ms) {
    if (ms == null || !isFinite(ms)) return '';
    const m = Math.max(0, Math.round(ms / 60e3));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + 'd ' + (h % 24) + 'h';
    return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  }
  function when(t) {
    const d = new Date(t), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return 'today ' + time;
    const tmw = new Date(now); tmw.setDate(now.getDate() + 1);
    if (d.toDateString() === tmw.toDateString()) return 'tomorrow ' + time;
    return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time;
  }
  function ago(t) {
    const ms = Date.now() - t;
    if (ms < 60e3) return 'just now';
    return dur(ms) + ' ago';
  }
  const pct = (v) => Math.round(v) + '%';

  // Turn a status object from UsageCore.status into wording + a status class.
  function describe(st, now) {
    now = now || Date.now();
    const resetTxt = st.r ? 'Resets ' + when(st.r) + ' (in ' + dur(st.r - now) + ')' : 'Reset time not reported';
    switch (st.state) {
      case 'limit': return { cls: 'critical', icon: '!', label: 'Limit reached', detail: 'Usable again ' + (st.r ? 'in ' + dur(st.r - now) : 'after it resets') + '.', resetTxt };
      case 'over': return { cls: 'critical', icon: '!', label: 'Will run out early',
        detail: "At this pace you'll hit 100% " + when(st.hitAt) + ', about ' + dur(st.r - st.hitAt) + ' before it resets.', resetTxt };
      case 'tight': return { cls: 'warning', icon: '▲', label: 'Cutting it close',
        detail: 'Projected about ' + pct(st.projectedAtReset) + ' by reset, right around the limit. A lighter day or two keeps you under.', resetTxt };
      case 'ahead': return { cls: 'warning', icon: '▲', label: 'Ahead of pace',
        detail: 'Projected about ' + pct(st.projectedAtReset) + ' by reset. You have some room, but less than usual.', resetTxt };
      case 'ok': return { cls: 'good', icon: '✓', label: 'On pace',
        detail: 'Projected about ' + pct(st.projectedAtReset) + ' by reset.', resetTxt };
      case 'early': return { cls: 'neutral', icon: '…', label: 'Too early to project', detail: 'Pace and projections start after a few days of use in this window.', resetTxt };
      case 'idle': return { cls: 'good', icon: '✓', label: 'Not used yet', detail: 'Nothing used in this window so far.', resetTxt };
      case 'reset': return { cls: 'neutral', icon: '↻', label: 'Has reset', detail: 'This limit reset after the last reading. Refresh for the new number.', resetTxt: '' };
      default: return { cls: 'neutral', icon: '–', label: 'No reset time', detail: '', resetTxt };
    }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  root.UsageUI = { dur, when, ago, pct, describe, esc };
})(typeof globalThis !== 'undefined' ? globalThis : this);
