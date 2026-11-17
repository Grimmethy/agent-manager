'use strict';

// Queue page frontend: fetches GET /api/queue?project=<filter> and renders one row per task.
// Plain-<script> file (shares one global scope); also require()-able for node:test.
//
// Contract: rows are [{id, title, state, project, dependsOn}], dependsOn is [{taskId, state, project}].
// The project filter applies ONLY to a row's own `project`. dependsOn entries are rendered unchanged,
// because the server resolves them from the full task store (bypassing the filter).

var QueueView = (function () {
  var stats = { hiddenByFilter: 0, hiddenIds: [] };

  function rowKey(row) {
    return String(row.project) + ':' + String(row.id);
  }

  // Pure: split rows into visible/hidden by the row's own project. filter is 'all', 'active', or a slug/label.
  // activeProjects is an optional array of project labels marked active in the registry.
  function filterRows(rows, filter, activeProjects) {
    var visible = [];
    var hidden = [];
    var seen = {};
    var active = activeProjects || [];
    (rows || []).forEach(function (row) {
      var key = rowKey(row);
      if (seen[key]) return; // dedup on (project, id), not id alone
      seen[key] = true;
      var keep;
      if (!filter || filter === 'all') keep = true;
      else if (filter === 'active') keep = active.indexOf(row.project) !== -1;
      else keep = row.project === filter;
      (keep ? visible : hidden).push(row);
    });
    return { visible: visible, hidden: hidden };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Renders one dependency chip. Unresolved entries (missing state) are shown, not dropped.
  function depChip(dep) {
    var resolved = dep && dep.state;
    var cls = resolved ? 'dep-chip' : 'dep-chip dep-unresolved';
    var label = resolved ? (dep.taskId + ' (' + dep.state + ', ' + (dep.project || '?') + ')') : (String((dep && dep.taskId) || '?') + ' (unresolved)');
    return '<span class="' + cls + '">' + esc(label) + '</span>';
  }

  function renderRow(row, template) {
    var deps = (row.dependsOn || []).map(depChip).join('');
    return template
      .replace(/\{\{title\}\}/g, esc(row.title))
      .replace(/\{\{id\}\}/g, esc(row.id))
      .replace(/\{\{state\}\}/g, esc(row.state))
      .replace(/\{\{project\}\}/g, esc(row.project))
      .replace(/\{\{deps\}\}/g, deps);
  }

  // rowTemplate: the text of templates/queue_row.html. container: DOM element to fill.
  function render(rows, opts) {
    opts = opts || {};
    var split = filterRows(rows, opts.filter || 'all', opts.activeProjects);
    stats = {
      hiddenByFilter: split.hidden.length,
      hiddenIds: split.hidden.map(rowKey)
    };
    var html = split.visible.map(function (r) { return renderRow(r, opts.rowTemplate || ''); }).join('');
    if (opts.container) opts.container.innerHTML = html;
    return split;
  }

  // Fetch on demand only (initial load / filter change). No polling.
  function load(filter, opts) {
    var url = '/api/queue?project=' + encodeURIComponent(filter || 'active');
    return fetch(url).then(function (resp) {
      if (!resp.ok) throw new Error('GET /api/queue failed: ' + resp.status);
      return resp.json();
    }).then(function (rows) {
      return render(rows, Object.assign({ filter: filter }, opts || {}));
    });
  }

  return {
    load: load,
    render: render,
    filterRows: filterRows,
    rowKey: rowKey,
    get stats() { return stats; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QueueView;
