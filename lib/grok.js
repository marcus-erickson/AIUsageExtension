/*
 * Grok reader. Grok has no usage API we can rely on, so this reads the same Usage
 * panel you see under Settings, Usage on grok.com, from a background tab.
 *
 * scrapeInPage runs inside the grok.com tab, so it must not use anything outside itself.
 * parseText turns the panel's text into numbers and runs in the extension.
 */
(function (root) {
  // Runs in the page. Resolves { signedOut, text } once the Usage panel has rendered, or after timeoutMs.
  function scrapeInPage(timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const collect = (dlg) => {
        const out = [];
        const walk = (el) => {
          const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(' ');
          if (own) out.push(own);
          const al = el.getAttribute && el.getAttribute('aria-label');
          if (al && /^[\d.,$%\s]+$/.test(al)) out.push(al);
          for (const c of Array.from(el.children)) walk(c);
        };
        walk(dlg);
        return out.join('\n');
      };
      const tick = () => {
        const texts = Array.from(document.querySelectorAll('[role="dialog"]')).map(collect);
        const usage = texts.find((t) => /\bused\b/i.test(t) && /\blimit\b/i.test(t) && /\bUsage\b/.test(t));
        if (usage) return resolve({ text: usage });
        // The Usage tab can render a plan with no limit at all (nothing to read), so accept a Usage heading after a grace period.
        const heading = texts.find((t) => /\bUsage\b/.test(t) && /Extra Usage Credits|Settings/.test(t));
        if (heading && Date.now() - t0 > 6000) return resolve({ text: heading });
        if (Date.now() - t0 > timeoutMs) {
          const signedOut = !!document.querySelector('a[href*="sign-in"], a[href*="sign-up"], a[href*="/auth"]') && !document.querySelector('button[aria-label^="Account menu"]');
          return resolve({ signedOut, text: '' });
        }
        setTimeout(tick, 400);
      };
      tick();
    });
  }

  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
  // Returns { plan, u, r, parts, credits } with null for anything the panel doesn't show.
  function parseText(text) {
    const out = { plan: null, u: null, r: null, parts: null, credits: null };
    if (!text) return out;
    const t = text.replace(/ /g, ' ');
    const pm = t.match(/Weekly\s+(.+?)\s+Limit/i);
    if (pm) out.plan = pm[1].trim();
    const um = t.match(/(\d+(?:\.\d+)?)\s*%\s*\n?\s*used/i);
    if (um) out.u = Math.min(100, parseFloat(um[1]));
    const rm = t.match(new RegExp('Resets\\s*\\n?\\s*((?:' + MONTHS + ')\\s+\\d{1,2},\\s+\\d{4})\\s+at\\s+(\\d{1,2}:\\d{2}\\s*[AP]M)', 'i'));
    if (rm) {
      const ms = Date.parse(rm[1] + ' ' + rm[2]); // local time, same as the page shows
      if (isFinite(ms)) out.r = ms;
    }
    // Breakdown lines such as "Voice 88%" follow the percent, before the credits section.
    if (um) {
      const after = t.slice(um.index + um[0].length);
      const region = after.split(/Extra Usage Credits/i)[0];
      const parts = {};
      const re = /([A-Za-z][A-Za-z ]{1,24}?)\s*\n\s*(\d+(?:\.\d+)?)\s*%/g;
      let m;
      while ((m = re.exec(region))) parts[m[1].trim().toLowerCase()] = parseFloat(m[2]);
      if (Object.keys(parts).length) out.parts = parts;
    }
    const cm = t.match(/Extra Usage Credits[\s\S]*?\$\s?(\d+(?:\.\d+)?)/i);
    if (cm) out.credits = parseFloat(cm[1]);
    return out;
  }

  const api = { scrapeInPage, parseText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.UsageGrok = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
