// Graph node panel controls (HUB0325 piece W-B3): what a selected LOOP node of the Workflow graph offers besides its facts: the on/off switch, the model control and a note that says when a change applies.
// A plain global <script> loaded by index.html directly BEFORE workflow-graph-view.js; its builders are pure string functions (no DOM) so `node --test` can load them in a bare vm context.
// Uses these globals from the other scripts: buildWorkerSwitchHtml (worker-switch-ui.js), buildWorkerModelSelectHtml (worker-model-select.js), buildTaskPickerHtml (worker-task-picker.js), buildDetailHtml, wfEsc and wfSetTaskType
// (workflow-graph-view.js), renderWorkers and setWorkerTask (workers-tab.js).

// One note per provider: a model override applies on the lane's next tick; the lane registry (provider, endpoint, task classes) is frozen at launch, so a change there needs a pipeline restart.
const WF_APPLY_NOTES = {
  local: "A model change applies on this lane's next tick (about 30 seconds). Provider, endpoint and task classes come from lanes.json and need a pipeline restart.",
  cloud: 'The cloud model is chosen by the gateway, not by this dashboard. Provider and endpoint come from lanes.json and need a pipeline restart.',
  script: 'A script lane runs no model. Its settings come from lanes.json and need a pipeline restart.',
};

// A worker loop node can be given a specific task, like a worker card: the same prefix test canAssignTask in workers-tab.js uses (the graph runtime has no `assignable` field).
function isTaskPinNode(node) {
  return !!node && node.kind === 'loop' && !!node.runtime && String(node.id).startsWith('worker');
}

// The inside of the task-pick slot. tasks = { items, type, error } from the view's state; undefined/null while the list is still loading.
function buildTaskPickSlotHtml(node, tasks) {
  if (!tasks) return '<span class="meta">Loading tasks…</span>';
  if (tasks.error) return '<span class="meta">Task list unavailable.</span>';
  return buildTaskPickerHtml({ instanceId: node.id }, tasks.items || [], tasks.type || '');
}

// The switch, the model control, the apply note and (for a worker) the task-pick slot of a loop node; '' when the node has no runtime or no model.
function buildNodeControlsHtml(node, tasks) {
  const rt = node && node.runtime;
  const m = node && node.model;
  if (!rt || !m) return '';
  const sw = buildWorkerSwitchHtml(rt);
  const inst = { instanceId: node.id, provider: m.provider, model: m.name };
  const models = { ollamaModels: (m.choices && m.choices.local) || [], claudeModels: (m.choices && m.choices.cloud) || [] };
  const select = buildWorkerModelSelectHtml(inst, models, m.overridden ? { [node.id]: m.name } : {});
  return '<div class="wf-controls">' + (sw ? '<div class="wf-control-row">' + sw + '</div>' : '')
    + (select ? '<div class="wf-control-row">' + select + '</div>' : '')
    + '<div class="meta wf-apply-note">' + wfEsc(WF_APPLY_NOTES[m.provider] || WF_APPLY_NOTES.local) + '</div>'
    + (isTaskPinNode(node) ? '<div class="wf-control-row"><div id="wf-taskpick" class="wf-taskpick">' + buildTaskPickSlotHtml(node, tasks) + '</div></div>' : '') + '</div>';
}

// Where a task source stands in today's claim order: its registered priority, its competition rank among all sources and how many other sources share the priority.
// priorityOrder = the graph's [{ name, priority, rank }] (src/workflow-priority.js); '' for a node that is not a source, or a source the list does not have.
function buildSourcePriorityHtml(node, priorityOrder) {
  if (!node || node.kind !== 'source' || !Array.isArray(priorityOrder)) return '';
  const name = String(node.id).replace(/^source:/, '');
  const entry = priorityOrder.find((e) => e && e.name === name);
  if (!entry) return '';
  const same = priorityOrder.filter((e) => e && e.name !== name && e.priority === entry.priority).length;
  return '<div class="meta wf-priority">Flat priority ' + wfEsc(entry.priority) + ' · rank ' + wfEsc(entry.rank) + ' of ' + wfEsc(priorityOrder.length)
    + (same ? ' · ' + same + ' other source(s) share this priority' : '') + '</div>';
}

// The whole panel of a loop node (the facts of buildDetailHtml plus the controls) or of a source with a priority line; '' for any other node, which keeps the read-only panel.
function buildNodePanelHtml(node, warnings, tasks, priorityOrder) {
  if (node && node.kind === 'source') {
    const line = buildSourcePriorityHtml(node, priorityOrder);
    return line ? buildDetailHtml(node, warnings, line) : '';
  }
  if (!node || node.kind !== 'loop' || !node.runtime || !node.model) return '';
  return buildDetailHtml(node, warnings, buildNodeControlsHtml(node, tasks));
}

// The existing model-override route; an empty model clears the override.
async function wfSetModelDefault(instanceId, model) {
  await fetch('/api/worker-models/' + encodeURIComponent(instanceId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
}

// deps = { setModel(instanceId, model), refresh(), setTask(instanceId, taskId, title, sourceLane), setType(instanceId, type) }; all default to the real ones, tests pass fakes.
function wireNodePanel(root, deps) {
  const d = deps || {};
  const setModel = d.setModel || wfSetModelDefault;
  const refresh = d.refresh || (() => renderWorkers());
  const setTask = d.setTask || ((...args) => setWorkerTask(...args));
  const setType = d.setType || ((id, type) => wfSetTaskType(id, type));
  root.querySelectorAll('#wf-detail .worker-model-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = async (e) => {
      e.stopPropagation();
      await setModel(sel.dataset.instanceId, sel.value);
      await refresh();
    };
  });
  // The task picker: choosing a type only redraws the slot; choosing a task goes through the existing confirm and assign-task route (setWorkerTask) like the Cards view.
  root.querySelectorAll('#wf-detail .worker-type-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = (e) => { e.stopPropagation(); setType(sel.dataset.instanceId, sel.value); };
  });
  root.querySelectorAll('#wf-detail .worker-task-select').forEach((sel) => {
    sel.onclick = (e) => e.stopPropagation();
    sel.onchange = async (e) => {
      e.stopPropagation();
      const taskId = sel.value;
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      const title = opt && opt.dataset && opt.dataset.title;
      const sourceLane = opt && opt.dataset && opt.dataset.sourceLane ? opt.dataset.sourceLane : null;
      sel.value = ''; // confirm() may be declined, and a real assignment redraws the graph anyway
      await setTask(sel.dataset.instanceId, taskId, title, sourceLane);
    };
  });
}

if (typeof module !== 'undefined') module.exports = { WF_APPLY_NOTES, isTaskPinNode, buildTaskPickSlotHtml, buildNodeControlsHtml, buildNodePanelHtml, buildSourcePriorityHtml, wfSetModelDefault, wireNodePanel };
