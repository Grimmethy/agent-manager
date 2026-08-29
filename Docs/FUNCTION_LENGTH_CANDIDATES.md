# Function Length Decomposition Candidates

### AC-1 · Decompose the monolithic system-report builder into per-section renderers
Strength: Strong
Files: src/system-report.js
Snippet:
```
      ? ` (${fmtUsd(timeAccounting.totalCostUsd)} of that was REAL Claude spend; the rest ran locally, free, and is a token-based estimate)`
      : ' (every one of those calls actually ran locally, free -- this is a token-based estimate of what they would have cost)';
    sentences.push(`If every model call this period had gone through the Anthropic API, it would have cost an estimated ${fmtUsd(timeAccounting.totalHypotheticalCostUsd)} across ${timeAccounting.callsWithHypotheticalCost} call(s)${realPart}.`);
  }

  return sentences.join(' ');
}

function renderMarkdown({ period, startIso, endIso, tasks, downtime, timeAccounting, queueHealth, selfAuditActivity, blockedPatterns }) {
  const bySource = {};
  const byClassification = { junk: 0, benefit: 0, filtering: 0, housekeeping: 0, unclear: 0 };
  for (const t of tasks) {
    bySource[t.source || 'unknown'] = (bySource[t.source || 'unknown'] || 0) + 1;
    byClassification[t.classification] = (byClassification[t.classification] || 0) + 1;
  }

  const lines = [];
  lines.push(`# ${period[0].toUpperCase()}${period.slice(1)} Report — ${fmtLocal(startIso)} to ${fmtLocal(endIso)}`);
  lines.push('');
  lines.push(`**Tasks completed:** ${tasks.length}`);
  lines.push('');

  lines.push('## Summary');
  lines.push(buildPlainEnglishSummary({ period, tasks, byClassification, blockedPatterns, downtime, timeAccounting }));
  lines.push('');

  lines.push('## By Source');
  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${source}: ${count}`);
  }
  lines.push('');

```

Problem:
The report-building function accepts nine parameters (`period`, `startIso`, `endIso`, `tasks`, `downtime`, `timeAccounting`, `queueHealth`, `selfAuditActivity`, `blockedPatterns`) and spans roughly 137 lines because it interleaves data aggregation (computing `bySource` and `byClassification` maps) with the rendering of seven visually distinct markdown sections. Each section — "By Source," "By Classification," "Downtime," "Time Accounting," "Queue Health," "Self-Audit," "Blocked Patterns" — is a self-contained block of a header line, a loop or a few conditionals, and a trailing blank line, yet none can be tested, reviewed, or modified in isolation without constructing all nine parameters and parsing the full markdown output. The fact that `buildPlainEnglishSummary` was already extracted proves the decomposition pattern is viable here; the remaining sections simply haven't received the same treatment.

Solution:
Extract each markdown section into its own small, clearly-named pure function that takes only the slice of data it needs and returns a string (or an array of lines). Concretely: `renderBySource(bySource)`, `renderByClassification(byClassification)`, `renderDowntime(downtime)`, `renderTimeAccounting(timeAccounting)`, `renderQueueHealth(queueHealth)`, `renderSelfAudit(selfAuditActivity)`, and `renderBlockedPatterns(blockedPatterns)`. The top-level function then shrinks to (a) the two aggregation loops that produce `bySource` and `byClassification`, and (b) a short array of section strings joined with newlines, passing each parameter to exactly one renderer. The aggregation step can itself be pulled into `aggregateTaskStats(tasks)` if desired, leaving the top-level function as a thin orchestrator of roughly 15–20 lines.

Benefits:
Each renderer becomes independently unit-testable with a single argument, so a test for the Downtime warning threshold no longer needs to fabricate eight unrelated parameters or regex-scan a multi-section markdown blob. Code review diffs become scoped to one section at a time, making it obvious when a taxonomy rename touches only `renderByClassification` and `aggregateTaskStats` rather than a 137-line wall. New sections (e.g., a "Top 5 blocked patterns" sub-list) are added by writing one new function and appending one line to the orchestrator, with zero risk of accidentally reordering or breaking an unrelated section.
