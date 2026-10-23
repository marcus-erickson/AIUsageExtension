/*
 * Provider registry: names and what each provider's limits mean.
 *
 * A reading is stored as { t, p: <provider id>, l: { <limit key>: { u, r, n?, max? } } }
 *   u   percent of the limit used (0-100)
 *   r   reset time, epoch ms, when the provider reports one
 *   n   count used and max the count limit, when the provider reports counts
 *
 * Per-limit meta, looked up by provider id and limit key:
 *   label    display name
 *   windowMs length of the window
 *   rolling  true when usage ages out gradually instead of resetting at one time
 *   est      true when the number is counted by this extension, not reported by the provider
 *
 * Claude's limits are read from the provider and named by the data itself, so it needs no entries.
 * The other providers list the limits their adapters will fill in.
 */
(function (root) {
  const H = 3600e3, D = 24 * H;
  const REG = {
    claude: { id: 'claude', name: 'Claude', home: 'https://claude.ai', limits: {} },
    // Read from chatgpt.com/settings/usage. That page covers Codex, Work, agents and ChatGPT for Excel, not chat.
    chatgpt: {
      id: 'chatgpt', name: 'ChatGPT', home: 'https://chatgpt.com',
      note: 'ChatGPT measures Codex, Work, agents and ChatGPT for Excel here. Ordinary chat messages are not included, and ChatGPT does not report a number for them.',
      limits: {
        chatgpt_five_hour: { label: '5-hour usage limit', windowMs: 5 * H },
        chatgpt_seven_day: { label: 'Weekly usage limit', windowMs: 7 * D },
        chatgpt_monthly: { label: 'Monthly usage limit', windowMs: 30 * D },
      },
    },
    // Read from the Usage panel at grok.com (Settings, Usage): one weekly limit, with a Voice/Chat split and extra credits.
    grok: {
      id: 'grok', name: 'Grok', home: 'https://grok.com',
      limits: { grok_seven_day: { label: 'Weekly limit', windowMs: 7 * D } },
    },
    // Read from gemini.google.com/usage: a current-usage meter (assumed to be the 5 hour window) and a weekly limit.
    gemini: {
      id: 'gemini', name: 'Gemini', home: 'https://gemini.google.com',
      limits: {
        gemini_five_hour: { label: 'Current usage', windowMs: 5 * H },
        gemini_seven_day: { label: 'Weekly limit', windowMs: 7 * D },
      },
    },
  };
  const order = ['claude', 'chatgpt', 'grok', 'gemini'];
  root.UsageProviders = {
    order,
    get: (id) => REG[id],
    name: (id) => (REG[id] && REG[id].name) || id,
    note: (id) => (REG[id] && REG[id].note) || '',
    rank: (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
