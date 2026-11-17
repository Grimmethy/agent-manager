'use strict';

// task-detail-deps.js: enhances the task detail modal with dependency-state resolution
// and a compact status summary. Fetches the full task store via GET /api/queue?project=all
// so each dependency's state is looked up from the canonical store, not from the task's own
// dependsOn hint. Independent of queue-view.js but uses the same API contract:
//
//   rows = [{id, title, state, project, dependsOn}]
//   dependsOn = [{taskId, state, project}]
//
// Plain-global <script> file (shares scope with core-ui.js / task-detail-modal.js).
// require()-able for node:test.

var TaskDetailDeps = (function () {
  var FULL_STORE_URL = '/api/queue?project=all';

  // Pure: escape HTML. Identical shape to core-ui.js escapeHtml so inline markup stays safe.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Pure: resolve the state for a single dependency from the full task store.
  // Returns the resolved dep object (with state filled in) or a sentinel {taskId, state:'unknown', project:'?'}
  // when the taskId is missing from the store.
  function resolveDep(dep, fullStore) {
    if (!dep || typeof dep !== 'object') return null;
    var taskId = dep.taskId;
    if (!taskId) return null;
    var match = fullStore.find(function (r) { return r.id === taskId; });
    if (!match) {
      return { taskId: String(taskId), state: 'unknown', project: String(dep.project || '?') };
    }
    return { taskId: String(taskId), state: match.state || 'unknown', project: match.project || String(dep.project || '?') };
  }

  // Pure: render one dependency row. The root section carries data-unresolved-deps = count
  // of malformed/missing deps so a broken fixture is observable in the DOM.
  function depRowHtml(resolved, unresolvedCount) {
    var cls = resolved.state === 'unknown' ? 'dep-row dep-unresolved' : 'dep-row';
    var badgeCls = resolved.state === 'unknown' ? 'badge warn'
      : (resolved.state === 'done' ? 'badge ok' : 'badge');
    var label = esc(resolved.taskId) + ' · ' + esc(resolved.state) + ' · ' + esc(resolved.project);
    return '<div class="' + cls + '" data-unresolved-deps="' + unresolvedCount + '">'
      + '<span class="dep-id">' + esc(resolved.taskId) + '</span>'
      + '<span class="' + badgeCls + '">' + esc(resolved.state) + '</span>'
      + '<span class="meta">' + esc(resolved.project) + '</span>'
      + '</div>';
  }

  // Pure: render the status summary block (state + claimed-by).
  function statusBlockHtml(task) {
    var state = task.state || task._foundState || '?';
    var stateCls = (state === 'done' || state === 'approved') ? 'badge ok'
      : (state === 'blocked' || state === 'awaiting-confirm') ? 'badge bad'
      : 'badge';
    var claimedBy = task.claimedBy || task.claimed_by || '';
    var claimedHtml = claimedBy ? esc(claimedBy) : '—';
    return '<div class="deps-status">'
      + '<div class="deps-field"><span class="field-label">State</span> <span class="' + stateCls + '">' + esc(state) + '</span></div>'
      + '<div class="deps-field"><span class="field-label">Claimed by</span> ' + claimedHtml + '</div>'
      + '</div>';
  }

  // Pure: render last N history entries (default 3). The task history array is chronological.
  function historyBlockHtml(task, n) {
    n = n == null ? 3 : Math.max(0, Math.floor(n));
    var hist = Array.isArray(task.history) ? task.history : [];
    var last = hist.slice(Math.max(0, hist.length - n));
    if (!last.length) return '';
    var rows = last.map(function (h) {
      var label = h.stage || h.status || '?';
      var when = h.at ? new Date(h.at).toLocaleString() : '';
      var detail = h.detail || h.note || '';
      return '<div class="deps-history-row"><span class="deps-history-stage">' + esc(label) + '</span>'
        + '<span class="meta">' + esc(when) + '</span>'
        + (detail ? '<div class="meta">' + esc(detail) + '</div>' : '')
        + '</div>';
    }).join('');
    return '<div class="deps-history"><div class="field-label">Recent history</div>' + rows + '</div>';
  }

  // Pure: build the full deps section HTML. Counts malformed deps for the data-unresolved-deps attribute.
  function buildHtml(task, fullStore) {
    var unresolvedCount = 0;
    var deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    var resolvedDeps = [];
    deps.forEach(function (dep) {
      var resolved = resolveDep(dep, fullStore);
      if (resolved === null) {
        unresolvedCount++;
      } else {
        resolvedDeps.push(resolved);
      }
    });

    var depRows = resolvedDeps.map(function (r) { return depRowHtml(r, unresolvedCount); }).join('');
    var historyHtml = historyBlockHtml(task, 3);
    var statusHtml = statusBlockHtml(task);

    return '<div class="deps-section" data-unresolved-deps="' + unresolvedCount + '">'
      + '<div class="field-label">Dependencies</div>'
      + statusHtml
      + (depRows ? '<div class="deps-list">' + depRows + '</div>' : '<div class="meta">(no dependencies)</div>')
      + historyHtml
      + '</div>';
  }

  // Async: fetch the full task store and render. Used by the modal hook.
  async function loadAndRender(container, task) {
    var resp;
    try {
      resp = await fetch(FULL_STORE_URL);
      if (!resp.ok) throw new Error('GET ' + FULL_STORE_URL + ' failed: ' + resp.status);
    } catch (e) {
      if (container) container.innerHTML = '<div class="deps-section" data-unresolved-deps="0"><div class="field-label">Dependencies</div><div class="meta">Could not load task store: ' + esc(e.message) + '</div></div>';
      return null;
    }
    var fullStore;
    try {
      fullStore = await resp.json();
    } catch (e) {
      if (container) container.innerHTML = '<div class="deps-section" data-unresolved-deps="0"><div class="field-label">Dependencies</div><div class="meta">Could not parse task store: ' + esc(e.message) + '</div></div>';
      return null;
    }
    if (!Array.isArray(fullStore)) fullStore = [];
    var html = buildHtml(task, fullStore);
    if (container) container.innerHTML = html;
    return fullStore;
  }

  return {
    esc: esc,
    resolveDep: resolveDep,
    buildHtml: buildHtml,
    loadAndRender: loadAndRender,
    FULL_STORE_URL: FULL_STORE_URL,
    depRowHtml: depRowHtml,
    statusBlockHtml: statusBlockHtml,
    historyBlockHtml: historyBlockHtml,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TaskDetailDeps;
