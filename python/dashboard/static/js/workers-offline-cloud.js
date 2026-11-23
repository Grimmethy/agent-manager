// Workers tab: an offline cloud instance only needs one line, so the Workers tab shows the first offline cloud row and hides the rest.
// collapseOfflineCloud() decides which row that is. It is pure: no DOM, no network, no timers. A plain global <script> loaded right after workers-render-signature.js.

// A cloud row has provider 'cloud', or is reviewer-<suffix> whose worker-<suffix> row has provider 'cloud'.
// Offline cloud rows have status 'offline' or 'disabled'. The first one in natural order (workers before reviewers, then numeric id) stays visible.
// Returns {shown, hidden}; both keep input order. Never mutates its input. Non-array input gives {shown: [], hidden: []}.
function collapseOfflineCloud(instances) {
  if (!Array.isArray(instances)) return { shown: [], hidden: [] };

  const hasId = (inst) => inst !== null && typeof inst === 'object' && typeof inst.instanceId === 'string';

  const workerProvider = new Map();
  for (const inst of instances) {
    if (hasId(inst) && inst.instanceId.startsWith('worker-')) {
      workerProvider.set(inst.instanceId.slice('worker-'.length), inst.provider);
    }
  }

  const isCloud = (inst) => {
    if (!hasId(inst)) return false;
    if (inst.provider === 'cloud') return true;
    if (inst.instanceId.startsWith('reviewer-')) {
      return workerProvider.get(inst.instanceId.slice('reviewer-'.length)) === 'cloud';
    }
    return false;
  };

  const isOfflineCloud = (inst) => isCloud(inst) && (inst.status === 'offline' || inst.status === 'disabled');

  // Natural order key: [kind, numeric id], where kind 0 = worker, 1 = reviewer, 2 = other.
  const rank = (inst) => {
    const kind = inst.instanceId.startsWith('worker-') ? 0 : inst.instanceId.startsWith('reviewer-') ? 1 : 2;
    const suffix = kind === 0 ? inst.instanceId.slice('worker-'.length)
      : kind === 1 ? inst.instanceId.slice('reviewer-'.length) : inst.instanceId;
    const id = /^\d+$/.test(suffix) ? Number(suffix) : Infinity;
    return [kind, id];
  };

  let keep = null;
  let keepRank = null;
  for (const inst of instances) {
    if (!isOfflineCloud(inst)) continue;
    const r = rank(inst);
    if (keepRank === null || r[0] < keepRank[0] || (r[0] === keepRank[0] && r[1] < keepRank[1])) {
      keep = inst;
      keepRank = r;
    }
  }

  const shown = [];
  const hidden = [];
  for (const inst of instances) {
    if (isOfflineCloud(inst) && inst !== keep) hidden.push(inst);
    else shown.push(inst);
  }
  return { shown, hidden };
}

if (typeof module !== 'undefined') module.exports = { collapseOfflineCloud };
