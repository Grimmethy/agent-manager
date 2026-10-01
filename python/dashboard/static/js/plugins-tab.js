// Plugins tab: renderPluginsTab and the pipeline-flag badges. Moved verbatim out of core-ui.js (2026-10-01); a plain global <script>, loaded by index.html right after core-ui.js.
// No require()/module.exports: the browser loads this with a plain <script src> tag, so every name below is a shared global.

async function renderPluginsTab() {
  const main = document.getElementById('main');
  let data;
  try {
    data = await fetchJson('/api/plugins');
  } catch (e) {
    main.innerHTML = `<div class="empty">Could not load plugins: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const slotted = plugins => plugins.filter((p) => p.slot);
  const unslotted = plugins => plugins.filter((p) => !p.slot);
  const allPlugins = data.plugins || [];
  const rows = unslotted(allPlugins).map((p) => {
    const enabled = p.enabled !== false;
    return `
      <div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <label style="display:flex; align-items:center; gap:8px; margin-top:2px; cursor:pointer;">
          <input type="checkbox" class="plugin-toggle" data-name="${escapeAttr(p.name)}" ${enabled ? 'checked' : ''}>
        </label>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(p.name)} ${enabled ? '' : '<span class="badge idle" style="margin-left:6px;">disabled</span>'}</div>
          ${p.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(p.description)}</div>` : ''}
          <div class="meta" style="margin-top:4px; word-break:break-all; font-family:monospace; font-size:11px; color:var(--muted);">${escapeHtml(p.registerPath || '(no path)')}</div>
        </div>
      </div>`;
  }).join('');

  // Slotted plugins (e.g. "hardware-tab") are mutually exclusive -- a radio group, not
  // independent checkboxes, since exactly one (or none) actually runs at a time and
  // switching genuinely starts/stops the underlying process (see /api/plugins/select-slot).
  const slotGroups = {};
  slotted(allPlugins).forEach((p) => { (slotGroups[p.slot] = slotGroups[p.slot] || []).push(p); });
  const slotSections = Object.entries(slotGroups).map(([slot, members]) => {
    const radioName = `slot-${slot}`;
    const noneChecked = !members.some((m) => m.active) ? 'checked' : '';
    const options = [`
      <label style="display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="" ${noneChecked}>
        <span>None (stop monitoring)</span>
      </label>`, ...members.map((m) => {
      const badge = m.running
        ? '<span class="badge ok" style="margin-left:6px;">running</span>'
        : '<span class="badge idle" style="margin-left:6px;">stopped</span>';
      return `
      <label style="display:flex; align-items:flex-start; gap:8px; padding:8px 10px; cursor:pointer;">
        <input type="radio" name="${escapeAttr(radioName)}" class="slot-radio" data-slot="${escapeAttr(slot)}" value="${escapeAttr(m.name)}" ${m.active ? 'checked' : ''} style="margin-top:2px;">
        <span>
          <div style="font-weight:600;">${escapeHtml(m.name)}${badge}</div>
          ${m.description ? `<div class="meta" style="margin-top:2px;">${escapeHtml(m.description)}</div>` : ''}
        </span>
      </label>`;
    })];
    return `
      <div style="padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">
        <div class="field-label" style="margin-bottom:6px;">${escapeHtml(slot)} source</div>
        <div style="display:flex; flex-direction:column; gap:2px;" id="slot-group-${escapeAttr(slot)}">${options.join('')}</div>
        <div class="meta slot-status" style="margin-top:6px;"></div>
      </div>`;
  }).join('');

  main.innerHTML = `
    <h2 style="margin-top:0;">Plugins</h2>
    ${slotSections}
    <div class="meta" style="margin-bottom:14px;">
      Only enabled plugins register their task sources. A change here restarts the pipeline if it is running so an
      in-flight draft for a now-disabled source can't stall. Manifest: <span style="font-family:monospace;">${escapeHtml(data.manifestPath || 'plugins.json')}</span>
    </div>
    <div id="plugins-list">${rows || '<div class="empty">No plugins registered yet -- add one below.</div>'}</div>

    <h3 style="margin-top:22px;">Add a plugin</h3>
    <div style="display:flex; flex-direction:column; gap:8px; max-width:640px;">
      <input type="text" id="plugin-add-path" placeholder="Absolute path to the plugin's register.js (e.g. /media/model-cache/github/agent-manager-imagegen/register.js)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-name" placeholder="Name (optional -- defaults to the plugin folder name)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <input type="text" id="plugin-add-desc" placeholder="Description (optional)" style="padding:8px; background:var(--bg); border:1px solid var(--border); border-radius:6px; color:var(--text);">
      <button class="action" id="plugin-add-btn" style="align-self:flex-start;">Add plugin</button>
      <div id="plugin-add-msg" class="meta"></div>
    </div>

    <h3 style="margin-top:22px;">Available plugins</h3>
    <div id="marketplace-note" class="meta" style="margin-bottom:10px;"></div>
    <div id="marketplace-list"><div class="meta">Loading...</div></div>`;

  main.querySelectorAll('.slot-radio').forEach((radio) => {
    radio.onchange = async () => {
      const slot = radio.dataset.slot;
      const name = radio.value || null;
      const group = main.querySelector(`#slot-group-${slot}`);
      const statusEl = group ? group.closest('div').parentElement.querySelector('.slot-status') : null;
      group.querySelectorAll('input').forEach((r) => { r.disabled = true; });
      if (statusEl) statusEl.textContent = name ? `Starting ${name}...` : 'Stopping...';
      try {
        const r = await fetch('/api/plugins/select-slot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slot, name }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.description || r.status);
        if (name && !body.healthy) {
          if (statusEl) statusEl.textContent = `${name} started but did not report healthy in time -- check its log.`;
        }
        await renderPluginsTab();
      } catch (e) {
        alert('Could not switch plugin: ' + e.message);
        await renderPluginsTab();
      }
    };
  });

  main.querySelectorAll('.plugin-toggle').forEach((cb) => {
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const r = await fetch('/api/plugins/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cb.dataset.name, enabled: cb.checked }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).description || r.status);
        await syncPluginTabs();
        renderNav();
        await renderPluginsTab();
      } catch (e) {
        alert('Could not update plugin: ' + e.message);
        cb.checked = !cb.checked;
        cb.disabled = false;
      }
    };
  });

  const addBtn = main.querySelector('#plugin-add-btn');
  addBtn.onclick = async () => {
    const msg = main.querySelector('#plugin-add-msg');
    const registerPath = main.querySelector('#plugin-add-path').value.trim();
    const name = main.querySelector('#plugin-add-name').value.trim();
    const description = main.querySelector('#plugin-add-desc').value.trim();
    if (!registerPath) { msg.textContent = 'A register.js path is required.'; return; }
    addBtn.disabled = true;
    msg.textContent = 'Adding...';
    try {
      const r = await fetch('/api/plugins/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registerPath, name, description }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.description || r.status);
      await syncPluginTabs();
      renderNav();
      await renderPluginsTab();
    } catch (e) {
      msg.textContent = 'Could not add plugin: ' + e.message;
      addBtn.disabled = false;
    }
  };

  // Marketplace: fetch catalog entries annotated with install status and render
  // Install / Update / Installed controls per entry. 402/403 surface via showToast.
  (async () => {
    const listEl = main.querySelector('#marketplace-list');
    const noteEl = main.querySelector('#marketplace-note');
    let mkt;
    try {
      mkt = await fetchJson('/api/plugins/marketplace');
    } catch (e) {
      listEl.innerHTML = '<div class="meta">Could not load marketplace: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    if (mkt.catalogError) {
      noteEl.textContent = mkt.catalogError;
    }
    const entries = mkt.plugins || mkt.entries || [];
    if (!entries.length) {
      listEl.innerHTML = '<div class="meta">No plugins available in the catalog.</div>';
      return;
    }
    listEl.innerHTML = entries.map((p) => {
      const installed = p.installed === true;
      const updateAvail = p.updateAvailable === true;
      let priceText = '';
      if (p.pricing && p.pricing.model && p.pricing.model !== 'free') {
        const cur = p.pricing.currency || '';
        const amt = p.pricing.amount_cents != null ? (p.pricing.amount_cents / 100) : 0;
        const interval = p.pricing.interval || '';
        priceText = escapeHtml(cur + ' ' + amt + (interval ? ' / ' + interval : ''));
      }
      let controlHtml = '';
      if (installed && updateAvail) {
        controlHtml = '<button class="action" data-mkt-action="update" data-id="' + escapeAttr(p.id) + '">Update</button>';
      } else if (installed) {
        controlHtml = '<span class="badge ok" style="margin-top:2px;">Installed</span>';
      } else {
        const isPaid = p.pricing && p.pricing.model && p.pricing.model !== 'free';
        const paidStyle = isPaid ? ' style="opacity:0.7; border-style:dashed;" title="Paid plugin -- requires a license"' : '';
        controlHtml = '<button class="action" data-mkt-action="install" data-id="' + escapeAttr(p.id) + '"' + paidStyle + '>Install</button>';
      }
      const versionLine = p.installedVersion
        ? '<div class="meta" style="margin-top:2px; font-size:11px;">Installed: ' + escapeHtml(p.installedVersion) + (updateAvail ? ' <span class="badge idle" style="margin-left:4px;">update available</span>' : '') + '</div>'
        : '';
      return '<div style="display:flex; align-items:flex-start; gap:12px; padding:12px 14px; background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:8px;">'
        + '<div style="flex:1; min-width:0;">'
        + '<div style="font-weight:600;">' + escapeHtml(p.name) + (priceText ? ' <span class="meta" style="margin-left:8px;">' + priceText + '</span>' : '') + '</div>'
        + '<div class="meta" style="margin-top:2px;">' + escapeHtml(p.summary || '') + '</div>'
        + versionLine
        + '</div>'
        + '<div style="white-space:nowrap;">' + controlHtml + '</div>'
        + '</div>';
    }).join('');

    listEl.querySelectorAll('[data-mkt-action]').forEach((btn) => {
      btn.onclick = async () => {
        const action = btn.dataset.mktAction;
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = action === 'update' ? 'Updating...' : 'Installing...';
        try {
          const r = await fetch('/api/plugins/' + action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) {
            const errMsg = body.description || body.error || 'Error ' + r.status;
            showToast(errMsg, 'error');
            btn.textContent = action === 'update' ? 'Update' : 'Install';
            btn.disabled = false;
            return;
          }
          showToast(action === 'update' ? 'Plugin updated successfully' : 'Plugin installed successfully', 'success');
          await renderPluginsTab();
        } catch (e) {
          showToast('Could not ' + (action === 'update' ? 'update' : 'install') + ' plugin: ' + e.message, 'error');
          btn.textContent = action === 'update' ? 'Update' : 'Install';
          btn.disabled = false;
        }
      };
    });
  })();
}

function pipelineFlagBadges(s) {
  const badges = [];
  if (s.directToMain) badges.push('<span class="badge ok" title="Commits straight to main, no review branch">direct-to-main</span>');
  if (s.candidateFulfillment) badges.push('<span class="badge idle" title="Consumes a vetted candidate write-up; grounded in real fetched file content">candidate-fulfillment</span>');
  if (s.hasCandidatesPath) badges.push('<span class="badge idle" title="Can output {&quot;mode&quot;:&quot;split&quot;} when a candidate is too large for one atomic edit, writing sub-candidates back into its own candidates doc">split-capable</span>');
  if (s.emptyApproval) badges.push('<span class="badge idle" title="An empty implement response is a legitimate, deterministically auto-approved outcome for this source">empty-ok</span>');
  if (s.advisoryProse) badges.push('<span class="badge idle" title="Deliverable is a prose verdict, not a diff -- critique is skipped">advisory-prose</span>');
  if (s.hasCustomApply && !s.directToMain) badges.push('<span class="badge idle" title="Has its own registered apply() instead of the generic Group B diff path">custom-apply</span>');
  return badges.join(' ') || '<span class="meta">—</span>';
}
