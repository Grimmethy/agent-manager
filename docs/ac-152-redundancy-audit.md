# AC-152 redundancy audit (HUB0664 1/2, read-only)

## 1. Path check
```
OK src/task-sources.js
OK src/task-source-registry.js
OK src/lib/apply-core.js
OK src/apply-task.js
OK src/local-draft.js
OK src/lib/apply-main-batch.js
```

## 2. Raw grep output
### grep -rn "../task-sources\|./task-sources" src/
```
src/codebase-map-freshness.test.js:9:// registry the way src/task-sources.js's own drift-scan.js PAIRS mechanism expects).
src/codebase-map-freshness.test.js:125:  assert.equal(resolveShorthand('src/task-sources.js'), 'src/task-sources.js');
src/apply-retry-check.js:467:  require('./task-sources.js');
src/workflow-priority.js:9:// (lower = claimed sooner, src/task-sources.js registerTaskSource). `rank` is the competition rank: 1 + the number of entries with a strictly lower priority,
src/workflow-priority.js:90:  require('./task-sources.js');
src/staleness-fastpath.js:7:// src/task-sources.js:55) burned all 3 infra-requeue rounds on real, populated local-model
src/path-prefetch.js:131:// the substring pass below and picks up BOTH "src/task-sources.js" and its own
src/path-prefetch.js:132:// "src/task-sources.test.js" sibling -- two hits that look ambiguous but really aren't:
src/queue-presence.test.js:64:  delete require.cache[require.resolve('./task-sources.js')];
src/queue-presence.test.js:65:  assert.equal(require('./task-sources.js').taskIdExistsInQueue('z'), true);
src/queue-presence.test.js:71:  assert.equal(graph.all['src/queue-presence.js'].includes('src/task-sources.js'), false);
src/queue-presence.test.js:72:  assert.equal(graph.all['src/brain-dump-resolution-check.js'].includes('src/task-sources.js'), false);
src/dry-run.js:114:  require('./task-sources.js'); // registers sources (and the plugin) so write-tier sources are recognised
src/apply-task.js:35:require('./task-sources.js');
src/review-repro.test.js:21:require('./task-sources.js');
src/local-draft.test.js:74:// ./task-sources.js no longer registers them. Several tests below assert CORE draft
src/local-draft.test.js:155:  delete require.cache[require.resolve('./task-sources.js')];
src/local-draft.test.js:158:  require('./task-sources.js'); // registers 'adhoc' and friends' base config
src/local-draft.test.js:1699:  const fetchedFiles = [{ path: 'src/task-sources.js', content: 'function real() {\n  return 1;\n}\n' }];
src/local-draft.test.js:1701:  const bad = JSON.stringify({ mode: 'edit', file: 'src/task-sources.js', find: 'this text is not in the file', replace: 'x' });
src/local-draft.test.js:1702:  assert.deepEqual(findUnverifiedEdit(bad, fetchedFiles), { file: 'src/task-sources.js', find: 'this text is not in the file', problem: 'find-missing' });
src/local-draft.test.js:1704:  const good = JSON.stringify({ mode: 'edit', file: 'src/task-sources.js', find: 'return 1;', replace: 'return 2;' });
src/prompts.test.js:689:      harnessHits: [{ file: 'src/task-sources.js', line: 100, query: 'change_review', text: "registerTaskSource('change_review', ...)" }],
src/prompts.test.js:697:  assert.match(p, /src\/task-sources\.js:100/);
src/prompts.test.js:736:  require('./task-sources.js'); // registers the adhoc source so buildPlanPrompt can dispatch to adhocPlanPrompt
src/poll-avoidance-prompts.test.js:10:require('./task-sources.js');
src/task-sources-registry.test.js:3:// Registry snapshot (roadmap step 1, piece P7.0): the task sources src/task-sources.js registers at load time. P7 moves the source families into
src/task-sources-registry.test.js:13:require('./task-sources.js');
src/lib/prompt-implementation.js:5:require('../task-sources.js');
src/lib/task-priority.js:3:// task-priority.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).
src/lib/task-selection.test.js:20:const taskSources = require('../task-sources.js'); // load for its real generators (nextAdhocTask / nextDerivedTask)
src/lib/apply-main-batch.js:11:require('../task-sources.js');
src/lib/task-selection-loaders.test.js:47:  assert.equal(graph.all['src/lib/task-selection.js'].includes('src/task-sources.js'), false);
src/lib/task-selection-loaders.test.js:54:  delete require.cache[require.resolve('../task-sources.js')];
src/lib/task-selection-loaders.test.js:55:  const sources = require('../task-sources.js');
src/lib/prompt-planning.js:6:require('../task-sources.js');
src/lib/apply-main-batch.test.js:26:// requires ./config.js + ./task-sources.js (which resolve the repo root from
src/lib/candidate-doc-refs.test.js:141:  delete require.cache[require.resolve('../task-sources.js')];
src/lib/candidate-doc-refs.test.js:143:  const { nextCandidateFulfillmentTask } = require('../task-sources.js');
src/lib/source-scope.test.js:44:    require('../task-sources.js');
src/lib/task-selection.js:3:// task-selection.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).
src/lib/task-resolve.js:3:// task-resolve.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).
src/lib/task-audit.js:3:// task-audit.js -- extracted from src/task-sources.js ([[hub-task-integration]] node-module decompose).
src/lib/apply-core.js:9:require('../task-sources.js');
src/node-claim.js:24:const { isDependencySatisfied } = require('./task-sources.js');
src/review-mock-seam-wiring.test.js:21:require('./task-sources.js');
src/review-guidance-protected-outcome.test.js:12:// The strings are read straight out of src/task-sources.js (not required) so this test
src/prompts.js:18:// buildImplementPrompt. require('./task-sources.js') below is loaded purely for its side
src/prompts.js:24:require('./task-sources.js');
src/review-task.test.js:50:require('./task-sources.js');
src/review-task.test.js:53:// plugin (2026-08-27), so ./task-sources.js no longer registers them. The verdict-gate
src/review-task.test.js:1661:// observability_review/performance_review above), so ./task-sources.js doesn't register
src/rank-priority.test.js:48:  delete require.cache[require.resolve('./task-sources.js')];
src/rank-priority.test.js:59:  assert.equal(graph.all['src/task-sources.js'].includes('src/next-claimable-task.js'), false);
src/entry-points-register.test.js:56:      delete require.cache[require.resolve('./task-sources.js')];
src/adhoc-diff-sanity.js:71:// ("a new task source in src/task-sources.js") both do. Fallback only -- see
src/adhoc-diff-sanity.js:178:// Verbs that ask the author to LOOK at a file, never to change it (2026-10-16: two read-only design/findings tasks, "Ground it in the current code with path:line ... in src/task-sources.js" and
src/adhoc-diff-sanity.js:179:// "Read the real history ... the existing task sources in src/task-sources.js", were blocked because "Ground" / "Read" are not on the non-verb list above and the file is named after "in"). None of
src/project-search-duplicates.test.js:58:  require('./task-sources.js');
src/empty-approval-decision.test.js:12:require('./task-sources.js');
src/path-prefetch.test.js:152:  writeSourceFile(repoRoot, 'src/task-sources.js');
src/path-prefetch.test.js:153:  writeSourceFile(repoRoot, 'src/task-sources.test.js');
src/path-prefetch.test.js:155:    { id: 0, community: 0, source_file: 'src/task-sources.js' },
src/path-prefetch.test.js:156:    { id: 1, community: 0, source_file: 'src/task-sources.test.js' },
src/path-prefetch.test.js:161:  assert.deepEqual(result, { status: 'matched', paths: ['src/task-sources.js'] });
src/path-prefetch.test.js:166:  writeSourceFile(repoRoot, 'src/task-sources.js');
src/path-prefetch.test.js:169:    { id: 0, community: 0, source_file: 'src/task-sources.js' },
src/path-prefetch.test.js:175:  assert.deepEqual(result, { status: 'matched', paths: ['src/task-sources.js'] });
src/replay-lab.js:320:    require('./task-sources.js'); // registers sources (and the plugin)
src/apply-group-a.test.js:229:    delete require.cache[require.resolve('./task-sources.js')];
src/apply-group-a.test.js:230:    const { nextCandidateFulfillmentTask } = require('./task-sources.js');
src/adhoc-diff-sanity.test.js:51:  const t = adhoc('Add a new task source in src/task-sources.js. Write an ADR in docs/adr/ alongside the implementation.');
src/adhoc-diff-sanity.test.js:52:  assert.equal(adhocDiffSubstanceProblem(t, editDiff('src/task-sources.js') + createDiff('docs/adr/0019-x.md')), null);
src/adhoc-diff-sanity.test.js:602:  const t = adhoc('Add a new task source in src/task-sources.js.');
src/adhoc-diff-sanity.test.js:603:  const p = adhocDiffSubstanceProblem(t, editDiff('src/task-sources.js'), 'Implemented. This creates the file `src/new-source.js` with the handler.');
src/adhoc-diff-sanity.test.js:609:  const t = adhoc('Add a new task source in src/task-sources.js.');
src/adhoc-diff-sanity.test.js:610:  const diff = editDiff('src/task-sources.js') + createDiff('src/new-source.js');
src/adhoc-diff-sanity.test.js:852:const REAL_INITIATIVE_RECORD_TEXT = "WHY (owner 2026-10-15: \"the system is our greatest asset and needs to be capable of swiftly, easily and gracefully handling these kinds of tasks\"). Evidence from 2026-10-15, live: (a) a read-only 'verify the map against three repos' task finished orient (2.5 min) and plan (2.2 min), spent ~5 min in the agentic implement pass, answered RESOLUTION: decompose with NO valid JSON array, was blocked (src/agentic-draft-common.js:494), sat 17 min, was requeued to repeat the same stages -- a retry loop that cannot succeed. (b) A one-line bug (brain-dump capture: max() over string serials, python/dashboard/routes/brain_dump.py:132) was approved and decomposed into SEVEN sub-tasks (HUB0148). (c) Owner builds goals made of pieces across several repos by hand, and the pipeline serves one project at a time. This task is one of three from the 'systematic fix' (shape-aware intake, decompose repair, an Initiative record). SCOPE RULE: this is ONE task, do not decompose it; do the smallest first PR described. TASK: write ONE file, Docs/initiative-record-design.md, and change nothing else. Design an 'Initiative' record: a goal made of pieces, each piece a task, with the dependencies between them, the repo each piece belongs to, a status derived from the pieces, and a hook that files the NEXT piece automatically when its dependency merges, so follow-through is a property of the system and not of a person. Ground it in the current code with path:line (confirmed vs unconfirmed): the five existing cross-reference mechanisms (see the Task Linking concept: hub parent/child, dependsOn, brainDumpEntryId, raisedFrom, derived-task links), nextAdhocTask()/isDependencySatisfied() in src/task-sources.js (dependsOn is satisfied only once the dependency is MERGED), hubs and coordinating/ (queue/coordinating), the hub-priority and premiumPriority ordering in src/next-claimable-task.js, and queue-adhoc-task.js. The doc must contain: the record shape (JSON example); how it differs from a hub (hubs are decompositions of ONE task; an initiative spans tasks, projects and time); which existing mechanism it should reuse so it does not become a sixth; how a piece names its target repo (the pipeline works one active project at a time today -- say what this requires of the scheduler, referencing the project-rotation findings if Docs/project-rotation-and-expiry-aging-findings.md exists); the dashboard view (one row per initiative: pieces done/in-flight/blocked, next piece, age by attention); how premium priority is inherited by pieces; failure modes and the smallest first PR (an initiative file plus a read-only dashboard list, no auto-filing yet); and an open-decisions list with a recommended default for each. Worked example: the GPU broker extraction (Docs/gpu-broker-extraction-map.md pieces G0-G7) expressed as an initiative.";
src/adhoc-diff-sanity.test.js:854:const REAL_TUNING_LOOPS_TEXT = "WHY (owner 2026-10-15): the owner has had Claude do system management and streamlining of Agent Manager by hand across many sessions and wants that fine-tuning broken into a set of repeatable tasks that run passively through the pipeline. A first, memory-and-skim pass (NOT evidence-backed) found nine recurring loops: (1) stalled-bucket drain (blocked / needs-clarification: find the one shared cause, fix it, release the bucket), (2) incident -> root cause -> sweep siblings (the Incident Amplification concept, never built), (3) unmerged-branch review (read the whole hub, verdict merge / needs-work / discard; docs/agents/unmerged-branch-review.md), (4) scanner precision tuning (measure false positives, cut them, confidence tiers, 'dismissed'), (5) policy-change follow-up (after a change, read a week of data, tighten, flip env switches; nothing currently remembers to do it), (6) triage candidate sifts (100-200 candidates into keep / drop / hold), (7) code-health and history analysis (a daily health ledger was proposed, not built), (8) brain-dump / memory / docs hygiene, (9) environment drift (env switches, lanes, P40, plugin env vs the intended state). The first pass saw 2,799 commits on origin/master since 2026-08-01, ~220 of them 'Triage batch' commits and several hundred fixes. SCOPE RULE: this is ONE task, write the single file named below, change nothing else, do not decompose. TASK: write ONE file, Docs/tuning-loops-catalogue.md. Read the real history, not the nine-item guess: git log of origin/master since 2026-08-01 (group commits and PR titles by theme; count them), queue/done and queue/done/_archived* task records and their history stages (which sources and job types recur, which tasks were retried, blocked or requeued and why), brain-dump.json entries (group by theme; note which were machine-raised vs session-raised), the memory notes under /home/wok/.claude/projects/-home-wok/memory/ whose name starts project-agent-manager-* (they record what each hand-run session found; read the index file MEMORY.md first), and docs/agents/, Docs/ and the existing task sources in src/task-sources.js and /media/model-cache/github/agent-manager-hygiene/src. Produce: (a) a table of the recurring loops actually found (correct, merge, split or drop the nine above with evidence), each with: how many times it ran (count and dates), what triggered it, the evidence a human or Claude looked at, the decision made, the artefact produced (PR, task, doc, env change), and whether any of it is ALREADY automated (name the source/sweep and path:line, or say none); (b) for each loop, a verdict: automate fully / automate evidence-gathering and keep a human gate / keep manual, with the reason; (c) the five most valuable gaps ranked by (frequency x cost of forgetting), with the evidence; (d) every claim marked confirmed (with path or commit) or unconfirmed. Do not run any live pipeline command, sweep, or task-sources.js. If a data source cannot be read, say so and continue with the rest. Keep under 300 lines.\n\nADDITIONAL EVIDENCE FROM A HAND-RUN SESSION (2026-10-14/15, Claude session 015TvzBxsPvNeXXdPbh273DP; session-raised, not yet checked against the repo history -- verify or correct each in the catalogue, and include them as loops or as members of the nine above): (A) LAND-AND-DEPLOY after every merge: fast-forward the live checkout, restart the plugin via kill pid + remove ~/.local/state/agent-manager/pids/plugin-<name>.pid + POST /api/plugins/<name>/ensure-started, confirm the running process serves the merged commit (done ~10 times that day for promptforge, storyforge, sceneforge, the dashboard); candidate loop: deploy-drift sweep. (B) PRE-FLIGHT before a pipeline start or project switch: an uncommitted edit in the target repo's checkout (e.g. storyforge stories/enough.json) is at risk because apply self-heal rescues/resets dirt (see the rescue branch agent/rescued-master-20261014193855 and PR #467 / #474); candidate: a start guard. (C) STATE CHECKS done by hand: P40 VM up (virsh), workers per lane, plugin pids and zombie pidfiles, host RAM vs the mem-guard 2048 MB threshold, whether the live PromptForge has CHARACTERFORGE_ROOT, which commit is live; candidate: the environment-drift loop. (D) STATUS DIGESTS: 'what is the queue doing' answered by reading queue/ directories, task histories and worker logs; candidate: a generated, phone-readable digest. (E) CONTACT SHEETS: building a labelled image sheet after a render job so a human can review it; candidate: automatic sheet per render job. (F) FILING FINDINGS: turning an incident into a well-formed brain dump or premium task with evidence and a 'do not decompose' scope rule; candidate: a file-this-finding helper. (G) MEMORY UPKEEP: writing/updating memory notes and the index after each stretch of work; candidate: a debrief task that proposes the changes for approval. (H) SECRET HYGIENE: a grep of agent-manager.env printed the dashboard token into a session transcript; candidate: a redacting read wrapper. (I) PRIOR-ART SCOUTING: gh/web search, vet by stars/recency/size (<150 MB), add a row + notes subsection to UsefulProjectIndex/INDEX.md; candidate: a scout step attached to every design task. Count these in the catalogue's table with the evidence you can find (git, task records, memory notes) and mark each confirmed or unconfirmed.";
src/adhoc-diff-sanity.test.js:866:  for (const s of ['Read the real history of the task sources in src/task-sources.js.', 'Ground it in the current code: the five mechanisms in src/task-sources.js.', 'Check the retry handling in src/a.js and report what you find.']) {
src/adhoc-diff-sanity.test.js:1074:  const t = adhoc('Implement the new task source in src/task-sources.js to support the GitHub integration.');
src/adhoc-diff-sanity.test.js:1154:  const raw = 'Implement the new task source in src/task-sources.js to support the GitHub integration.';
src/adhoc-diff-sanity.test.js:1165:  const raw = 'Implement the new task source in src/task-sources.js to support the GitHub integration.';
src/registry-variants.js:13:  require('./task-sources.js');
src/get-grounding-source.js:20:require('./task-sources.js');
src/drift-scan.js:5:// in index.html, commented as mirroring src/task-sources.js's registerTaskSource calls)
src/drift-scan.js:77:    sourceCommand: ['src/task-sources.js', '--dump-topology'],
src/expiry-sweep.js:143:  require('./task-sources.js');
src/grep-codebase-tool.js:171:    // "src/task-sources.js" for a model that passed a file as `dir` (it starts with an
src/decompose-question-surface.js:9:// (no ./config.js, no ./task-sources.js). The pipeline dir is resolved the same
src/grounding-recheck-sweep.js:51:require('./task-sources.js');
src/local-tool-client.js:548:          dir: { type: 'string', description: 'Where to search: one of the primary repo\'s searchable dirs (see the error message if unsure), a subpath of one (e.g. "python/dashboard"), a single file path (e.g. "src/task-sources.js" -- searched directly, any extension), or "." / omitted to search all of them. For another "root", any subdirectory, file, or "." for the whole repo.' },
src/local-tool-client.js:564:          path: { type: 'string', description: 'File path relative to the primary repo root (e.g. "src/task-sources.js") or an absolute path inside another accessible repo.' },
src/apply-task.test.js:51:// so requiring ./apply-task.js (which requires ./task-sources.js) no longer registers them.
src/pipeline-forensics.test.js:153:  for (const m of ['./task-sources.js', './prompts.js', './forensic-bundle.js', './pipeline-forensics.js']) {
src/pipeline-forensics.test.js:158:  const ts = require('./task-sources.js');
src/candidate-path-grounding.test.js:22:    'Files: src/task-sources.js, src/config.js',
src/candidate-path-grounding.test.js:27:  assert.equal(extractFilesLine(wu), 'src/task-sources.js, src/config.js');
src/task-sources-noop-release.test.js:6:const { isDependencySatisfied, isEmptyImplementedNoop } = require('./task-sources.js');
src/manual-close.test.js:75:  const { isDependencySatisfied } = require('./task-sources.js');
src/manual-close.test.js:89:  const { isDependencySatisfied } = require('./task-sources.js');
src/hygiene-inventory.js:287:  const depCheck = isDependencySatisfied || ((id) => require('./task-sources.js').isDependencySatisfied(pipelineDir, id));
src/hygiene-inventory.js:360:  require('./task-sources.js');
src/io-avoidance-prompts.test.js:10:require('./task-sources.js');
src/system-report.test.js:15:require('./task-sources.js');
src/arch-discovery-structcheck.test.js:96:const REAL_COMMUNITY_2_RESPONSE = "### AC-1 Unified Source Registry Eliminates Divergent State Between Library and CLI Modules\n\n**Strength:** Moderate (requires verification)\n\n**Files:** `src/task-sources.js`, `src/prompts.js`\n\n**Problem Statement:**\nThe source registration state is duplicated across two independent modules without coordination. However, this claim cannot be verified from the provided inputs alone.\n\n**Solution:**\nConsolidate both registries into a single canonical source of truth.\n\n**Benefits:**\nAny future changes to source definitions happen in one place.\n\n---\n\n### CRITIQUE (flagged problems)\n\nI cannot verify this draft against the provided inputs because:\n\n1. **`src/prompts.js` content is not shown** -- I have no visibility into how `prompts.js` actually registers sources.\n\nGiven these gaps, I cannot confirm whether AC-1 actually solves a real problem or introduces new ones.";
src/script-handler-dependency.test.js:14:const { isDependencySatisfied } = require('./task-sources.js');
src/task-sources.test.js:6:// Run: node --test src/task-sources.test.js  (or `npm test`)
src/task-sources.test.js:30:  delete require.cache[require.resolve('./task-sources.js')];
src/task-sources.test.js:32:  return require('./task-sources.js');
src/task-sources.test.js:439:// use the real resulting value ("agent-manager", since src/task-sources.js always lives
src/registry-variants.test.js:59:  assert.equal(graph.all['src/capability-ledger.js'].includes('src/task-sources.js'), false);
src/fix-signature-sweep.test.js:485:const IR_RAW_TEXT = "WHY (owner 2026-10-15: \"the system is our greatest asset and needs to be capable of swiftly, easily and gracefully handling these kinds of tasks\"). Evidence from 2026-10-15, live: (a) a read-only 'verify the map against three repos' task finished orient (2.5 min) and plan (2.2 min), spent ~5 min in the agentic implement pass, answered RESOLUTION: decompose with NO valid JSON array, was blocked (src/agentic-draft-common.js:494), sat 17 min, was requeued to repeat the same stages -- a retry loop that cannot succeed. (b) A one-line bug (brain-dump capture: max() over string serials, python/dashboard/routes/brain_dump.py:132) was approved and decomposed into SEVEN sub-tasks (HUB0148). (c) Owner builds goals made of pieces across several repos by hand, and the pipeline serves one project at a time. This task is one of three from the 'systematic fix' (shape-aware intake, decompose repair, an Initiative record). SCOPE RULE: this is ONE task, do not decompose it; do the smallest first PR described. TASK: write ONE file, Docs/initiative-record-design.md, and change nothing else. Design an 'Initiative' record: a goal made of pieces, each piece a task, with the dependencies between them, the repo each piece belongs to, a status derived from the pieces, and a hook that files the NEXT piece automatically when its dependency merges, so follow-through is a property of the system and not of a person. Ground it in the current code with path:line (confirmed vs unconfirmed): the five existing cross-reference mechanisms (see the Task Linking concept: hub parent/child, dependsOn, brainDumpEntryId, raisedFrom, derived-task links), nextAdhocTask()/isDependencySatisfied() in src/task-sources.js (dependsOn is satisfied only once the dependency is MERGED), hubs and coordinating/ (queue/coordinating), the hub-priority and premiumPriority ordering in src/next-claimable-task.js, and queue-adhoc-task.js. The doc must contain: the record shape (JSON example); how it differs from a hub (hubs are decompositions of ONE task; an initiative spans tasks, projects and time); which existing mechanism it should reuse so it does not become a sixth; how a piece names its target repo (the pipeline works one active project at a time today -- say what this requires of the scheduler, referencing the project-rotation findings if Docs/project-rotation-and-expiry-aging-findings.md exists); the dashboard view (one row per initiative: pieces done/in-flight/blocked, next piece, age by attention); how premium priority is inherited by pieces; failure modes and the smallest first PR (an initiative file plus a read-only dashboard list, no auto-filing yet); and an open-decisions list with a recommended default for each. Worked example: the GPU broker extraction (Docs/gpu-broker-extraction-map.md pieces G0-G7) expressed as an initiative.";
src/fix-signature-sweep.test.js:488:const TL_RAW_TEXT = "WHY (owner 2026-10-15): the owner has had Claude do system management and streamlining of Agent Manager by hand across many sessions and wants that fine-tuning broken into a set of repeatable tasks that run passively through the pipeline. A first, memory-and-skim pass (NOT evidence-backed) found nine recurring loops: (1) stalled-bucket drain (blocked / needs-clarification: find the one shared cause, fix it, release the bucket), (2) incident -> root cause -> sweep siblings (the Incident Amplification concept, never built), (3) unmerged-branch review (read the whole hub, verdict merge / needs-work / discard; docs/agents/unmerged-branch-review.md), (4) scanner precision tuning (measure false positives, cut them, confidence tiers, 'dismissed'), (5) policy-change follow-up (after a change, read a week of data, tighten, flip env switches; nothing currently remembers to do it), (6) triage candidate sifts (100-200 candidates into keep / drop / hold), (7) code-health and history analysis (a daily health ledger was proposed, not built), (8) brain-dump / memory / docs hygiene, (9) environment drift (env switches, lanes, P40, plugin env vs the intended state). The first pass saw 2,799 commits on origin/master since 2026-08-01, ~220 of them 'Triage batch' commits and several hundred fixes. SCOPE RULE: this is ONE task, write the single file named below, change nothing else, do not decompose. TASK: write ONE file, Docs/tuning-loops-catalogue.md. Read the real history, not the nine-item guess: git log of origin/master since 2026-08-01 (group commits and PR titles by theme; count them), queue/done and queue/done/_archived* task records and their history stages (which sources and job types recur, which tasks were retried, blocked or requeued and why), brain-dump.json entries (group by theme; note which were machine-raised vs session-raised), the memory notes under /home/wok/.claude/projects/-home-wok/memory/ whose name starts project-agent-manager-* (they record what each hand-run session found; read the index file MEMORY.md first), and docs/agents/, Docs/ and the existing task sources in src/task-sources.js and /media/model-cache/github/agent-manager-hygiene/src. Produce: (a) a table of the recurring loops actually found (correct, merge, split or drop the nine above with evidence), each with: how many times it ran (count and dates), what triggered it, the evidence a human or Claude looked at, the decision made, the artefact produced (PR, task, doc, env change), and whether any of it is ALREADY automated (name the source/sweep and path:line, or say none); (b) for each loop, a verdict: automate fully / automate evidence-gathering and keep a human gate / keep manual, with the reason; (c) the five most valuable gaps ranked by (frequency x cost of forgetting), with the evidence; (d) every claim marked confirmed (with path or commit) or unconfirmed. Do not run any live pipeline command, sweep, or task-sources.js. If a data source cannot be read, say so and continue with the rest. Keep under 300 lines.\n\nADDITIONAL EVIDENCE FROM A HAND-RUN SESSION (2026-10-14/15, Claude session 015TvzBxsPvNeXXdPbh273DP; session-raised, not yet checked against the repo history -- verify or correct each in the catalogue, and include them as loops or as members of the nine above): (A) LAND-AND-DEPLOY after every merge: fast-forward the live checkout, restart the plugin via kill pid + remove ~/.local/state/agent-manager/pids/plugin-<name>.pid + POST /api/plugins/<name>/ensure-started, confirm the running process serves the merged commit (done ~10 times that day for promptforge, storyforge, sceneforge, the dashboard); candidate loop: deploy-drift sweep. (B) PRE-FLIGHT before a pipeline start or project switch: an uncommitted edit in the target repo's checkout (e.g. storyforge stories/enough.json) is at risk because apply self-heal rescues/resets dirt (see the rescue branch agent/rescued-master-20261014193855 and PR #467 / #474); candidate: a start guard. (C) STATE CHECKS done by hand: P40 VM up (virsh), workers per lane, plugin pids and zombie pidfiles, host RAM vs the mem-guard 2048 MB threshold, whether the live PromptForge has CHARACTERFORGE_ROOT, which commit is live; candidate: the environment-drift loop. (D) STATUS DIGESTS: 'what is the queue doing' answered by reading queue/ directories, task histories and worker logs; candidate: a generated, phone-readable digest. (E) CONTACT SHEETS: building a labelled image sheet after a render job so a human can review it; candidate: automatic sheet per render job. (F) FILING FINDINGS: turning an incident into a well-formed brain dump or premium task with evidence and a 'do not decompose' scope rule; candidate: a file-this-finding helper. (G) MEMORY UPKEEP: writing/updating memory notes and the index after each stretch of work; candidate: a debrief task that proposes the changes for approval. (H) SECRET HYGIENE: a grep of agent-manager.env printed the dashboard token into a session transcript; candidate: a redacting read wrapper. (I) PRIOR-ART SCOUTING: gh/web search, vet by stars/recency/size (<150 MB), add a row + notes subsection to UsefulProjectIndex/INDEX.md; candidate: a scout step attached to every design task. Count these in the catalogue's table with the evidence you can find (git, task records, memory notes) and mark each confirmed or unconfirmed.";
src/review-task.js:170:// (source.reviewGuidance / source.reviewCompletenessQuestion, set in src/task-sources.js
src/drift-scan.test.js:4:// files in a temp dir -- never against this repo's real index.html/task-sources.js, so
src/pipeline-health-audit-sweep.test.js:61:  delete require.cache[require.resolve('./task-sources.js')];
src/empty-approval-decision.js:130:  require('./task-sources.js');
src/pipeline-health-audit-sweep.js:31:const { nextPipelineHealthAuditTask, writeTask } = require('./task-sources.js');
src/task-anchor-files.test.js:31:  const dir = makeRepo({ 'src/task-sources.js': 'registerTaskSource("brain_dump_sort", {})\n' });
src/task-anchor-files.test.js:32:  const files = taskAnchorFiles(adhoc('Add a new task source to src/task-sources.js at priority 41.'), dir);
src/task-anchor-files.test.js:33:  assert.deepEqual(files.map((f) => f.path), ['src/task-sources.js']);
src/reject-retry-check.js:75:require('./task-sources.js');
src/plugin-api.test.js:20:  './task-sources.js': { functions: ['nextCandidateFulfillmentTask', 'taskIdExistsInQueue', 'taskPriority', 'windowFetchedFileContent'] },
src/plugin-api.test.js:53:// prompts.js/task-sources.js require AGENT_MANAGER_REPO_ROOT at load (getConfig()).
src/plugin-api.test.js:137:  assert.equal(require('./task-sources.js').taskPriority, require('./lib/task-priority.js').taskPriority);
src/script-references.test.js:4:// callers ran it BY PATH -- scripts/queue-watcher.sh (the daily graph rebuild) and src/task-sources.js (deep_dive onboarding) -- and
src/sdk/lib/candidate-lifecycle.js:82:  const { taskIdExistsInQueue, isDependencySatisfied } = require('../../task-sources.js');
src/sdk/candidate-fulfillment.test.js:7:// entirely. See src/task-sources.test.js's much larger pre-existing windowFetchedFileContent
src/brain-dump-resolution-check.js:102:// Next function (registry signature: NO arguments, ONE task or null), modelled on nextBrainDumpSortTask in src/task-sources.js.
src/review-content-overlap.test.js:21:require('./task-sources.js');
src/task-complexity-score.js:11:// INSTANCES, whereas src/task-sources.js assigns a STATIC reasoningTier per task
```
### grep -rn "apply-core" src/
```
src/local-draft.js:92:const { usesGroupB } = require('./lib/apply-core.js');
src/local-draft.js:1309:    // (apply-core.js writeArtifact) queues the pieces. The doc-split's re-split loop cannot recur: children are adhoc tasks that
src/apply-adhoc-diff.js:309:// primitive until S5. lib/apply-core.js's writeArtifact now dispatches through
src/apply-task.js:36:const { coAuthorTrailer, usesGroupB, applyCandidateSplit, writeArtifact, closeOriginatingBrainDumpEntry, assertStageableFiles } = require('./lib/apply-core.js');
src/local-draft.test.js:2144:      const { writeArtifact } = require('./lib/apply-core.js');
src/lib/apply-main-batch.js:13:const { coAuthorTrailer, usesGroupB, applyCandidateSplit, writeArtifact, closeOriginatingBrainDumpEntry, assertStageableFiles } = require('./apply-core.js');
src/lib/apply-core.test.js:3:// Unit tests for assertStageableFiles (src/lib/apply-core.js) -- the pathspec guard added
src/lib/apply-core.test.js:12:// Run: node --test src/lib/apply-core.test.js  (or `npm test`)
src/lib/apply-core.test.js:16:const { assertStageableFiles } = require('./apply-core.js');
src/lib/implement-critique.js:14:const { usesGroupB } = require('./apply-core.js');
src/lib/apply-core.js:3:// apply-core.js -- extracted from src/apply-task.js ([[hub-task-integration]] node-module decompose).
src/review-prevote-checks.js:21:    const { usesGroupB } = require('./lib/apply-core.js');
src/apply-task.test.js:324:// --- assertStageableFiles guard (src/lib/apply-core.js): a registered source whose
src/candidate-split-hub-route.js:4:// (S4b of the hub-tasks extraction, producer 4, 2026-09-25). lib/apply-core.js's
src/candidate-split-hub-route.js:19:// (see lib/apply-core.js) instead of silently doing nothing or resurrecting the old inline
```

