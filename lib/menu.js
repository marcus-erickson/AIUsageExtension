/* Providers dropdown shared by the popup and the dashboard: one checkbox per provider. */
(function (root) {
  const PROV = {
    claude: { origin: 'https://claude.ai/*', key: 'claudeOn', msg: 'claudeToggled' },
    grok: { origin: 'https://grok.com/*', key: 'grokOn', msg: 'grokToggled' },
    gemini: { origin: 'https://gemini.google.com/*', key: 'geminiOn', msg: 'geminiToggled' },
    chatgpt: { origin: 'https://chatgpt.com/*', key: 'chatgptOn', msg: 'chatgptToggled' },
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Claude counts as on for people who installed before v0.3 and already have Claude data.
  async function isOn(id) {
    const st = await chrome.storage.local.get([PROV[id].key, 'org']);
    const v = st[PROV[id].key];
    if (typeof v === 'boolean') return v;
    return id === 'claude' ? !!st.org : false;
  }

  // Turning a provider on needs a site permission, and Chrome's prompt can close the popup while it is showing.
  // So the intent is saved first, and the background worker finishes turning the provider on once the permission is granted.
  // Returns true when the provider ended up in the requested state.
  async function setProvider(id, on) {
    const P = PROV[id];
    if (on) {
      let ok = await chrome.permissions.contains({ origins: [P.origin] });
      if (!ok) {
        const { pendingOn = {} } = await chrome.storage.local.get('pendingOn');
        pendingOn[id] = Date.now();
        await chrome.storage.local.set({ pendingOn });
        try { ok = await chrome.permissions.request({ origins: [P.origin] }); } catch (_) { ok = false; }
        if (!ok) {
          const cur = (await chrome.storage.local.get('pendingOn')).pendingOn || {};
          delete cur[id];
          await chrome.storage.local.set({ pendingOn: cur });
          return false;
        }
      }
      await chrome.storage.local.set({ [P.key]: true });
      chrome.runtime.sendMessage({ type: P.msg });
    } else {
      await chrome.storage.local.set({ [P.key]: false });
      try { await chrome.permissions.remove({ origins: [P.origin] }); } catch (_) {}
      chrome.runtime.sendMessage({ type: P.msg });
    }
    return true;
  }

  function mount(host, opts) {
    const inPopup = !!(opts && opts.popup);
    host.classList.add('provwrap');
    host.innerHTML = '<button type="button" class="provbtn" aria-haspopup="true" aria-expanded="false">Providers <span aria-hidden="true">&#9662;</span></button><div class="provmenu" role="group" aria-label="Providers to track" hidden></div>';
    const btn = host.querySelector('.provbtn'), menu = host.querySelector('.provmenu');

    async function draw() {
      const [claudeOn, grokOn, geminiOn, chatgptOn] = await Promise.all([isOn('claude'), isOn('grok'), isOn('gemini'), isOn('chatgpt')]);
      const row = (id, name, sub, checked, disabled) => `<label class="provrow${disabled ? ' off' : ''}">
        <input type="checkbox" data-p="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        <span><b>${esc(name)}</b><small>${esc(sub)}</small></span></label>`;
      menu.innerHTML =
        row('claude', 'Claude', 'Reads your usage from claude.ai every 15 minutes', claudeOn, false) +
        row('grok', 'Grok', 'Reads grok.com Usage once an hour, in a background tab', !!grokOn, false) +
        row('chatgpt', 'ChatGPT', 'Reads chatgpt.com usage once an hour. Covers Codex and agents, not chat', !!chatgptOn, false) +
        row('gemini', 'Gemini', 'Reads gemini.google.com/usage once an hour, in a background tab', !!geminiOn, false);
      for (const id of ['claude', 'grok', 'gemini', 'chatgpt']) {
        const box = menu.querySelector(`[data-p="${id}"]`);
        box.onchange = async () => {
          box.disabled = true;
          const ok = await setProvider(id, box.checked);
          box.disabled = false;
          if (!ok) box.checked = !box.checked;
        };
      }
    }
    const open = (v) => { menu.hidden = !v; btn.setAttribute('aria-expanded', String(v)); if (v) draw(); };
    btn.onclick = (e) => { e.stopPropagation(); open(menu.hidden); };
    menu.onclick = (e) => e.stopPropagation();
    document.addEventListener('click', () => open(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { open(false); btn.focus(); } });
    chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local' && !menu.hidden) draw(); });
    return { open };
  }

  root.UsageMenu = { mount, setProvider, isOn };
})(typeof globalThis !== 'undefined' ? globalThis : this);
