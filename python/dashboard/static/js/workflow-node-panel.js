// Graph node panel controls (HUB0325 piece W-B3): what a selected LOOP node of the Workflow graph offers besides its facts: the on/off switch, the model control and a note that says when a change applies.
// A plain global <script> loaded by index.html directly BEFORE workflow-graph-view.js; its builders are pure string functions (no DOM) so `node --test` can load them in a bare vm context.
// Uses these globals from the other scripts: buildWorkerSwitchHtml (worker-switch-ui.js), buildWorkerModelSelectHtml (worker-model-select.js), buildDetailHtml and wfEsc (workflow-graph-view.js), renderWorkers (workers-tab.js).

// One note per provider: a model override applies on the lane's next tick; the lane registry (provider, endpoint, task classes) is frozen at launch, so a change there needs a pipeline restart.
const WF_APPLY_NOTES = {
  local: "A model change applies on this lane's next tick (about 30 seconds). Provider, endpoint and task classes come from lanes.json and need a pipeline restart.",
  cloud: 'The cloud model is chosen by the gateway, not by this dashboard. Provider and endpoint come from lanes.json and need a pipeline restart.',
  script: 'A script lane runs no model. Its settings come from lanes.json and need a pipeline restart.',
};

// The switch, the model control and the apply note of a loop node; '' when the node has no runtime or no model.
function buildNodeControlsHtml(node) {
  const rt = node && node.runtime;
  const m = node && node.model;
  if (!rt || !m) return '';
  const sw = buildWorkerSwitchHtml(rt);
  const inst = { instanceId: node.id, provider: m.provider, model: m.name };
  const models = { ollamaModels: (m.choices && m.choices.local) || [], claudeModels: (m.choices && m.choices.cloud) || [] };
  const select = buildWorkerModelSelectHtml(inst, models, m.overridden ? { [node.id]: m.name } : {});
  return '<div class="wf-controls">' + (sw ? '<div class="wf-control-row">' + sw + '</div>' : '')
    + (select ? '<div class="wf-control-row">' + select + '</div>' : '')
    + '<div class="meta wf-apply-note">' + wfEsc(WF_APPLY_NOTES[m.provider] || WF_APPLY_NOTES.local) + '</div></div>';
}

// The whole panel of a loop node (the facts of buildDetailHtml plus the controls); '' for any other node, which keeps the read-only panel.
function buildNodePanelHtml(node, warnings) {
  if (!node || node.kind !== 'loop' || !node.runtime || !node.model) return '';
  return buildDetailHtml(node, warnings, buildNodeControlsHtml(node));
}

// The existing model-override route; an empty model clears the override.
async function wfSetModelDefault(instanceId, model) {
  await fetch('/api/worker-models/' + encodeURIComponent(instanceId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
}

// deps = { setModel(instanceId, model), refresh() }; both default to the real ones, tests pass fakes.
function wireNodePanel(root, deps) {
  const d = deps || {};
  const setModel = d.setModel || wfSetModelDefault;
  const refresh = d.refresh || (() => renderWorkers());
  root.querySelectorAll('#wf-detail .worker-model-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = async (e) => {
      e.stopPropagation();
      await setModel(sel.dataset.instanceId, sel.value);
      await refresh();
    };
  });
}

if (typeof module !== 'undefined') module.exports = { WF_APPLY_NOTES, buildNodeControlsHtml, buildNodePanelHtml, wfSetModelDefault, wireNodePanel };
