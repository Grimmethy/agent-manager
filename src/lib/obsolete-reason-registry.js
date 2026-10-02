'use strict';

// obsolete-reason-registry.js -- data-only registry of obsolete-reason patterns.
// To add a new entry, append one object literal to the array below.

const OBSOLETE_REASON_REGISTRY = [
  {
    reasonPattern: /Preliminary size check: this task spans \d+ independent pieces/,
    fixedAsOf: '2026-09-14',
    source: 'adhoc-brain-dump-bd-1789651925977-6-needs-clarification-tasks-were-pre-202-1789906414718',
    description:
      'Tasks flagged by a preliminary size check as spanning multiple independent pieces; decomposed and the original task marked obsolete.',
  },
];

module.exports = { OBSOLETE_REASON_REGISTRY };
