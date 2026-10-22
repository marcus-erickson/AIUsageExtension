/* Sample data so the dashboard can be previewed before real readings build up. */
(function (root) {
  function makeDemo(now, days) {
    days = days || 21;
    const HOUR = 3600e3, DAY = 24 * HOUR, STEP = 15 * 60e3;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    // Weekly limit resets Tuesdays at 3 PM local.
    const nextWeeklyReset = (t) => {
      const d = new Date(t); d.setHours(15, 0, 0, 0);
      while (d.getDay() !== 2 || d.getTime() <= t) { d.setDate(d.getDate() + 1); d.setHours(15, 0, 0, 0); }
      return d.getTime();
    };
    const intensity = (t) => {
      const d = new Date(t), h = d.getHours() + d.getMinutes() / 60, wd = d.getDay();
      const weekend = wd === 0 || wd === 6;
      let base = 0;
      if (h >= 8.5 && h < 12) base = weekend ? 0.15 : 1.0;
      else if (h >= 13 && h < 17.5) base = weekend ? 0.2 : 1.2;
      else if (h >= 20 && h < 23) base = weekend ? 0.5 : 0.45;
      return base * (rnd() < 0.55 ? 0.4 + rnd() * 1.2 : 0);
    };

    const start = now - days * DAY;
    const weekStartReset = nextWeeklyReset(start);
    let wReset = weekStartReset, wU = 18, oU = 6;
    let sReset = null, sU = 0;
    // Each week is a little heavier than the last, so the demo shows a trend.
    const snaps = [];
    for (let t = start; t <= now; t += STEP) {
      if (t >= wReset) { wReset = nextWeeklyReset(t); wU = 0; oU = 0; }
      if (sReset && t >= sReset) { sReset = null; sU = 0; }
      const weekIdx = Math.floor((t - start) / (7 * DAY));
      const a = intensity(t) * (1 + weekIdx * 0.17);
      if (a > 0) {
        if (!sReset) sReset = t + 5 * HOUR;
        sU = Math.min(100, sU + a * 5.2);
        if (sU < 100) { wU = Math.min(100, wU + a * 0.42); oU = Math.min(100, oU + a * 0.22); }
      }
      const l = {
        five_hour: { u: Math.round(sU), r: sReset },
        seven_day: { u: Math.round(wU), r: wReset },
        seven_day_opus: { u: Math.round(oU), r: wReset },
      };
      snaps.push({ t, l });
    }
    return snaps;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { makeDemo };
  root.UsageDemo = { makeDemo };
})(typeof globalThis !== 'undefined' ? globalThis : this);
