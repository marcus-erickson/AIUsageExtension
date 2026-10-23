/*
 * Gemini reader. Reads the page at gemini.google.com/usage ("Usage limits") from a background tab.
 * It shows the plan, a current-usage meter with a reset time, and a weekly limit with a reset date.
 *
 * scrapeInPage runs inside the Gemini tab, so it must not use anything outside itself.
 * parseText turns the page text into numbers and runs in the extension.
 */
(function (root) {
  // Runs in the page. Resolves { signedOut, text } once the usage meters have rendered, or after timeoutMs.
  function scrapeInPage(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (!/(^|\.)gemini\.google\.com$/.test(location.hostname)) return resolve({ signedOut: true, text: '' });
        const main = document.querySelector('main');
        const text = main ? main.innerText : '';
        if (/Usage limits/i.test(text) && /\d\s*%\s*used/i.test(text)) return resolve({ text });
        // A plan without meters still renders the heading, so accept it after a grace period.
        if (/Usage limits/i.test(text) && Date.now() - t0 > 6000) return resolve({ text });
        if (Date.now() - t0 > timeoutMs) return resolve({ signedOut: !!document.querySelector('a[href*="accounts.google.com"]') && !text, text });
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  function titleCasePlan(s) {
    return s.trim().split(/\s+/).map((w) => (w.toUpperCase() === 'AI' ? 'AI' : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
  }

  // "Resets at 12:58 PM" is today's next 12:58 PM. "Resets Oct 23 at 9:58 AM" has no year, so assume the nearest one.
  function parseReset(str, now) {
    const m = str.match(/Resets\s+(?:at\s+(\d{1,2}:\d{2}\s*[AP]M)|([A-Z][a-z]{2,8}\.?\s+\d{1,2})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M))/i);
    if (!m) return null;
    const d0 = new Date(now);
    if (m[1]) {
      let t = new Date(d0.getFullYear() + ' ' + (d0.getMonth() + 1) + ' ' + d0.getDate() + ' ' + m[1]).getTime();
      if (!isFinite(t)) t = Date.parse(d0.toDateString() + ' ' + m[1]);
      if (!isFinite(t)) return null;
      if (t < now - 60e3) t += 24 * 3600e3;
      return t;
    }
    let t = Date.parse(m[2].replace('.', '') + ', ' + d0.getFullYear() + ' ' + m[3]);
    if (!isFinite(t)) return null;
    if (t < now - 36 * 3600e3) t = Date.parse(m[2].replace('.', '') + ', ' + (d0.getFullYear() + 1) + ' ' + m[3]);
    return isFinite(t) ? t : null;
  }

  // Returns { plan, session: {u, r}|null, weekly: {u, r}|null }.
  function parseText(text, now) {
    const out = { plan: null, session: null, weekly: null };
    if (!text) return out;
    now = now || Date.now();
    const t = text.replace(/ /g, ' ');
    const pm = t.match(/Usage limits\s*\n\s*([A-Z][A-Za-z0-9+ ]{1,24}?)\s*\n/);
    if (pm && !/^(Your plan|Updated)/i.test(pm[1])) out.plan = titleCasePlan(pm[1]);
    const wi = t.search(/Weekly limit/i);
    const sessPart = wi < 0 ? t : t.slice(0, wi), weekPart = wi < 0 ? '' : t.slice(wi);
    const grab = (part, anchor) => {
      const i = anchor ? part.search(anchor) : 0;
      if (i < 0) return null;
      const seg = part.slice(i);
      const um = seg.match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
      if (!um) return null;
      const r = parseReset(seg, now);
      const o = { u: Math.min(100, parseFloat(um[1])) };
      if (r) o.r = r;
      return o;
    };
    out.session = grab(sessPart, /Current usage/i);
    out.weekly = weekPart ? grab(weekPart, null) : null;
    return out;
  }

  const api = { scrapeInPage, parseText, parseReset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UsageGemini = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
