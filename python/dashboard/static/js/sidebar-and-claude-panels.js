// Persistent-sidebar plugin mounting, the Send-to-chat bridge, the Claude settings and usage panels, the case-info modal and the global brain-dump modal. Moved verbatim out of core-ui.js (2026-10-01); a plain global <script>, loaded by index.html right after core-ui.js.
// No require()/module.exports: the browser loads this with a plain <script src> tag, so every name below is a shared global.

// 2026-09-15: Chat moved out of this repo entirely into its own plugin
// (agent-manager-chat-plugin, slotKind:"persistent-sidebar" in plugins.json) -- see
// /home/wok/.claude/plans/immutable-noodling-axolotl.md. chatSetCollapsed/chatPanelInit/
// chatStartNew/chatSend/chatToggleReserve/chatWireProviderToggle/chatRender (and the
// module-level `chatSession`) are gone; the plugin's own iframe'd page owns all of that
// now, in its own document/JS context this page can't reach into directly. What's left
// here is generic (works for ANY future slotKind:"persistent-sidebar" plugin, not just
// Chat) plus the one cross-iframe bridge "Send to chat" still needs.

// Cache of the currently-active persistent-sidebar plugins, refreshed by
// mountPersistentSidebarPlugins() -- sendTextToChat() below needs a plugin's proxy base
// path without re-fetching /api/plugins on every single click.
let _persistentSidebarPlugins = [];

async function mountPersistentSidebarPlugins() {
  const layout = document.getElementById('layout');
  if (!layout) return;
  let data;
  try {
    data = await fetchJson('/api/plugins');
  } catch (e) {
    return; // best-effort -- a dashboard with no plugins configured yet has nothing to mount
  }
  const plugins = (data.plugins || []).filter((p) => p.slotKind === 'persistent-sidebar' && p.active && p.url);
  _persistentSidebarPlugins = plugins;
  // Remove any previously-mounted sidebars/toggles before remounting (refresh() can
  // call this again later if the plugin list ever changes at runtime).
  layout.querySelectorAll('.plugin-sidebar').forEach((el) => el.remove());
  document.querySelectorAll('.plugin-sidebar-toggle').forEach((el) => el.remove());
  for (const plugin of plugins) {
    const storageKey = `agentManagerPluginSidebar:${plugin.name}`;
    const collapsed = localStorage.getItem(storageKey) === 'collapsed';
    const proxyBase = `/api/plugins/${encodeURIComponent(plugin.name)}/proxy`;
    // Every plugin route this dashboard proxies to is expected to serve its own real
    // page at "<proxyBase>/<something>" (see agent-manager-chat-plugin's own GET /chat
    // for why a bare trailing-slash root won't match the generic proxy route at all --
    // Werkzeug's <path:subpath> converter never matches an empty segment). "chat" is
    // Chat's own choice, not a generic convention -- a future second persistent-sidebar
    // plugin can name its own page path however it likes, this just has to match.
    const pagePath = plugin.homePath || 'chat';

    const aside = document.createElement('aside');
    aside.className = 'plugin-sidebar' + (collapsed ? ' sidebar-collapsed' : '');
    aside.dataset.plugin = plugin.name;
    const iframe = document.createElement('iframe');
    iframe.src = `${proxyBase}/${pagePath}`;
    iframe.title = plugin.description || plugin.name;
    aside.appendChild(iframe);
    layout.appendChild(aside);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'plugin-sidebar-toggle';
    toggle.dataset.plugin = plugin.name;
    toggle.title = `Show/hide ${plugin.description || plugin.name}`;
    toggle.textContent = plugin.sidebarLabel || 'Chat';
    toggle.onclick = () => {
      const isCollapsed = aside.classList.toggle('sidebar-collapsed');
      localStorage.setItem(storageKey, isCollapsed ? 'collapsed' : 'expanded');
    };
    document.body.appendChild(toggle);
  }
}

