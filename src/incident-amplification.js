'use strict';

// Incident Amplification's sweep (2026-09-08) -- given a CONFIRMED root cause (a real
// systemic/mechanism gap, not a model judgment call), deliberately search the codebase
// broadly for the same missing concept at other call sites ("silent siblings") and file
// each one found as its own side-finding, reusing side-finding.js/side-finding-sweep.js's
// already-built filing+dedup machinery end to end -- no new brain-dump schema, no new
// dedup logic. See concepts.json's concept-incident-amplification-f07999 for the full
// design and src/incident-amplification-marker.js for how a model triggers this.
//
// Deliberately does NOT fix anything -- Grimmethy, correcting the first pass at this
// concept: "we need to make sure that this investigation is building brain dumps in the
// same way that debrief does. Rather than immediately chase down and fix everything."
// This function's only two possible effects are a read (grepCodebase) and N additive
// writes into queue/side-findings-inbox/ -- it never touches source files.

const path = require('path');
const { grepCodebase } = require('./grep-codebase-tool.js');
const { writeSideFindingInbox } = require('./side-finding.js');

// Best-effort, fail-open: any missing required input is a silent no-op (matches
// writeSideFindingInbox's own best-effort contract) -- this is always invoked as a
// side-effect of a model response, never something a caller should let bring down the
// real turn it rode in on.
function runAmplificationSweep({
  rootCauseSummary,
  query,
  dir,
  root,
  excludeFiles = [],
  pipelineDir,
  source,
  taskId = null,
  stage = 'incident-amplification',
  conceptId = null,
}) {
  const empty = { matched: 0, filed: 0, excluded: 0 };
  if (!query || !rootCauseSummary || !pipelineDir) return empty;

  let result;
  try {
    result = grepCodebase({ query, dir, root });
  } catch (e) {
    return empty;
  }
  if (!Array.isArray(result)) return empty; // grepCodebase returned { error: ... }

  const excludeSet = new Set((excludeFiles || []).map((f) => path.normalize(String(f))));
  const matched = result.length;
  let filed = 0;
  let excluded = 0;

  for (const hit of result) {
    const normalizedFile = path.normalize(hit.file || '');
    if (excludeSet.has(normalizedFile)) {
      excluded += 1;
      continue;
    }
    // Title leads with file:line -- keeps each site individually identifiable even where
    // side-finding-sweep.js's own shared-phrase/Jaccard dedup legitimately merges
    // near-identical siblings into one consolidated entry (count++/seenIn.push) --
    // exactly the designed behavior of the mechanism this reuses, not something to fight.
    const title = `${hit.file}:${hit.line} -- possible sibling of confirmed root cause`;
    const body = `${rootCauseSummary}\n\nMatched line: ${hit.text}`;
    try {
      writeSideFindingInbox({ title, body }, {
        source: source || 'incident-amplification', taskId, stage, pipelineDir, conceptId,
      });
      filed += 1;
    } catch (e) {
      // One bad write must never drop the rest -- same discipline as every other
      // watchdog sweep in this codebase.
    }
  }

  return { matched, filed, excluded };
}

module.exports = { runAmplificationSweep };
