/**
 * Pure helpers for the Filed Findings tab's paged loading. Keys rows by the `id` field.
 * Plain script (no ES module syntax) so it loads via a <script> tag, with a CommonJS export guard for node:test.
 * No timers, no DOM access, no module-level state.
 */
(function (root) {
  'use strict';

  function footerText(shown, total) {
    return 'Showing ' + shown + ' of ' + total;
  }

  function appendRows(renderedIds, rows) {
    var updated = new Set(renderedIds);
    var newRows = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!updated.has(row.id)) {
        newRows.push(row);
        updated.add(row.id);
      }
    }
    return { rows: newRows, renderedIds: updated };
  }

  var api = { footerText: footerText, appendRows: appendRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.filedFindingsPaging = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
