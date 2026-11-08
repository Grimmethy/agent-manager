// A step of a loop as a node card (loops by type, piece 5): one row per model the step uses, with a provider badge, a size badge and the status of the lane that runs it,
// and a box whose size follows the SMALLEST model the step needs (node.size.scale from src/model-size.js), so the size of the model shows without reading it.
// A plain global <script> loaded by index.html after workflow-card-fit.js and before workflow-graph-view.js; only declarations, no DOM. The guarded export lets `node --test` require it.

const WF_STEP_PROVIDERS = ['local', 'cloud', 'script'];
const WF_STEP_HEAD_H = 52;   // the title row plus the padding of a step card
const WF_STEP_ROW_H = 24;    // one model row

function wfStepEsc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wfStepUp4(n) { return Math.ceil(n / 4) * 4; }

// The scale a step card is drawn at: node.size.scale when it is a positive finite number, else 1 (a step with no model, or a node that is not a step).
function wfStepScale(node) {
  const s = node && node.size && node.size.scale;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}

// A node is a step card when it carries a models list (the pipeline stage nodes and the step nodes of the worker loops).
function wfIsStepNode(node) {
  return !!node && Array.isArray(node.models);
}

// The box of a step card: base * scale (multiples of 4), and never shorter than its model rows need.
function wfStepBox(node, base) {
  const b = base || { w: 272, h: 128 };
  const scale = wfStepScale(node);
  const rows = wfIsStepNode(node) ? Math.max(1, node.models.length) : 1;
  return { w: wfStepUp4(b.w * scale), h: Math.max(wfStepUp4(b.h * scale), wfStepUp4(WF_STEP_HEAD_H + WF_STEP_ROW_H * rows)) };
}

// The status dot of a lane: one class per status word so the stylesheet colours it; '' when the lane is unknown.
function wfLaneDotHtml(lane) {
  const r = lane && lane.runtime;
  if (!r) return '';
  const status = r.stale ? 'stale' : String(r.status || 'unknown').replace(/[^a-z0-9-]/gi, '');
  return '<span class="wf-dot wf-dot-' + wfStepEsc(status) + '" title="' + wfStepEsc(lane.id + ': ' + status) + '"></span>';
}

// The model rows of a step. lanes = { <lane id>: lane node } (the runtime of the lane behind a row); a row with a lane is clickable (data-lane) and opens that lane's panel.
function wfStepModelsHtml(node, lanes) {
  if (!wfIsStepNode(node) || !node.models.length) return '<div class="meta">no model</div>';
  const byLane = lanes || {};
  return node.models.map((m) => {
    const provider = WF_STEP_PROVIDERS.includes(m && m.provider) ? m.provider : 'local';
    const size = m && m.size ? m.size : null;
    const lane = m && m.lane ? m.lane : null;
    // A script has no model: its row reads 'no model' (or its own name, e.g. apply-loop) and carries no size badge, the provider badge already says it.
    const noModel = provider === 'script' && (!m || !m.name || m.name === 'script');
    const name = noModel ? 'no model' : ((m && m.name) || '-');
    return '<div class="wf-model-row' + (lane ? ' wf-model-lane' : '') + '"' + (lane ? ' data-lane="' + wfStepEsc(lane) + '" title="Open ' + wfStepEsc(lane) + '"' : '') + '>'
      + wfLaneDotHtml(lane ? byLane[lane] : null)
      + '<span class="wf-model">' + wfStepEsc(name) + '</span> '
      + '<span class="chip wf-provider wf-provider-' + provider + '">' + provider + '</span>'
      + (size && size.tier !== 'script' ? ' <span class="chip wf-size wf-size-' + wfStepEsc(size.tier) + '" title="' + wfStepEsc(size.source === 'cloud-table' ? 'nominal size, assumed' : 'model size') + '">' + wfStepEsc(size.label) + '</span>' : '')
      + '</div>';
  }).join('');
}

if (typeof module !== 'undefined') module.exports = { wfStepScale, wfIsStepNode, wfStepBox, wfLaneDotHtml, wfStepModelsHtml };
