// Shared worker model control (HUB0325 piece W-B2): which kind of model control an instance gets, and its markup. Used by the Workers tab cards and, later, the Graph node panel.
// A plain global <script> holding only declarations, loaded by index.html directly BEFORE workers-tab.js; the guarded one-line export at the bottom lets `node --test` require it.
// Uses escapeHtml (core-ui.js) and escapeAttr (branches-joblist-hardware-tabs.js) from the shared global scope.

// 'ollama' = a model select over the local Ollama models (today's control); 'gateway' = a cloud lane, whose model is chosen by the cloud-providers gateway (it ignores the model a caller sends),
// so the model is shown read-only; 'script' = a script lane, no model; null = no control (the watchdog). Any other provider value (null, undefined, 'local') keeps today's answer.
function modelKindForInstance(inst) {
  if (inst.instanceId === 'watchdog') return null;
  if (inst.provider === 'cloud') return 'gateway';
  if (inst.provider === 'script') return 'script';
  return 'ollama'; // every other lane runs a local model (lanes are one per GPU)
}

function buildWorkerModelSelectHtml(inst, workerModels, overrides) {
  const kind = modelKindForInstance(inst);
  if (!kind) return '';
  if (kind === 'gateway') {
    return `<span class="meta worker-model-fixed" title="The cloud model is chosen by the gateway, not by this dashboard">cloud model set by the gateway: ${escapeHtml(inst.model || '-')}</span>`;
  }
  if (kind === 'script') return '<span class="meta worker-model-fixed">script lane, no model</span>';
  const current = (overrides || {})[inst.instanceId] || '';
  const body = ((workerModels && workerModels.ollamaModels) || []).map(m => `<option value="${escapeAttr(m)}" ${m === current ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  return `<select class="worker-model-select" data-instance-id="${escapeAttr(inst.instanceId)}" onclick="event.stopPropagation()"><option value="">(default)</option>${body}</select>`;
}

if (typeof module !== 'undefined') module.exports = { modelKindForInstance, buildWorkerModelSelectHtml };
