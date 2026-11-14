'use strict';

// A forge page (CharacterForge now, ObjectForge and SettingForge later) running inside its dashboard iframe asks the dashboard to show PromptForge:
//   window.parent.postMessage({type: 'forge-navigate', tab: 'promptforge', handoff: <id>}, '*')
// The dashboard checks the sender, switches to that tab, waits for the tab's iframe to load and posts {type: 'pf-handoff', id} into it.
// The hand-off is delivered by postMessage and never by changing the iframe's src: the tab renderer resets src to the base URL on every dashboard re-render.
// Pure helpers first (testable from Node), then handleForgeNavigate with its environment injected, then the browser wiring at the bottom.

const FORGE_NAVIGATE_FALLBACK_PORTS = [7430, 7431, 7432, 7433, 7434, 7435, 7436, 7437, 7438, 7439, 7440, 7441, 7442, 7445, 7448];   // only when /api/plugins cannot be read
const FORGE_NAVIGATE_WAIT_MS = 10000;
const FORGE_HANDOFF_ID = /^[A-Za-z0-9_-]{6,64}$/;
const FORGE_TAB_KEY = /^[A-Za-z0-9_-]{1,40}$/;

// The ports of the plugins' registered urls (plugins.json "url", e.g. http://localhost:7430): the origins forge iframes can have.
function forgePortsFromPlugins(plugins) {
  const ports = [];
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (!p || typeof p.url !== 'string') continue;
    try { const u = new URL(p.url); const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80)); if (Number.isInteger(port) && !ports.includes(port)) ports.push(port); } catch (e) { /* a bad url is not a forge */ }
  }
  return ports;
}

// event: {origin, data}. knownPorts: the registered forge ports. Accepts only a well-formed forge-navigate message from the dashboard's own host on a known port.
function isAllowedForgeMessage(event, knownPorts, locationHostname) {
  const d = event && event.data;
  if (!d || typeof d !== 'object' || d.type !== 'forge-navigate') return false;
  if (typeof d.tab !== 'string' || !FORGE_TAB_KEY.test(d.tab)) return false;
  if (typeof d.handoff !== 'string' || !FORGE_HANDOFF_ID.test(d.handoff)) return false;
  let u;
  try { u = new URL(String(event.origin)); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname !== locationHostname) return false;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return (knownPorts || []).map(Number).includes(port);
}

// Resolves with the loaded iframe, or null after ms. o: {findFrame(), observe(cb) -> stop, onLoad(frame, cb), setTimeoutFn, clearTimeoutFn, assumeLoaded, ms}.
// A frame that was already on the page is taken as loaded; a frame the tab renderer creates after the switch is waited for (its load event).
function forgeWaitForFrame(o) {
  return new Promise((resolve) => {
    let done = false, attached = false, timer = null, stop = null;
    const finish = (v) => { if (done) return; done = true; if (timer !== null) o.clearTimeoutFn(timer); if (stop) stop(); resolve(v); };
    const check = () => {
      if (attached) return;
      const f = o.findFrame();
      if (!f) return;
      attached = true;
      if (o.assumeLoaded) finish(f); else o.onLoad(f, () => finish(f));
    };
    timer = o.setTimeoutFn(() => finish(null), o.ms);
    check();
    if (!done) stop = o.observe(() => { if (!done) check(); });
  });
}

// env: {hostname, knownPorts() -> Promise<number[]>, findTab(key), activeTab(), switchTab(key), findFrame(tab), waitForFrame(tab, assumeLoaded), toast(msg), label(tab)}
async function handleForgeNavigate(event, env) {
  let ports;
  try { ports = await env.knownPorts(); } catch (e) { ports = []; }
  if (!ports || !ports.length) ports = FORGE_NAVIGATE_FALLBACK_PORTS;
  if (!isAllowedForgeMessage(event, ports, env.hostname)) return 'ignored';
  const { tab, handoff } = event.data;
  if (!env.findTab(tab)) return 'ignored';                        // only an existing tab
  const already = env.activeTab() === tab && !!env.findFrame(tab); // switching again would rebuild the tab and reload its frame
  if (!already) env.switchTab(tab);
  const frame = await env.waitForFrame(tab, already);
  let origin = null;
  try { origin = frame && frame.src ? new URL(frame.src).origin : null; } catch (e) { origin = null; }
  if (!frame || !frame.contentWindow || !origin) { env.toast(`Could not open ${env.label(tab)}`); return 'failed'; }
  frame.contentWindow.postMessage({ type: 'pf-handoff', id: handoff }, origin);   // the frame's own origin, never '*'
  return 'sent';
}

function forgeNavigateBrowserEnv() {
  const main = () => document.getElementById('main');
  return {
    hostname: location.hostname,
    knownPorts: async () => forgePortsFromPlugins((await fetchJson('/api/plugins')).plugins),
    findTab: (k) => findTabByKey(k),
    activeTab: () => activeTab,
    switchTab: (k) => switchToTab(k),
    findFrame: (tab) => document.querySelector(`#main iframe.${tab}-frame`),
    waitForFrame: (tab, assumeLoaded) => forgeWaitForFrame({
      findFrame: () => document.querySelector(`#main iframe.${tab}-frame`),
      observe: (cb) => { const mo = new MutationObserver(cb); mo.observe(main(), { childList: true, subtree: true }); return () => mo.disconnect(); },
      onLoad: (f, cb) => f.addEventListener('load', cb, { once: true }),
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms), clearTimeoutFn: (t) => clearTimeout(t), assumeLoaded, ms: FORGE_NAVIGATE_WAIT_MS,
    }),
    toast: (m) => showToast(m, 'error'),
    label: (tab) => { const t = findTabByKey(tab); return typeof navTabPlainLabel === 'function' && t ? navTabPlainLabel(t) : (t && t.label) || tab; },
  };
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof document !== 'undefined' && typeof document.getElementById === 'function') {
  window.addEventListener('message', (e) => { if (e && e.data && e.data.type === 'forge-navigate') handleForgeNavigate(e, forgeNavigateBrowserEnv()); });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { FORGE_NAVIGATE_FALLBACK_PORTS, FORGE_NAVIGATE_WAIT_MS, forgePortsFromPlugins, isAllowedForgeMessage, forgeWaitForFrame, handleForgeNavigate };