## 3. Side effects of loading src/task-sources.js
- Top-level registerTaskSource(...) calls run at module load (see the header comment and the registration calls) and write into src/task-source-registry.js.
- src/task-sources.js does not require src/lib/apply-core.js: grep for apply-core inside it returns nothing.

## 4. Cycles
- src/lib/apply-core.js:9 requires ../task-sources.js. task-sources.js does not require apply-core, so there is no direct cycle.
- Transitive requires of apply-group-a.js, apply-group-b.js and candidate-split-hub-route.js were NOT traced. Unverified.

## 5. Load-order table
| file | task-sources require | apply-core require | order | uses bound export |
|---|---|---|---|---|
| src/apply-task.js | src/apply-task.js:35 | src/apply-task.js:36 | ok | no |
| src/lib/apply-core.js | src/lib/apply-core.js:9 | (self) | ok | no |

Other importers in the grep output (e.g. src/lib/apply-main-batch.js:11) were not row-checked for apply-core use.

## 6. Verdict
VERDICT: REDUNDANT

Caveat: this verdict covers the direct require edges above only. src/apply-task.js:35 supplies only a side effect that src/lib/apply-core.js:9 also supplies. If HUB0664 2/2 removes apply-core.js:9, apply-task.js:35 becomes the sole loader on that path and the verdict must be re-audited.

## 7. Assumptions
- assuming src/apply-task.js line 36 is the apply-core require -- verify
- assuming no transitive path reaches apply-core without loading task-sources -- verify
