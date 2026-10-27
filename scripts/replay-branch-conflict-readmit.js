#!/usr/bin/env node
'use strict';
// Replay the conflict re-admission sweep against a real pipeline WITHOUT changing it: the pipeline's queue states are symlinked into a scratch
// pipeline dir (so the state file lands there) and the sweep runs in dry-run mode twice, the second time SETTLE_MS later.
//   node scripts/replay-branch-conflict-readmit.js <scratch-pipeline-dir> <repoRoot> [mainBranch]
const { sweepBranchConflicts, SETTLE_MS } = require('../src/branch-conflict-readmit-sweep.js');
(async () => {
  const [pipelineDir, repoRoot, mainBranch = 'main'] = process.argv.slice(2);
  if (!pipelineDir || !repoRoot) { console.error('usage: replay-branch-conflict-readmit.js <scratch-pipeline-dir> <repoRoot> [mainBranch]'); process.exit(2); }
  const t0 = Date.now();
  const a = await sweepBranchConflicts({ pipelineDir, repoRoot, mainBranch, now: t0, modeOverride: 'dry-run' });
  const b = await sweepBranchConflicts({ pipelineDir, repoRoot, mainBranch, now: t0 + SETTLE_MS + 1000, modeOverride: 'dry-run', fetch: false });
  console.log(JSON.stringify({ firstRun: { checked: a.checked, observed: a.observed.map((x) => x.id) }, secondRun: { requeued: b.requeued, exhausted: b.exhausted, errors: b.errors } }, null, 2));
})();
