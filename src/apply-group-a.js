'use strict';

// Deterministic (no-LLM) writers for "Group A" task sources -- ones whose implement draft
// is already a literal artifact (a vault note to save, etc.), not a prose description of a
// change or grammar-constrained JSON. Part of removing an LLM from the apply step entirely
// -- see apply-task.js, which calls this after a task has already been reviewed and approved.
//
// Only the fully generic writer lives here. Project-specific Group A writers (e.g. a
// county-index-file writer, a markdown-candidate-appender) belong in the CONSUMING
// project's own registration file and get wired in via updateTaskSource(name, { apply })
// exactly like this package's own arch_review/trouble_log/adhoc sources use the Group B
// default -- see README.md "Registering a custom apply function".

const fs = require('fs');
const path = require('path');

function applySecondBrainNote({ implementResponse, notePath, secondBrainDir }) {
  const resolvedPath = path.isAbsolute(notePath) ? notePath : path.join(secondBrainDir, notePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, implementResponse || '');

  const markerPath = resolvedPath + '.done';
  fs.writeFileSync(markerPath, '');

  return { file: resolvedPath, marker: markerPath };
}

module.exports = { applySecondBrainNote };
