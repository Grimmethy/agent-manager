// Required-plugins banner: a red strip under the header when the Kernel's required-plugins check (src/required-plugins.js, GET /api/required-plugins) says a required plugin is
// missing, out of range or unreadable, or that the check itself could not run. A plain global <script> (declarations plus one guarded start call), the pattern of
// cloud-spend-panel.js: buildRequiredPluginsBannerHtml is a pure string builder, so it is unit-testable in a bare vm context. One fetch at page load is the trigger: no timer
// (ADR-0024, static/js/no-timer-redraws.test.js). The payload is {ok, results:[{name, range, found, status, message}]} or {ok:false, error, results:[]}.

function requiredPluginsEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// '' when nothing is wrong (ok, or no usable payload); otherwise the banner's inner HTML.
function buildRequiredPluginsBannerHtml(body) {
  if (!body || typeof body !== 'object' || body.ok === true) return '';
  if (body.error) return '<strong>Required plugins</strong>: The required-plugins check could not run: ' + requiredPluginsEsc(body.error);
  const unmet = (Array.isArray(body.results) ? body.results : []).filter((r) => r && r.status !== 'ok');
  const lines = unmet.map((r) => '<div>' + requiredPluginsEsc(r.name) + ' (' + requiredPluginsEsc(r.status) + ', needs ' + requiredPluginsEsc(r.range) + '): ' + requiredPluginsEsc(r.message) + '</div>');
  return '<strong>Required plugins not met:</strong> agent-manager cannot start its pipeline until this is fixed.' + lines.join('');
}

async function loadRequiredPluginsBanner() {
  const el = document.getElementById('required-plugins-banner');
  if (!el) return;
  try {
    const html = buildRequiredPluginsBannerHtml(await (await fetch('/api/required-plugins')).json());
    el.innerHTML = html;
    el.hidden = !html;
  } catch (err) {
    el.hidden = true; // the check is advisory: a failed fetch must never break the page
  }
}

if (typeof document !== 'undefined' && typeof fetch === 'function') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadRequiredPluginsBanner);
  else loadRequiredPluginsBanner();
}
