async function renderTokenfoldTab() {
  const main = document.getElementById('main');
  const data = await fetchJson('/api/tokenfold/stats');
  const openBtn = (port) => `<button onclick="window.open('http://' + location.hostname + ':${port}/tokenfold/dashboard', '_blank')">Open full TokenFold dashboard ↗</button>`;
  if (!data.available) {
    main.innerHTML = `<div class="empty">TokenFold proxy is not running on port ${escapeHtml(String(data.port))} -- it starts automatically with scripts/launch.sh when a tokenfold checkout is installed next to this repo (set AGENT_MANAGER_TOKENFOLD=false to turn that off).</div>`;
    return;
  }
  const s = data.stats || {};
  const modelRows = (s.by_model || []).map(m => `
    <tr><td>${escapeHtml(m.model || '')}</td><td>${(m.n ?? 0).toLocaleString()}</td>
    <td>${(m.saved ?? 0).toLocaleString()}</td><td>${m.avg_pct ?? 0}%</td></tr>`).join('');
  main.innerHTML = `
    <div class="row" style="margin-bottom:12px">${openBtn(escapeAttr(String(data.port)))}</div>
    <div style="font-size:2rem;font-weight:700">${(s.saved ?? 0).toLocaleString()} tokens saved${s.reduction_pct != null ? ` (${s.reduction_pct}%)` : ''}</div>
    <div class="meta" style="margin:6px 0 16px">${(s.n ?? 0).toLocaleString()} requests · original ${(s.orig ?? 0).toLocaleString()} → encoded ${(s.enc ?? 0).toLocaleString()} tokens${s.avg_latency != null ? ` · avg encode ${Number(s.avg_latency).toFixed(1)} ms` : ''}${s.fallback_pct != null ? ` · fallback rate ${Number(s.fallback_pct).toFixed(1)}%` : ''}</div>
    ${modelRows ? `<table><thead><tr><th>Model</th><th>Requests</th><th>Tokens saved</th><th>Avg %</th></tr></thead><tbody>${modelRows}</tbody></table>` : '<div class="empty">No model calls have gone through the proxy yet -- numbers appear as soon as the pipeline makes its first call.</div>'}`;
}

async function renderPromptForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7430/';
  try {
    const cfg = await fetchJson('/api/promptforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7430 */ }
  const existing = main.querySelector('iframe.promptforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz promptforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}

async function renderAdForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7431/';
  try {
    const cfg = await fetchJson('/api/adforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7431 */ }
  const existing = main.querySelector('iframe.adforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz adforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}

async function renderScriptForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7432/';
  try {
    const cfg = await fetchJson('/api/scriptforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7432 */ }
  const existing = main.querySelector('iframe.scriptforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz scriptforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}