// "Send to chat" (task detail modal, Brain Dump entries): posts through the same
// same-origin proxy path the sidebar iframe itself uses, then tells that iframe to
// refresh via postMessage -- this page cannot call into the iframe's own JS/DOM
// directly (different document, and same-origin-policy-isolated regardless once served
// from a different real port behind the proxy). The plugin's own chat.js listens for
// {type: "agent-manager-chat-refresh"} and re-fetches+re-renders its active session
// when it arrives. Un-collapses the sidebar so the sent text is actually visible.
async function sendTextToChat(text) {
  if (!_persistentSidebarPlugins.length) await mountPersistentSidebarPlugins();
  const plugin = _persistentSidebarPlugins.find((p) => p.name === 'agent-manager-chat-plugin') || _persistentSidebarPlugins[0];
  if (!plugin) throw new Error('no active Chat sidebar plugin to send to');
  const proxyBase = `/api/plugins/${encodeURIComponent(plugin.name)}/proxy`;
  const r = await fetch(`${proxyBase}/api/chat/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || body.description || `HTTP ${r.status}`);
  }
  await r.json().catch(() => null);
  const aside = document.querySelector(`.plugin-sidebar[data-plugin="${plugin.name}"]`);
  if (aside) {
    aside.classList.remove('sidebar-collapsed');
    localStorage.setItem(`agentManagerPluginSidebar:${plugin.name}`, 'expanded');
    const iframe = aside.querySelector('iframe');
    if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'agent-manager-chat-refresh' }, '*');
  }
}

async function renderClaudeSettingsPanel() {
  const settings = await fetchJson('/api/settings/claude');
  claudeSettingsCache = settings;
  const modelOpts = settings.modelChoices.map(m => `<option value="${m}" ${m === settings.model ? 'selected' : ''}>${m}</option>`).join('');
  const effortOpts = settings.effortChoices.map(e => `<option value="${e}" ${e === settings.effort ? 'selected' : ''}>${e}</option>`).join('');
  const tokenStatus = settings.tokenConfigured
    ? '<span style="color:var(--ok)">Subscription token configured</span>'
    : '<span style="color:var(--warn)">No subscription token set -- Claude toggle will fail until one is added</span>';
  return `
    <div class="grill-session" style="margin-bottom:16px">
      <div class="field-label">Claude Subscription Defaults</div>
      <div class="meta" style="margin-bottom:8px">Used whenever a Discuss/Grill conversation is switched to Claude via its toggle, unless that conversation picks a different model/effort itself.</div>
      <div class="row" style="gap:8px;align-items:center">
        <label>Model <select id="claude-default-model">${modelOpts}</select></label>
        <label>Effort <select id="claude-default-effort">${effortOpts}</select></label>
        <button type="button" class="action" id="claude-settings-save">Save</button>
        <span id="claude-settings-status" class="meta"></span>
      </div>
      <div class="field-label" style="margin-top:14px">Subscription Token</div>
      <div class="meta" style="margin-bottom:6px">${tokenStatus} -- generate one with <code>claude setup-token</code> (opens a browser to approve, then prints a token good for about a year). Pasted here, it's saved to <code>agent-manager.env</code> and never shown again, including to this page -- only whether one is set.</div>
      <div class="row" style="gap:8px;align-items:center">
        <input type="password" id="claude-token-input" placeholder="Paste token from \`claude setup-token\`" autocomplete="off" style="flex:1;background:var(--panel);border:2px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-family:monospace;font-size:12px">
        <button type="button" class="action" id="claude-token-save">Save Token</button>
        ${settings.tokenConfigured ? '<button type="button" class="secondary" id="claude-token-clear">Clear</button>' : ''}
      </div>
    </div>`;
}

function wireClaudeSettingsPanel() {
  const btn = document.getElementById('claude-settings-save');
  if (btn) btn.onclick = async () => {
    const model = document.getElementById('claude-default-model').value;
    const effort = document.getElementById('claude-default-effort').value;
    const status = document.getElementById('claude-settings-status');
    try {
      claudeSettingsCache = await (await fetch('/api/settings/claude', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, effort }),
      })).json();
      status.textContent = 'Saved.';
      setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (e) {
      status.textContent = 'Save failed: ' + e.message;
    }
  };

  const tokenBtn = document.getElementById('claude-token-save');
  if (tokenBtn) tokenBtn.onclick = async () => {
    const input = document.getElementById('claude-token-input');
    const token = input.value.trim();
    if (!token) { showToast('Paste a token first.'); return; }
    try {
      const res = await fetch('/api/settings/claude-token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(result.description || ('HTTP ' + res.status));
      // Wipe the field immediately rather than leaving the pasted secret sitting in a
      // form input (and in the browser's own form-autofill history) any longer than
      // the single click it took to save it.
      input.value = '';
      showToast(result.restarted ? 'Token saved -- pipeline restarted to pick it up.' : 'Token saved.', 'info');
      renderModelsTab();
    } catch (e) {
      showToast('Could not save token: ' + e.message);
    }
  };

  const clearBtn = document.getElementById('claude-token-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm('Remove the saved Claude subscription token? The toggle will stop working until a new one is added.')) return;
    try {
      await fetch('/api/settings/claude-token', { method: 'DELETE' });
      showToast('Token cleared.', 'info');
      renderModelsTab();
    } catch (e) {
      showToast('Could not clear token: ' + e.message);
    }
  };
}

async function renderClaudeUsagePanel() {
  let usage;
  try {
    usage = await fetchJson('/api/claude-usage');
  } catch (e) {
    return '';
  }
  if (!usage.available) {
    return `<div class="grill-session" style="margin-bottom:16px"><div class="field-label">Claude Usage</div><div class="meta">Not available: ${escapeHtml(usage.reason || 'unknown')}</div></div>`;
  }
  const healthLabel = usage.healthy
    ? '<span style="color:var(--ok)">healthy</span>'
    : `<span style="color:var(--bad)">rate-limited</span>`;
  const lastHitLine = usage.lastRateLimit
    ? `<div class="meta">Last rate-limit hit: ${new Date(usage.lastRateLimit.at).toLocaleString()}</div>` : '';
  const resetLine = usage.lastRateLimit && usage.lastRateLimit.resetsAt
    ? `<div class="meta">Resets: ${new Date(usage.lastRateLimit.resetsAt).toLocaleString()}</div>` : '';
  const est = usage.estimate;
  const estimateLine = est
    ? `<div class="meta" style="margin-top:6px" title="${escapeAttr(est.basis)}">Estimated: ${est.usedTokens.toLocaleString()}/~${est.ceilingTokens.toLocaleString()} tokens used (${est.usedPercent}%) -- learned from ${est.sampleCount} past rate-limit hit${est.sampleCount === 1 ? '' : 's'}${est.estimatedCapAt ? `, projected to hit the cap around ${new Date(est.estimatedCapAt).toLocaleString()} at the current pace` : ''}</div>`
    : `<div class="meta" style="margin-top:6px">No used/total estimate yet -- needs at least one real rate-limit hit in the last 7 days to learn an account-specific ceiling from.</div>`;
  return `
    <div class="grill-session" style="margin-bottom:16px">
      <div class="field-label">Claude Usage</div>
      <div>${healthLabel} <span class="meta">-- ${escapeHtml(usage.reason || '')}</span></div>
      ${lastHitLine}
      ${resetLine}
      ${estimateLine}
      <div class="row" style="gap:24px;margin-top:6px">
        <div class="stat" title="${usage.sinceLastLimit.usedFallback5h ? 'No rate-limit hit recorded yet in the last 7 days -- no real window boundary to anchor to, showing a trailing 5h lookback instead.' : 'Since ' + new Date(usage.sinceLastLimit.windowStart).toLocaleString() + ', the real start of the current rate-limit window (the last reset), not a generic trailing lookback.'}"><strong>${usage.sinceLastLimit.calls}</strong>calls since ${usage.sinceLastLimit.usedFallback5h ? 'last 5h (no hit yet)' : 'last limit'}</div>
        <div class="stat" title="${usage.sinceLastLimit.usedFallback5h ? 'No rate-limit hit recorded yet in the last 7 days -- no real window boundary to anchor to, showing a trailing 5h lookback instead.' : 'Since ' + new Date(usage.sinceLastLimit.windowStart).toLocaleString() + ', the real start of the current rate-limit window (the last reset), not a generic trailing lookback.'}"><strong>${usage.sinceLastLimit.tokens.toLocaleString()}</strong>tokens since ${usage.sinceLastLimit.usedFallback5h ? 'last 5h (no hit yet)' : 'last limit'}</div>
        <div class="stat"><strong>${usage.rolling7d.calls}</strong>calls / last 7d</div>
        <div class="stat"><strong>${usage.rolling7d.tokens.toLocaleString()}</strong>tokens / last 7d</div>
      </div>
      <div class="meta" style="margin-top:6px">Volume trend, not a live quota gauge -- Claude Code only ever reports a rate-limit hit reactively, after it happens. "Since last limit" is anchored to the real window boundary (the last reset), not a generic trailing lookback. Includes both interactive \`claude\` sessions and this pipeline's own headless calls on this machine.</div>
    </div>`;
}

function renderCaseInfoModal(kase) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <button class="close" onclick="closeDetail()">&times;</button>
    <h2>${escapeHtml(kase.id)}</h2>
    <div><strong>Category:</strong> ${escapeHtml(kase.category)} &nbsp; <strong>Grader:</strong> ${escapeHtml(kase.grader)}${kase.grader === 'judge' ? ' <span class="badge warn">scored by a Claude call against a rubric, not auto-checkable</span>' : ''}</div>
    <div class="field-label" style="margin-top:14px">What this measures</div>
    <div>${escapeHtml(kase.description || '(no description)')}</div>
    <div class="field-label" style="margin-top:14px">Full Prompt</div>
    <pre>${escapeHtml(kase.prompt)}</pre>
  `;
  backdrop.classList.add('open');
}

function openGlobalBrainDumpModal() {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  content.innerHTML = `
    <button class="close" onclick="closeDetail()">&times;</button>
    <h2>Brain Dump</h2>
    <div class="capture-row">
      <input id="global-bd-capture-input" placeholder="Brain dump -- capture anything" autocomplete="off">
      <button class="action" id="global-bd-capture-btn" title="Save this note as a new Brain Dump entry">Capture</button>
    </div>
  `;
  backdrop.classList.add('open');
  const input = document.getElementById('global-bd-capture-input');
  input.focus();
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    const btn = document.getElementById('global-bd-capture-btn');
    btn.disabled = true;
    try {
      await fetch('/api/brain-dump/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      closeDetail();
      if (activeTab === 'brain-dump') refreshBrainDumpEntries(true);
    } catch (e) {
      alert('Could not capture: ' + e.message);
      btn.disabled = false;
    }
  };
  document.getElementById('global-bd-capture-btn').onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}
