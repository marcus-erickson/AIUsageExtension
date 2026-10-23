/*
 * ChatGPT reader. Reads chatgpt.com/settings/usage ("Plan limits") from a background tab.
 * That page measures Codex, Work, Workspace Agents and ChatGPT for Excel. It says chat conversations
 * are not included, so ordinary chat has no number to read. Plans show a monthly limit, or 5 hour and weekly limits.
 *
 * scrapeInPage runs inside the ChatGPT tab, so it must not use anything outside itself.
 * parseText turns the page text into numbers and runs in the extension.
 */
(function (root) {
  // Runs in the page. Resolves { signedOut, text, plan } once the limits have rendered, or after timeoutMs.
  function scrapeInPage(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const plan = () => {
        // The sidebar's profile button reads "<name> <plan>", for example "Marcus Erickson / Free".
        const b = document.querySelector('button[aria-label="Open profile menu"]');
        const lines = b ? b.innerText.split('\n').map((x) => x.trim()).filter(Boolean) : [];
        const last = lines.length > 1 ? lines[lines.length - 1] : '';
        return /^(Free|Go|Plus|Pro|Team|Business|Enterprise|Edu)\b/i.test(last) && last.length < 30 ? last : null;
      };
      const tick = () => {
        if (/^\/auth\//.test(location.pathname) || /Log in or sign up/i.test(document.body.innerText.slice(0, 600))) return resolve({ signedOut: true, text: '' });
        const main = document.querySelector('main');
        const text = main ? main.innerText : '';
        if (/Plan limits/i.test(text) && /\d\s*%\s*(remaining|used)/i.test(text)) return resolve({ text, plan: plan() });
        if (/Plan limits|Usage/.test(text) && Date.now() - t0 > 7000) return resolve({ text, plan: plan() });
        if (Date.now() - t0 > timeoutMs) return resolve({ text, plan: plan() });
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  // Runs in the page, on the ChatGPT home page where the sidebar is. Resolves { plan } or { plan: null }.
  function scrapePlanInPage(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const b = document.querySelector('button[aria-label="Open profile menu"]');
        const lines = b ? b.innerText.split('\n').map((x) => x.trim()).filter(Boolean) : [];
        const last = lines.length > 1 ? lines[lines.length - 1] : '';
        if (/^(Free|Go|Plus|Pro|Team|Business|Enterprise|Edu)\b/i.test(last) && last.length < 30) return resolve({ plan: last });
        if (Date.now() - t0 > timeoutMs) return resolve({ plan: null });
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  // Runs in the page, on chatgpt.com/settings/billing, whose first card reads "ChatGPT Free" or "ChatGPT Plus".
  function scrapeBillingInPage(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const m = document.body && document.body.innerText.match(/^\s*ChatGPT (Free|Go|Plus|Pro|Team|Business|Enterprise|Edu)\b/im);
        if (m) return resolve({ plan: m[1] });
        if (Date.now() - t0 > timeoutMs) return resolve({ plan: null });
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  const MON = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
  // "Resets in 30d 0h" is relative. "Resets Oct 23 at 9:58 AM" is absolute and has no year.
  function parseReset(str, now) {
    const rel = str.match(/^(?:in\s+)?((?:\d+\s*[dhm]\s*)+)$/i);
    if (rel) {
      let ms = 0, m;
      const re = /(\d+)\s*([dhm])/gi;
      while ((m = re.exec(rel[1]))) ms += parseInt(m[1], 10) * ({ d: 864e5, h: 36e5, m: 6e4 }[m[2].toLowerCase()]);
      return { r: now + ms, approx: true };
    }
    const ab = str.match(new RegExp('^((?:' + MON + ')[a-z]*\\.?\\s+\\d{1,2})(?:,?\\s+(\\d{4}))?\\s+at\\s+(\\d{1,2}:\\d{2}\\s*[AP]M)$', 'i'));
    if (ab) {
      const y = new Date(now).getFullYear();
      let t = Date.parse(ab[1].replace('.', '') + ', ' + (ab[2] || y) + ' ' + ab[3]);
      if (!ab[2] && isFinite(t) && t < now - 36 * 36e5) t = Date.parse(ab[1].replace('.', '') + ', ' + (y + 1) + ' ' + ab[3]);
      return isFinite(t) ? { r: t, approx: false } : null;
    }
    return null;
  }

  function keyFor(label) {
    if (/5[\s-]?hour|five[\s-]?hour/i.test(label)) return 'chatgpt_five_hour';
    if (/week/i.test(label)) return 'chatgpt_seven_day';
    if (/month/i.test(label)) return 'chatgpt_monthly';
    return null; // an unknown limit has an unknown window length, so it is not tracked
  }

  // Returns { limits: { key: {u, r?, approx?} } }. u is percent used.
  function parseText(text, now) {
    const out = { limits: {} };
    if (!text) return out;
    now = now || Date.now();
    const t = text.replace(/ /g, ' ');
    const re = /^([^\n]{3,60})\n\s*Resets\s+([^\n]+)\n\s*(\d+(?:\.\d+)?)\s*%\s*(remaining|used)/gim;
    let m;
    while ((m = re.exec(t))) {
      const key = keyFor(m[1]);
      if (!key) continue;
      const pct = Math.max(0, Math.min(100, parseFloat(m[3])));
      const lim = { u: /remaining/i.test(m[4]) ? 100 - pct : pct };
      const r = parseReset(m[2].trim(), now);
      if (r) { lim.r = r.r; if (r.approx) lim.approx = true; }
      out.limits[key] = lim;
    }
    return out;
  }

  const api = { scrapeInPage, scrapePlanInPage, scrapeBillingInPage, parseText, parseReset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UsageChatGPT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
