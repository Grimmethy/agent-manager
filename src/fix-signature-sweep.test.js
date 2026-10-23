'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepKnownFixedFailures, stuckSince, STATE_FILE } = require('./fix-signature-sweep.js');
const { KNOWN_FIXED } = require('./known-fixed-failures.js');

const byId = Object.fromEntries(KNOWN_FIXED.map((e) => [e.id, e]));
const WRONG_BLOCK = 'Your previous "find" string for src/components/PropertyDetailPanel.tsx matches the file -- but a DIFFERENT block than the one this candidate flagged. The flagged code is: ...';
const FIND_MISSING = 'Your previous attempt proposed this "find" string for src/components/PropertyDetailPanel.tsx, but it does not appear verbatim anywhere in that file\'s real content given above:\n\nfoo\n\nLook again at the R';
const META = 'Deterministic gate: implementResponse is a bare tool-call request or meta-commentary, not a real implementation attempt -- no local-model review call spent';
const CURLY = { path: 'src/P.tsx', content: 'Mark it as “Owner” — soon' };
const PLAIN = { path: 'src/P.tsx', content: 'Mark it as "Owner" - soon' };

function pipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixsig-'));
  for (const s of ['blocked', 'needs-clarification', 'pending', 'adhoc', 'derived']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
}
const put = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const read = (dir, state, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', state, `${id}.json`), 'utf8'));
const has = (dir, state, id) => fs.existsSync(path.join(dir, 'queue', state, `${id}.json`));
const at = (iso) => ({ stage: 'blocked', at: iso, detail: 'x' });
const stuck = (id, over = {}) => ({
  id, domain: 'default', source: 'function_length_fix', title: 'AC-3', status: 'pending', createdAt: '2026-09-20T01:00:00Z',
  promptContext: { candidateId: 'AC-3', fetchedFiles: [CURLY] }, priorRejectionFeedback: [WRONG_BLOCK], history: [at('2026-09-20T05:00:00Z')], ...over,
});
const NOW = new Date('2026-09-20T07:00:00Z');

test('each entry matches exactly its own failure class', () => {
  assert.equal(byId['wrong-block-whole-function-snippet'].applies(stuck('a')), true);
  assert.equal(byId['wrong-block-whole-function-snippet'].applies(stuck('a', { priorRejectionFeedback: [FIND_MISSING] })), false);
  assert.equal(byId['typographic-find-mismatch'].applies(stuck('b', { priorRejectionFeedback: [FIND_MISSING] })), true);
  assert.equal(byId['typographic-find-mismatch'].applies(stuck('b', { priorRejectionFeedback: [FIND_MISSING], promptContext: { fetchedFiles: [PLAIN] } })), false, 'the file has no typographic characters: a real mismatch, not the fixed class');
  assert.equal(byId['revision-commentary-replaced-draft'].applies(stuck('c', { priorRejectionFeedback: [META] })), true);
  assert.equal(byId['revision-commentary-replaced-draft'].applies(stuck('c', { priorRejectionFeedback: [], blockedReason: 'The "IMPLEMENT draft" section consists entirely of meta-commentary analyzing a prior critique' })), true);
  assert.equal(byId['revision-commentary-replaced-draft'].applies(stuck('c', { priorRejectionFeedback: ['some unrelated rejection'] })), false);
});

test('first sight of an entry: a task that failed BEFORE it is requeued to pending/ with its coordination fields kept and a history event', () => {
  const dir = pipeline();
  put(dir, 'needs-clarification', stuck('function-length-fix-ac-3', {
    needsClarification: { reason: 'design-decision' }, history: [at('2026-09-20T05:00:00Z'), { stage: 'exhausted', at: '2026-09-20T05:39:46Z' }],
    stacked: { branch: 'agent/x', seq: 2, total: 3 }, dependsOn: ['p1'], atomic: true, premiumPriority: true, planResponse: 'stale', implementResponse: 'stale', blockedReason: 'stale',
  }));
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW });
  assert.deepEqual(s.requeued, [{ id: 'function-length-fix-ac-3', entry: 'wrong-block-whole-function-snippet', from: 'needs-clarification' }]);
  assert.equal(has(dir, 'needs-clarification', 'function-length-fix-ac-3'), false);
  const fresh = read(dir, 'pending', 'function-length-fix-ac-3');
  assert.equal(fresh.status, 'pending');
  assert.deepEqual(fresh.stacked, { branch: 'agent/x', seq: 2, total: 3 });
  assert.deepEqual(fresh.dependsOn, ['p1']);
  assert.equal(fresh.atomic, true);
  assert.equal(fresh.premiumPriority, true);
  assert.equal(fresh.planResponse, undefined, 'drafting artifacts are dropped');
  assert.equal(fresh.blockedReason, undefined);
  assert.equal(fresh.needsClarification, undefined);
  assert.deepEqual(fresh.requeuedForFixes, ['wrong-block-whole-function-snippet']);
  assert.equal(fresh.history.at(-1).stage, 'requeued');
  assert.match(fresh.history.at(-1).detail, /fix for "wrong-block-whole-function-snippet" landed \(agent-manager #394\)/);
  assert.ok(fresh.history.some((h) => h.stage === 'exhausted'), 'the log is appended to, never replaced');
});

test('a task that failed AFTER the sweep first saw the entry is NOT requeued (the fix did not cure it), and a requeued task is never requeued twice', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('early', { history: [at('2026-09-20T05:00:00Z')] }));
  assert.equal(sweepKnownFixedFailures({ pipelineDir: dir, now: NOW }).requeued.length, 1, 'first run stamps firstSeen = NOW and drains the earlier failure');
  put(dir, 'blocked', stuck('late', { history: [at('2026-09-20T09:00:00Z')] }));    // failed at 09:00, after firstSeen 07:00
  const later = sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-09-20T10:00:00Z') });
  assert.deepEqual(later.requeued, []);
  assert.equal(has(dir, 'blocked', 'late'), true);
  // and one that was already requeued for this fix and failed again before firstSeen is still skipped
  put(dir, 'blocked', stuck('again', { history: [at('2026-09-20T05:00:00Z')], requeuedForFixes: ['wrong-block-whole-function-snippet'] }));
  assert.deepEqual(sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-09-20T11:00:00Z') }).requeued, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue', STATE_FILE), 'utf8')).firstSeen['wrong-block-whole-function-snippet'], NOW.toISOString());
});

test('adhoc-shaped tasks go back to the lane that claims them; derived tasks to derived/', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('adhoc-x', { domain: 'adhoc', source: 'manual' }));
  put(dir, 'blocked', stuck('derived-x', { domain: 'adhoc', source: 'derived_task' }));
  put(dir, 'blocked', stuck('plain-x'));
  sweepKnownFixedFailures({ pipelineDir: dir, now: NOW });
  assert.equal(has(dir, 'adhoc', 'adhoc-x'), true);
  assert.equal(has(dir, 'derived', 'derived-x'), true);
  assert.equal(has(dir, 'pending', 'plain-x'), true);
});

test('never requeued: an applied task (real branch), a genuine design question, a reviewInconclusive flake, a non-matching task, or one with a pending copy', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('applied-one', { history: [at('2026-09-20T05:00:00Z'), { stage: 'applied', at: '2026-09-20T04:00:00Z', detail: 'agent/x' }] }));
  put(dir, 'needs-clarification', stuck('real-question', { needsClarification: { reason: 'design-decision' }, history: [at('2026-09-20T05:00:00Z')] })); // no 'exhausted'
  put(dir, 'blocked', stuck('flake', { reviewInconclusive: true }));
  put(dir, 'blocked', stuck('unrelated', { priorRejectionFeedback: ['something else entirely'] }));
  put(dir, 'blocked', stuck('dupe'));
  put(dir, 'pending', { id: 'dupe', status: 'pending' });
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW });
  assert.deepEqual(s.requeued, []);
  for (const id of ['applied-one', 'flake', 'unrelated', 'dupe']) assert.equal(has(dir, 'blocked', id), true, id);
  assert.equal(has(dir, 'needs-clarification', 'real-question'), true);
});

test('dry run and the kill switch move nothing', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('t'));
  const dry = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, dryRun: true });
  assert.equal(dry.requeued.length, 1);
  assert.equal(has(dir, 'blocked', 't'), true);
  assert.equal(fs.existsSync(path.join(dir, 'queue', STATE_FILE)), false, 'a dry run does not even record firstSeen');
  process.env.AGENT_MANAGER_FIX_SIGNATURE_SWEEP = 'false';
  try {
    assert.deepEqual(sweepKnownFixedFailures({ pipelineDir: dir, now: NOW }).requeued, []);
  } finally { delete process.env.AGENT_MANAGER_FIX_SIGNATURE_SWEEP; }
  assert.equal(has(dir, 'blocked', 't'), true);
});

test('stuckSince uses the newest blocked/needs-clarification/exhausted event, else the file mtime', () => {
  const dir = pipeline();
  assert.equal(stuckSince({ history: [at('2026-09-20T05:00:00Z'), { stage: 'exhausted', at: '2026-09-20T06:00:00Z' }, { stage: 'draft-started', at: '2026-09-20T09:00:00Z' }] }, '/nope'), Date.parse('2026-09-20T06:00:00Z'));
  const f = path.join(dir, 'queue', 'blocked', 'x.json'); fs.writeFileSync(f, '{}');
  assert.ok(Math.abs(stuckSince({ history: [] }, f) - Date.now()) < 60000);
});

// --- draft-sandbox-stdout-line (2026-09-20) -----------------------------------------------------------------------------------------------
// A [draft-sandbox] log line on stdout made every successful PF draft read as "draft call failed"; 7 retries later the task was escalated to
// needs-clarification with nc.reason 'design-decision' -- but it HAD been exhausted, so it is a drafting failure, not a real design question.
const SANDBOX_FAIL = 'draft call failed 7 times in a row (most recent: [draft-sandbox] copied node_modules into agent-manager-adhoc-worktree-x (196 MB, 3253 ms) {"succeeded":true,"blocked":false})';
const OLLAMA_FAIL = 'draft call failed 7 times in a row (most recent: {"succeeded":false,"reason":"connect ECONNREFUSED 192.168.122.29:11434"})';
const exhaustedNc = (id, blockedReason) => stuck(id, {
  domain: 'adhoc', source: 'derived_task', priorRejectionFeedback: [], blockedReason,
  needsClarification: { reason: 'design-decision' },
  history: [{ stage: 'exhausted', at: '2026-09-20T05:00:00Z', detail: '2/2' }, { stage: 'needs-clarification', at: '2026-09-20T05:00:01Z', detail: 'escalated' }],
});

test('draft-sandbox-stdout-line matches the sandbox-polluted failure and NOT a genuine draft failure', () => {
  const e = byId['draft-sandbox-stdout-line'];
  assert.equal(e.applies(exhaustedNc('a', SANDBOX_FAIL)), true);
  assert.equal(e.applies(exhaustedNc('b', OLLAMA_FAIL)), false, 'a real Ollama outage is not this bug');
  assert.equal(e.applies(exhaustedNc('c', 'draft call failed 3 times in a row (most recent: nothing to do)')), false);
  assert.equal(e.applies(exhaustedNc('d', '[draft-sandbox] copied node_modules (196 MB)')), false, 'the sandbox line alone (no failed-draft text) is not enough');
});

test('draft-sandbox-stdout-line drains a retry-exhausted needs-clarification task back to derived/, keeping a real design question in place', () => {
  const dir = pipeline();
  put(dir, 'needs-clarification', exhaustedNc('victim', SANDBOX_FAIL));
  put(dir, 'needs-clarification', { ...exhaustedNc('real-question', SANDBOX_FAIL), history: [at('2026-09-20T05:00:00Z')] }); // never exhausted: a human's call
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, entries: [byId['draft-sandbox-stdout-line']] });
  assert.deepEqual(s.requeued.map((r) => r.id), ['victim']);
  assert.equal(has(dir, 'derived', 'victim'), true);
  assert.deepEqual(read(dir, 'derived', 'victim').requeuedForFixes, ['draft-sandbox-stdout-line']);
  assert.equal(has(dir, 'needs-clarification', 'real-question'), true);
});

test('a stale origin copy in derived/ does not block draining a derived task; a same-name file in pending/ still does', () => {
  const dir = pipeline();
  put(dir, 'needs-clarification', exhaustedNc('victim', SANDBOX_FAIL));
  put(dir, 'derived', { id: 'victim', source: 'derived_task', history: [{ stage: 'created', at: '2026-09-19T00:00:00Z' }] }); // the leftover origin record
  put(dir, 'needs-clarification', { ...exhaustedNc('has-pending', SANDBOX_FAIL), domain: 'default', source: 'trouble_log' }); // a normal task: its destination is pending/
  put(dir, 'pending', { id: 'has-pending', status: 'pending' });
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, entries: [byId['draft-sandbox-stdout-line']] });
  assert.deepEqual(s.requeued.map((r) => r.id), ['victim']);
  const fresh = read(dir, 'derived', 'victim');
  assert.ok(fresh.history.some((h) => h.stage === 'exhausted'), 'the stale copy was replaced by the fuller stuck record (its history is kept)');
  assert.equal(has(dir, 'needs-clarification', 'victim'), false);
  assert.equal(has(dir, 'needs-clarification', 'has-pending'), true, 'a real pending copy still blocks');
});

// --- implement-degenerate-invisible-block (2026-09-21) -----------------------------------------------------------------------------------------------------------
test('implement-degenerate-invisible-block matches a blocked task with the degenerate reason and NO blockedStage, not one that already has a stage or another reason', () => {
  const e = byId['implement-degenerate-invisible-block'];
  const t = (over) => stuck('x', { domain: 'default', source: 'function_length_fix', status: 'pending', blockedReason: 'Implement pass degenerate: empty', ...over });
  assert.equal(e.applies(t({})), true);
  assert.equal(e.applies(t({ blockedStage: 'implement' })), false, 'the sweep already handles a stamped block');
  assert.equal(e.applies(t({ blockedReason: 'Plan pass degenerate: empty' })), false);
  assert.equal(e.applies(t({ blockedReason: 'draft call failed 3 times' })), false);
});

test('implement-degenerate-invisible-block drains the stuck task back to pending/', () => {
  const dir = pipeline();
  put(dir, 'blocked', stuck('victim', { domain: 'default', source: 'function_length_fix', status: 'pending', blockedReason: 'Implement pass degenerate: empty', history: [{ stage: 'blocked', at: '2026-09-20T05:00:00Z' }] }));
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, entries: [byId['implement-degenerate-invisible-block']] });
  assert.deepEqual(s.requeued.map((r) => r.id), ['victim']);
  assert.equal(has(dir, 'pending', 'victim'), true);
});

// --- docs-only-gate-negated-paths (2026-09-21) ---------------------------------------------------------------------------------------------
// A correct docs-only diff was blocked "the task asks for a code change" because the task text named code paths only to say they are NOT to be edited.
const DOCS_ONLY_FAIL = 'Your diff only created/edited documentation (AGENTS.md). That is not the deliverable -- the task asks for a real code change. Implement the actual change in the file(s) the plan/task names.';
const docsTask = (id, rawText) => stuck(id, {
  domain: 'adhoc', source: 'manual', promptContext: { rawText }, planResponse: '',
  needsClarification: { reason: 'design-decision', openQuestions: DOCS_ONLY_FAIL },
  history: [{ stage: 'exhausted', at: '2026-09-20T05:00:00Z', detail: '3/3' }, { stage: 'needs-clarification', at: '2026-09-20T05:00:01Z', detail: 'escalated' }],
});

test('docs-only-gate-negated-paths matches a documentation task whose text only mentions code paths, NOT a task that really asks for code', () => {
  const e = byId['docs-only-gate-negated-paths'];
  assert.equal(e.applies(docsTask('doc', 'Append a new section to AGENTS.md. Do NOT modify any file under src/. The two scripts (scripts/check.sh, src/x.js) are named inside the note only, not files to edit.')), true);
  assert.equal(e.applies(docsTask('code', 'Append a note to AGENTS.md and change the timeout in src/foo.js.')), false, 'a task that really asks for a code change stays put');
  assert.equal(e.applies(stuck('other', { domain: 'adhoc', source: 'manual', promptContext: { rawText: 'Append to AGENTS.md.' }, needsClarification: { reason: 'design-decision', openQuestions: 'The draft cites a file that does not exist.' } })), false, 'a different failure');
});

test('docs-only-gate-negated-paths drains the retry-exhausted documentation task and leaves the real-code one', () => {
  const dir = pipeline();
  put(dir, 'needs-clarification', docsTask('doc', 'Append a new section to AGENTS.md. Do NOT modify any file under src/.'));
  put(dir, 'needs-clarification', docsTask('code', 'Append a note to AGENTS.md and change the timeout in src/foo.js.'));
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, entries: [byId['docs-only-gate-negated-paths']] });
  assert.deepEqual(s.requeued.map((r) => r.id), ['doc']);
  assert.equal(has(dir, 'adhoc', 'doc'), true);
  assert.equal(has(dir, 'needs-clarification', 'code'), true);
});

test('docs-only-gate-negated-paths also drains the two real GPU broker verification tasks (read-only documentation deliverable) and leaves a real code task', () => {
  const dir = pipeline();
  const PF = "Context: Docs/gpu-broker-extraction-map.md (merged, PR #561) maps pulling the Forge/pipeline GPU lease out of PromptForge into a standalone gpu-broker plugin (docs/agents/repo-extraction-playbook.md). Owner rule 2026-10-13: the pipeline's Ollama model and the Forge family never hold the GPU together. Premium, owner request 2026-10-15; this is one of three small read-only verification tasks replacing a single task that was too big. PromptForge: verify the map against /media/model-cache/github/promptforge-manual (server/core/gpu_session.py, comfy.py, comfy_proc.py, server/app.py routes /api/gpu/*, Docs/GPU_FAMILY_PROTOCOL.md, tests/test_gpu_session.py). Questions: where is the 120 s ComfyUI wait and how does an automatic job session call begin; which functions in gpu_session.py are broker logic vs PromptForge-specific; which tests would move with G1; per-device awareness (is anything GPU-index specific). RULES: read-only on the code; write ONLY the one findings file named below (a NEW file, nothing else changed). For every row/claim of the map that touches your area, state CONFIRMED / WRONG / UNCONFIRMED with path:line evidence, quote the corrected text for anything WRONG, and answer the section-5 open questions that fall in your area. Keep it under 120 lines. FILE TO WRITE: Docs/gpu-broker-verification-promptforge.md (in the agent-manager repo).";
  const CORE = "Create the NEW file Docs/gpu-broker-verification-core.md (\u2264120 lines, nothing else touched) verifying Docs/gpu-broker-extraction-map.md section 1/5 against core code. Use this evidence: launch.sh:31-42 lease-delete+yield CONFIRMED; comfyui_lease_held agent-manager-common.sh:98, local-worker.sh:525, review-runner.sh:91 CONFIRMED; gpu-guard.js 54/77/101 CONFIRMED; local-client.js:266 (map says 264 \u2014 quote corrected); stop route pipeline_1_more.py:68 \u2192 app.py _stop_pipeline \u2192 stop.sh --keep-dashboard --keep-plugins, stop.sh:125 skips plugin-*.pid, so G5's 'stop kills plugins today' is WRONG/stale (fixed 2026-10-14, see test_stop_pipeline_keeps_plugins.py); /free reclaim gpu-guard.js:214-217 self-contained, no broker needed; .model-locks writer model-inflight-lock.js:37 + reader chat_preempt.py:164-168,265,394; /api/gpu callers only launch.sh:42, gpu-guard.js:105; pause/resume needs drain status endpoint (.model-locks/gpu-arbiter) + Ollama eviction (KEEP_ALIVE 30m) + resume via app.py:2760. Re-verify each line number with grep before writing, tag every row CONFIRMED/WRONG/UNCONFIRMED with path:line, answer the four section-5 questions, then run `wc -l` (\u2264120) and `git status` (only this new file).";
  put(dir, 'needs-clarification', docsTask('verify-pf', PF));
  put(dir, 'needs-clarification', docsTask('verify-core', CORE));
  put(dir, 'needs-clarification', docsTask('code', 'Create docs/x.md and change the timeout in src/foo.js.'));
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, entries: [byId['docs-only-gate-negated-paths']] });
  assert.deepEqual(s.requeued.map((r) => r.id).sort(), ['verify-core', 'verify-pf']);
  assert.equal(has(dir, 'needs-clarification', 'code'), true);
});

// --- docs-only-gate-read-only-deliverable (2026-10-16) ---------------------------------------------------------------------------------------
// The sweep is once-per-entry: it stamps firstSeen[id] and skips tasks stuck AFTER it. The 2026-09-21 entry was first seen 2026-09-22, so the tasks the 2026-10-15 gate fix unblocks could only
// be drained by an entry with a new id. The two texts are the real GPU broker verification task texts, verbatim from the stuck records.
const READONLY_PF_TEXT = "Context: Docs/gpu-broker-extraction-map.md (merged, PR #561) maps pulling the Forge/pipeline GPU lease out of PromptForge into a standalone gpu-broker plugin (docs/agents/repo-extraction-playbook.md). Owner rule 2026-10-13: the pipeline's Ollama model and the Forge family never hold the GPU together. Premium, owner request 2026-10-15; this is one of three small read-only verification tasks replacing a single task that was too big. PromptForge: verify the map against /media/model-cache/github/promptforge-manual (server/core/gpu_session.py, comfy.py, comfy_proc.py, server/app.py routes /api/gpu/*, Docs/GPU_FAMILY_PROTOCOL.md, tests/test_gpu_session.py). Questions: where is the 120 s ComfyUI wait and how does an automatic job session call begin; which functions in gpu_session.py are broker logic vs PromptForge-specific; which tests would move with G1; per-device awareness (is anything GPU-index specific). RULES: read-only on the code; write ONLY the one findings file named below (a NEW file, nothing else changed). For every row/claim of the map that touches your area, state CONFIRMED / WRONG / UNCONFIRMED with path:line evidence, quote the corrected text for anything WRONG, and answer the section-5 open questions that fall in your area. Keep it under 120 lines. FILE TO WRITE: Docs/gpu-broker-verification-promptforge.md (in the agent-manager repo).";
const READONLY_CORE_TEXT = "Create the NEW file Docs/gpu-broker-verification-core.md (\u2264120 lines, nothing else touched) verifying Docs/gpu-broker-extraction-map.md section 1/5 against core code. Use this evidence: launch.sh:31-42 lease-delete+yield CONFIRMED; comfyui_lease_held agent-manager-common.sh:98, local-worker.sh:525, review-runner.sh:91 CONFIRMED; gpu-guard.js 54/77/101 CONFIRMED; local-client.js:266 (map says 264 \u2014 quote corrected); stop route pipeline_1_more.py:68 \u2192 app.py _stop_pipeline \u2192 stop.sh --keep-dashboard --keep-plugins, stop.sh:125 skips plugin-*.pid, so G5's 'stop kills plugins today' is WRONG/stale (fixed 2026-10-14, see test_stop_pipeline_keeps_plugins.py); /free reclaim gpu-guard.js:214-217 self-contained, no broker needed; .model-locks writer model-inflight-lock.js:37 + reader chat_preempt.py:164-168,265,394; /api/gpu callers only launch.sh:42, gpu-guard.js:105; pause/resume needs drain status endpoint (.model-locks/gpu-arbiter) + Ollama eviction (KEEP_ALIVE 30m) + resume via app.py:2760. Re-verify each line number with grep before writing, tag every row CONFIRMED/WRONG/UNCONFIRMED with path:line, answer the four section-5 questions, then run `wc -l` (\u2264120) and `git status` (only this new file).";
const OLD_DOCS_ENTRY_FIRST_SEEN = '2026-09-22T00:21:58.333Z';
const NEW_ENTRY = 'docs-only-gate-read-only-deliverable';
const verifyTask = (id, rawText, stuckAt) => stuck(id, {
  domain: 'adhoc', source: 'manual', promptContext: { rawText }, planResponse: '', priorRejectionFeedback: [], // real tasks carry none; stuck()'s default would match an unrelated entry
  needsClarification: { reason: 'design-decision', openQuestions: DOCS_ONLY_FAIL },
  history: [{ stage: 'exhausted', at: stuckAt, detail: '10/10' }, { stage: 'needs-clarification', at: stuckAt, detail: 'escalated' }],
});
const seedState = (dir, firstSeen) => fs.writeFileSync(path.join(dir, 'queue', STATE_FILE), JSON.stringify({ firstSeen }));
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', STATE_FILE), 'utf8'));
const SWEEP_NOW = new Date('2026-10-16T01:00:00Z');

test('docs-only-gate-read-only-deliverable applies to both real verification tasks and not to a real code task', () => {
  const e = byId[NEW_ENTRY];
  assert.ok(e, 'the entry exists');
  assert.equal(e.applies(verifyTask('pf', READONLY_PF_TEXT, '2026-10-16T00:41:26Z')), true);
  assert.equal(e.applies(verifyTask('core', READONLY_CORE_TEXT, '2026-10-15T18:15:11Z')), true);
  assert.equal(e.applies(verifyTask('code', 'Create docs/x.md and change the timeout in src/foo.js.', '2026-10-16T00:00:00Z')), false);
});

test('live state: with the old docs-only entry already first-seen in September, the NEW entry requeues the two real tasks and the old entry alone requeues nothing', () => {
  const build = () => {
    const dir = pipeline();
    seedState(dir, { 'docs-only-gate-negated-paths': OLD_DOCS_ENTRY_FIRST_SEEN });
    put(dir, 'needs-clarification', verifyTask('verify-pf', READONLY_PF_TEXT, '2026-10-16T00:41:26Z'));
    put(dir, 'needs-clarification', verifyTask('verify-core', READONLY_CORE_TEXT, '2026-10-15T18:15:11Z'));
    put(dir, 'needs-clarification', verifyTask('code', 'Create docs/x.md and change the timeout in src/foo.js.', '2026-10-15T18:15:11Z'));
    return dir;
  };
  const dir = build();
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: SWEEP_NOW });
  assert.deepEqual(s.requeued.map((r) => `${r.id}<-${r.entry}`).sort(), [`verify-core<-${NEW_ENTRY}`, `verify-pf<-${NEW_ENTRY}`]);
  assert.equal(has(dir, 'adhoc', 'verify-pf'), true);
  assert.equal(has(dir, 'adhoc', 'verify-core'), true);
  assert.equal(has(dir, 'needs-clarification', 'code'), true);
  assert.equal(readState(dir).firstSeen[NEW_ENTRY], SWEEP_NOW.toISOString());
  assert.ok(read(dir, 'adhoc', 'verify-pf').requeuedForFixes.includes(NEW_ENTRY));
  const old = build();
  const sOld = sweepKnownFixedFailures({ pipelineDir: old, now: SWEEP_NOW, entries: [byId['docs-only-gate-negated-paths']] });
  assert.deepEqual(sOld.requeued, [], 'this is what the owner saw: the old entry skips both as failed-after-the-fix');
  assert.equal(has(old, 'needs-clarification', 'verify-pf'), true);
});

test('once only: a task stuck after the new entry was first seen is left alone, and a requeued task is not requeued again for the same entry', () => {
  const dir = pipeline();
  seedState(dir, { 'docs-only-gate-negated-paths': OLD_DOCS_ENTRY_FIRST_SEEN, [NEW_ENTRY]: SWEEP_NOW.toISOString() });
  put(dir, 'needs-clarification', verifyTask('late', READONLY_PF_TEXT, '2026-10-16T02:00:00Z'));
  const again = verifyTask('again', READONLY_CORE_TEXT, '2026-10-16T00:30:00Z');
  again.requeuedForFixes = [NEW_ENTRY];
  put(dir, 'needs-clarification', again);
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-10-16T03:00:00Z') });
  assert.deepEqual(s.requeued, []);
  assert.equal(has(dir, 'needs-clarification', 'late'), true, 'failed after the entry went live');
  assert.equal(has(dir, 'needs-clarification', 'again'), true, 'already requeued for this entry once');
});

// --- stale-snippet-partial-anchor (2026-09-21) ----------------------------------------------------------------------------------------------
const anchorRepo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-repo-'));
  fs.mkdirSync(path.join(root, 'src'));
  const block = ['function bigBody(opts) {', ...Array.from({ length: 40 }, (_, i) => `  const value${i} = compute(${i}); // step ${i} of the pipeline`), '  return done;', '}'];
  const stale = block.slice(); stale.splice(25, 0, '  // added after the candidate was written');
  const pad = Array.from({ length: 500 }, (_, i) => `const pad${i} = ${i}; // padding line to make the file large`).join('\n');
  fs.writeFileSync(path.join(root, 'src', 'big.js'), `${pad}\n${stale.join('\n')}\n${pad}\n`);
  return { root, snippet: block.join('\n') };
};
const anchorTask = (id, body, extra = {}) => stuck(id, {
  domain: 'default', source: 'function_length_fix',
  promptContext: { body, fetchedFiles: [{ path: 'src/big.js', anchorConfidence: 'none' }, ...(extra.files || [])] },
  needsClarification: { reason: 'unreliable-grounding', openQuestions: "The grounding-fetch could not find a reliable anchor for this candidate's cited code in src/big.js -- every draft attempt sees the same unstructured, low-confidence file slice." },
  history: [{ stage: 'blocked', at: '2026-09-20T05:00:00Z' }, { stage: 'needs-clarification', at: '2026-09-20T05:00:01Z' }],
});

test('stale-snippet-partial-anchor matches only a task whose declared file now anchors strongly (context-only files are ignored)', () => {
  const { root, snippet } = anchorRepo();
  const saved = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_REPO_ROOT = root; process.env.AGENT_MANAGER_PIPELINE_DIR = root;
  try {
    const e = byId['stale-snippet-partial-anchor'];
    const body = (snip) => `### AC-9 · Decompose bigBody\nFiles: src/big.js\nSnippet:\n\`\`\`\n${snip}\n\`\`\`\n`;
    assert.equal(e.applies(anchorTask('fixable', body(snippet))), true, 'the drifted snippet anchors through its prefix');
    assert.equal(e.applies(anchorTask('gone', body(Array.from({ length: 30 }, (_, i) => `  const nothingLikeThis${i} = other(${i});`).join('\n')))), false, 'code that is genuinely gone stays put');
    assert.equal(e.applies(anchorTask('ctx', body(snippet), { files: [{ path: 'src/missing.js', context: true, anchorConfidence: 'none' }] })), true, 'a context-only file does not matter');
    const other = anchorTask('other', body(snippet)); other.needsClarification.openQuestions = 'The draft cites a file that does not exist.';
    assert.equal(e.applies(other), false, 'a different failure');
  } finally {
    for (const [k, v] of [['AGENT_MANAGER_REPO_ROOT', saved.r], ['AGENT_MANAGER_PIPELINE_DIR', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('stale-snippet-partial-anchor also matches a task whose cited code MOVED to a sibling file (the registry precondition follows the relocation)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-moved-'));
  fs.mkdirSync(path.join(root, 'src'));
  const block = ['function moved(o) {', ...Array.from({ length: 40 }, (_, i) => `  const v${i} = go(${i}); // step ${i} of the moved body`), '  return o;', '}'].join('\n');
  const pad = Array.from({ length: 400 }, (_, i) => `const p${i} = ${i}; // padding`).join('\n');
  fs.writeFileSync(path.join(root, 'src', 'old.js'), `${pad}\nfunction other() {}\n`);
  fs.writeFileSync(path.join(root, 'src', 'new.js'), `${pad}\n${block}\n${pad}\n`);
  const saved = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_REPO_ROOT = root; process.env.AGENT_MANAGER_PIPELINE_DIR = root;
  try {
    const t = anchorTask('moved', `### AC-10\nFiles: src/old.js\nSnippet:\n\`\`\`\n${block}\n\`\`\`\n`);
    t.promptContext.fetchedFiles = [{ path: 'src/old.js', anchorConfidence: 'none' }];
    assert.equal(byId['stale-snippet-partial-anchor'].applies(t), true);
  } finally {
    for (const [k, v] of [['AGENT_MANAGER_REPO_ROOT', saved.r], ['AGENT_MANAGER_PIPELINE_DIR', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// --- cited-code-moved-relocated (2026-09-21): structural, whatever the failure text said ------------------------------------------------------------------------
test('cited-code-moved-relocated matches a task whose declared file lost the Snippet to exactly one other file, and NOT a present, gone, diff-shaped or ambiguous one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moved-entry-'));
  fs.mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
  const block = ['function moved(o) {', ...Array.from({ length: 40 }, (_, i) => `  const v${i} = go(${i}); // step ${i} of the moved body`), '  return o;', '}'].join('\n');
  const pad = (t) => Array.from({ length: 300 }, (_, i) => `const ${t}${i} = ${i}; // padding line`).join('\n');
  fs.writeFileSync(path.join(root, 'src', 'old.js'), `${pad('o')}\nfunction other() {}\n`);
  fs.writeFileSync(path.join(root, 'src', 'routes', 'new.js'), `${pad('n')}\n${block}\n`);
  const saved = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR };
  process.env.AGENT_MANAGER_REPO_ROOT = root; process.env.AGENT_MANAGER_PIPELINE_DIR = root;
  try {
    const e = byId['cited-code-moved-relocated'];
    const mk = (body, file = 'src/old.js') => stuck('t', {
      domain: 'default', source: 'observability_fix',
      promptContext: { body, fetchedFiles: [{ path: file, anchorConfidence: 'strong' }] }, // stored strong: the code was in place when it was minted
      needsClarification: { reason: 'design-decision', openQuestions: 'The draft is a refusal ("FALSE POSITIVE ...").' }, history: [{ stage: 'exhausted', at: '2026-09-20T05:00:00Z' }],
    });
    const sec = (snip) => `### AC-7\nFiles: src/old.js\nSnippet:\n\`\`\`\n${snip}\n\`\`\`\n`;
    assert.equal(e.applies(mk(sec(block))), true, 'moved: the Snippet is in routes/new.js only');
    assert.equal(e.applies(mk(sec(block), 'src/routes/new.js')), false, 'the Snippet is still in the cited file: not moved');
    assert.equal(e.applies(mk(sec(Array.from({ length: 30 }, (_, i) => `  const nothing${i} = else(${i});`).join('\n')))), false, 'gone everywhere');
    assert.equal(e.applies(mk(sec('diff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n@@ -1,2 +1,3 @@\n a\n+b'))), false, 'a diff-shaped Snippet');
    fs.writeFileSync(path.join(root, 'src', 'routes', 'copy.js'), `${pad('c')}\n${block}\n`);
    assert.equal(e.applies(mk(sec(block))), false, 'two files contain it: ambiguous, never guessed');
    fs.unlinkSync(path.join(root, 'src', 'routes', 'copy.js'));
    fs.unlinkSync(path.join(root, 'src', 'old.js'));
    assert.equal(e.applies(mk(sec(block))), true, 'the cited file was renamed away entirely (read fails): still followed to the one file that has the code');
    fs.writeFileSync(path.join(root, 'src', 'routes', 'new.js'), `${pad('n')}\n${block.split('\n').slice(0, 16).join('\n')}\n  // rest differs\n${pad('z')}\n`);
    assert.equal(e.applies(mk(sec(block))), false, 'a file sharing only the snippet\'s prologue is not where the code moved');
  } finally {
    for (const [k, v] of [['AGENT_MANAGER_REPO_ROOT', saved.r], ['AGENT_MANAGER_PIPELINE_DIR', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// --- context-only-file-falsely-parked (2026-09-22) -------------------------------------------------------------------------------------------
// PR #436 fixed hasUnreliableGrounding to ignore context-only files, but shipped no drain
// entry for tasks ALREADY escalated by the pre-fix version -- only for the separate
// stale-snippet-matching bug, whose own groundingNowReliable() requires a currently-'none'
// non-context file to re-verify and so can never fire when the sole 'none' file is
// context-only (function-length-fix-ac-44's real shape: no live file read needed, this
// is purely a re-run of the classifier against the task's own already-stored data).
test('context-only-file-falsely-parked matches a task whose ONLY none-anchored file was a context-only reference, and nothing else', () => {
  const e = byId['context-only-file-falsely-parked'];
  const falselyParked = stuck('ac-44', {
    promptContext: { fetchedFiles: [{ path: 'src/local-draft.js', anchorConfidence: 'strong' }, { path: 'src/gpu-guard.js', anchorConfidence: 'none', context: true }] },
    needsClarification: { reason: 'unreliable-grounding', openQuestions: "The grounding-fetch could not find a reliable anchor for this candidate's cited code in src/gpu-guard.js." },
  });
  assert.equal(e.applies(falselyParked), true);

  const genuinelyUnreliable = stuck('ac-x', {
    promptContext: { fetchedFiles: [{ path: 'src/foo.js', anchorConfidence: 'none' }] },
    needsClarification: { reason: 'unreliable-grounding', openQuestions: 'x' },
  });
  assert.equal(e.applies(genuinelyUnreliable), false, 'a real non-context none-anchored file must still be left for stale-snippet-partial-anchor / a human');

  const differentReason = stuck('ac-y', { needsClarification: { reason: 'design-decision', openQuestions: 'x' } });
  assert.equal(e.applies(differentReason), false, 'not an unreliable-grounding escalation at all');
});

test('context-only-file-falsely-parked drains the victim to pending/', () => {
  const dir = pipeline();
  put(dir, 'needs-clarification', stuck('ac-44', {
    history: [{ stage: 'blocked', at: '2026-09-20T05:00:00Z' }, { stage: 'needs-clarification', at: '2026-09-20T05:00:01Z' }],
    promptContext: { fetchedFiles: [{ path: 'src/local-draft.js', anchorConfidence: 'strong' }, { path: 'src/gpu-guard.js', anchorConfidence: 'none', context: true }] },
    needsClarification: { reason: 'unreliable-grounding', openQuestions: "The grounding-fetch could not find a reliable anchor for this candidate's cited code in src/gpu-guard.js." },
  }));
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: NOW, entries: [byId['context-only-file-falsely-parked']] });
  assert.deepEqual(s.requeued.map((r) => r.id), ['ac-44']);
  assert.equal(has(dir, 'pending', 'ac-44'), true);
  assert.equal(has(dir, 'needs-clarification', 'ac-44'), false);
});

// --- implement-pass-sibling-repos-readable (2026-10-16): the real stuck VideoForge verification task, copied verbatim from queue/needs-clarification/ ---
const VF_RAW_TEXT = "Context: Docs/gpu-broker-extraction-map.md (merged, PR #561) maps pulling the Forge/pipeline GPU lease out of PromptForge into a standalone gpu-broker plugin (docs/agents/repo-extraction-playbook.md). Owner rule 2026-10-13: the pipeline's Ollama model and the Forge family never hold the GPU together. Premium, owner request 2026-10-15; this is one of three small read-only verification tasks replacing a single task that was too big. VideoForge: verify the map against /media/model-cache/github/videoforge (server/core/gpu.py, server/app.py, server/core/render.py, web/app.js). Questions: every place VideoForge calls the GPU endpoints (including web/app.js), whether the web page calls PromptForge directly from the browser (CORS/URL), and what G2 must change there. RULES: read-only on the code; write ONLY the one findings file named below (a NEW file, nothing else changed). For every row/claim of the map that touches your area, state CONFIRMED / WRONG / UNCONFIRMED with path:line evidence, quote the corrected text for anything WRONG, and answer the section-5 open questions that fall in your area. Keep it under 120 lines. FILE TO WRITE: Docs/gpu-broker-verification-videoforge.md (in the agent-manager repo).";
const VF_OPEN_QUESTIONS = "The automated handler could not get this past review after 3 attempts:\n  1. A prior plan was blocked before implementation because it named an edit target that does not actually exist in the repo:\n\nplan cites missing-file target(s): Docs/gpu-broker-verification-videoforge.md\n\nOnly declare edit targets that are actually present in the repo (verify with a tool call before naming one). If this task genuinely requires a brand-new file, say so explicitly (e.g. \"create `path`\") so it is recognized as a create target, not a citation of an existing file.\n  2. A prior attempt hit a tool/environment failure (not a design question):\n\nI've exhausted the verification of where VideoForge's code is:\n\n- `list_roots` shows exactly one accessible repo: the agent-manager worktree.\n- `/media/model-cache/github/` contains only `agent-manager` (a bare `.git` dir); `/media/model-cache/github/videoforge` does **not** exist (ls: \"No such file or directory\").\n- Filesystem-wide `find` for `*videoforge*`, `*forge*`, and `gpu.py` (up to maxdepth 6) returns nothing relevant — no VideoForge, no PromptForge, no other Forge checkout anywhere on this machine.\n- The deterministic pre-filter independently confirmed: `server/core/gpu.py`, `server/core/render.py`, `web/app.js`, and all `/media/model-cache/github/videoforge/...` paths are missing from this checkout.\n\nThe one source I *can* read is the map itself (`Docs/gpu-broker-extraction-map.md`, 80 lines, fully read: section 1's \"VideoForge client\" row claims `videoforge/server/core/gpu.py` (45 lines) + `server/app.py` + `server/core/render.py`; G2 repoints `videoforge/server/core/gpu.py`, `render.py`, `app.py`; section 5 names `web/app.js` as a caller G2 must repoint). But every one of those claims needs `path:line` evidence inside the VideoForge tree — which is not present in this sandbox. Writing the findings file with every row \"UNCONFIRMED because the code is absent\" would be a blocker report in the wrong garment: the acceptance criteria demand real citations into `server/core/gpu.py` / `web/app.js`, and I have zero of them. I made no file changes, which is correct for this outcome.\n\nRESOLUTION: needs-human-decision\nBLOCKER-TYPE: infra-error\nThe verification target `/media/model-cache/github/videoforge` (server/core/gpu.py, server/app.py, server/core/render.py, web/app.js) is not mounted in this sandbox — the only accessible repo is agent-manager, and a full filesystem search found no VideoForge checkout anywhere. To act without re-investigating: run a fresh pass in a sandbox that mounts the videoforge checkout (the map's claims to check are all in `Docs/gpu-broker-extraction-map.md` §1 row \"VideoForge client\", §3 G2, and §5's `web/app.js` bullet), then **create** `Docs/gpu-broker-verification-videoforge.md` (new file, ≤120 lines, CONFIRMED/WRONG/UNCONFIRMED per claim with `path:line` citations into the videoforge tree, answering the §5 browser→PromptForge CORS/URL question and the G2 change list for `web/app.js`/`server/app.py`/`server/core/gpu.py`/`server/core/render.py`). Nothing needs deciding by design — this is purely the missing mount.\n\nRetry the operation from a clean pass. If a command genuinely fails identically again, end with RESOLUTION: needs-human-decision and BLOCKER-TYPE: infra-error, quoting the exact command and its full error output.\n  3. Agentic implement pass tagged BLOCKER-TYPE: infra-error -- a tool/environment failure, not a design question, requeued for a clean retry\n\nIf this is a request to EXTEND an existing feature (a \"should also\", a \"when X, also Y\", or it names a different object than a similarly-named feature already covers), say exactly what should change and which file(s). If it is genuinely already done, use Archive.";

const SIBLING_ENTRY = 'implement-pass-sibling-repos-readable';
const VF_ROOTS = ['/media/model-cache/github/videoforge', '/media/model-cache/github/promptforge-manual'];
const { siblingRepoWasUnreachable } = require('./known-fixed-failures.js');
const vfTask = (id, over = {}) => ({
  id, domain: 'adhoc', source: 'manual', title: 'GPU broker verify videoforge', status: 'pending', createdAt: '2026-10-15T17:00:00Z',
  promptContext: { rawText: VF_RAW_TEXT },
  needsClarification: { reason: 'infra-error', openQuestions: VF_OPEN_QUESTIONS },
  history: [at('2026-10-15T18:19:25Z'), { stage: 'exhausted', at: '2026-10-15T19:19:24Z' }, { stage: 'needs-clarification', at: '2026-10-15T19:19:24Z' }],
  ...over,
});
// The real root list only exists on the host that has the repos; the sweep tests inject the roots, the wiring test below uses the real list when the repo is present.
const withRoots = (roots) => KNOWN_FIXED.map((e) => (e.id === SIBLING_ENTRY ? { ...e, applies: (t) => siblingRepoWasUnreachable(t, roots) } : e));
const LIVE_FIRST_SEEN = (extra = {}) => ({
  firstSeen: Object.fromEntries(KNOWN_FIXED.filter((e) => e.id !== SIBLING_ENTRY).map((e) => [e.id, '2026-10-16T03:18:45.000Z'])), ...extra,
});

test('implement-pass-sibling-repos-readable applies to the real VideoForge task and to nothing that is not a sibling-repo-unreachable failure', () => {
  assert.equal(siblingRepoWasUnreachable(vfTask('vf'), VF_ROOTS), true);
  assert.equal(siblingRepoWasUnreachable(vfTask('vf', { needsClarification: { reason: 'infra-error', openQuestions: 'tests failed on line 3' } }), VF_ROOTS), false, 'unrelated failure');
  assert.equal(siblingRepoWasUnreachable(vfTask('vf', { promptContext: { rawText: 'Edit /media/model-cache/github/agent-manager/src/a.js to add a retry.' } }), VF_ROOTS), false, 'names only agent-manager paths');
  assert.equal(siblingRepoWasUnreachable(vfTask('vf', { needsClarification: undefined, priorRejectionFeedback: ['plan cites missing-file target(s): Docs/gpu-broker-verification-videoforge.md'] }), VF_ROOTS), false, 'missing create-target text alone');
  assert.equal(siblingRepoWasUnreachable(vfTask('vf', { promptContext: { rawText: 'Read /media/model-cache/github/some-unregistered-repo/x.py' } }), VF_ROOTS), false, 'path outside the registered roots');
  assert.equal(siblingRepoWasUnreachable(vfTask('vf'), []), false, 'empty roots');
  assert.equal(siblingRepoWasUnreachable(vfTask('vf', { promptContext: {} }), VF_ROOTS), false, 'no raw text');
});

test('implement-pass-sibling-repos-readable is wired to the real read-only root list (plugins manifest -> resolveReadOnlySiblingRoots) when the repo is on this host', { skip: !fs.existsSync('/media/model-cache/github/videoforge') && 'videoforge is not on this host' }, () => {
  // plugins-manifest reads its path at require time, so the wiring runs in a child process with a temp manifest that registers only videoforge.
  const manifest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fixsig-manifest-')), 'plugins.json');
  fs.writeFileSync(manifest, JSON.stringify([{ name: 'videoforge', registerPath: '/media/model-cache/github/videoforge/register.js', enabled: true }]));
  const script = `const { KNOWN_FIXED } = require('./src/known-fixed-failures.js'); const e = KNOWN_FIXED.find((x) => x.id === ${JSON.stringify(SIBLING_ENTRY)}); `
    + `const t = ${JSON.stringify(vfTask('vf'))}; process.stdout.write(String(e.applies(t)) + ',' + String(e.applies({ ...t, promptContext: { rawText: 'read /media/model-cache/github/some-unregistered-repo/x.py' } })));`;
  const out = require('child_process').execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8',
    env: { ...process.env, AGENT_MANAGER_PLUGINS_MANIFEST: manifest, AGENT_MANAGER_CORE_REPO_ROOT: path.join(__dirname, '..') },
  });
  assert.equal(out, 'true,false');
});

test('live state: with every older entry already first-seen, the NEW entry requeues the stuck VideoForge task once and the requeued record drops the false retire flag', () => {
  const dir = pipeline();
  fs.writeFileSync(path.join(dir, 'queue', STATE_FILE), JSON.stringify(LIVE_FIRST_SEEN()));
  put(dir, 'needs-clarification', vfTask('adhoc-vf', { stalenessFlag: { reason: 'duplicate-of', disposition: 'retire', confidence: 'medium' } }));
  const now = new Date('2026-10-16T09:00:00Z');
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now, entries: withRoots(VF_ROOTS) });
  assert.deepEqual(s.requeued, [{ id: 'adhoc-vf', entry: SIBLING_ENTRY, from: 'needs-clarification' }]);
  assert.deepEqual(s.newEntries, [SIBLING_ENTRY]);
  const fresh = read(dir, 'adhoc', 'adhoc-vf');
  assert.deepEqual(fresh.requeuedForFixes, [SIBLING_ENTRY]);
  assert.equal(fresh.stalenessFlag, undefined, 'a requeue rebuilds the record from a whitelist, so the false duplicate-of/retire flag is gone');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue', STATE_FILE), 'utf8')).firstSeen[SIBLING_ENTRY], now.toISOString());
  // once only: nothing more on a second pass, and a task that got stuck AFTER the new first sighting stays put
  put(dir, 'needs-clarification', vfTask('adhoc-vf-late', { history: [at('2026-10-16T10:00:00Z'), { stage: 'exhausted', at: '2026-10-16T10:00:00Z' }] }));
  const again = sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-10-16T11:00:00Z'), entries: withRoots(VF_ROOTS) });
  assert.deepEqual(again.requeued, []);
  assert.equal(has(dir, 'needs-clarification', 'adhoc-vf-late'), true);
});

test('mutation check: without the new entry the same live state requeues nothing (the failure the owner saw)', () => {
  const dir = pipeline();
  fs.writeFileSync(path.join(dir, 'queue', STATE_FILE), JSON.stringify(LIVE_FIRST_SEEN()));
  put(dir, 'needs-clarification', vfTask('adhoc-vf'));
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-10-16T09:00:00Z'), entries: KNOWN_FIXED.filter((e) => e.id !== SIBLING_ENTRY) });
  assert.deepEqual(s.requeued, []);
  assert.equal(has(dir, 'needs-clarification', 'adhoc-vf'), true);
});

// --- 2026-10-16: the two stuck read-only design / findings tasks, verbatim from queue/needs-clarification/ ---
const IR_RAW_TEXT = "WHY (owner 2026-10-15: \"the system is our greatest asset and needs to be capable of swiftly, easily and gracefully handling these kinds of tasks\"). Evidence from 2026-10-15, live: (a) a read-only 'verify the map against three repos' task finished orient (2.5 min) and plan (2.2 min), spent ~5 min in the agentic implement pass, answered RESOLUTION: decompose with NO valid JSON array, was blocked (src/agentic-draft-common.js:494), sat 17 min, was requeued to repeat the same stages -- a retry loop that cannot succeed. (b) A one-line bug (brain-dump capture: max() over string serials, python/dashboard/routes/brain_dump.py:132) was approved and decomposed into SEVEN sub-tasks (HUB0148). (c) Owner builds goals made of pieces across several repos by hand, and the pipeline serves one project at a time. This task is one of three from the 'systematic fix' (shape-aware intake, decompose repair, an Initiative record). SCOPE RULE: this is ONE task, do not decompose it; do the smallest first PR described. TASK: write ONE file, Docs/initiative-record-design.md, and change nothing else. Design an 'Initiative' record: a goal made of pieces, each piece a task, with the dependencies between them, the repo each piece belongs to, a status derived from the pieces, and a hook that files the NEXT piece automatically when its dependency merges, so follow-through is a property of the system and not of a person. Ground it in the current code with path:line (confirmed vs unconfirmed): the five existing cross-reference mechanisms (see the Task Linking concept: hub parent/child, dependsOn, brainDumpEntryId, raisedFrom, derived-task links), nextAdhocTask()/isDependencySatisfied() in src/task-sources.js (dependsOn is satisfied only once the dependency is MERGED), hubs and coordinating/ (queue/coordinating), the hub-priority and premiumPriority ordering in src/next-claimable-task.js, and queue-adhoc-task.js. The doc must contain: the record shape (JSON example); how it differs from a hub (hubs are decompositions of ONE task; an initiative spans tasks, projects and time); which existing mechanism it should reuse so it does not become a sixth; how a piece names its target repo (the pipeline works one active project at a time today -- say what this requires of the scheduler, referencing the project-rotation findings if Docs/project-rotation-and-expiry-aging-findings.md exists); the dashboard view (one row per initiative: pieces done/in-flight/blocked, next piece, age by attention); how premium priority is inherited by pieces; failure modes and the smallest first PR (an initiative file plus a read-only dashboard list, no auto-filing yet); and an open-decisions list with a recommended default for each. Worked example: the GPU broker extraction (Docs/gpu-broker-extraction-map.md pieces G0-G7) expressed as an initiative.";
const IR_TITLE = "Initiative record: design doc (read-only, one file)";
const IR_OPEN_QUESTIONS = "I've confirmed the deliverable file does not currently exist (the prior attempt was reverted), and I have enough context on the code to act. But I'm stopping here rather than editing, because there is a direct, unresolvable-by-me conflict between the two governing signals for this task, and I've already been rejected twice. Let me state it plainly.\n\nThe task's own text is unambiguous and is the owner's explicit spec:\n- Title: \"Initiative record: design doc (read-only, one file)\"\n- SCOPE RULE: \"this is ONE task, do not decompose it\"\n- TASK line: \"write ONE file, Docs/initiative-record-design.md, and change nothing else.\"\n\nThe rejection history says the opposite:\n- Rejection 2: \"Your diff only created/edited documentation … That is not the deliverable -- the task asks for a real code change. Implement the actual change.\"\n\nThese are mutually exclusive. Satisfying the owner's task line means changing nothing but the one doc file. Satisfying the reviewer means also writing code (an initiative file mechanism + read-only dashboard list), which directly violates \"change nothing else\" and risks re-triggering Rejection 1's decomposition/scope concern. There is no diff that both honors the explicit scope and counts as \"a real code change,\" so this is a scope decision only the owner can make. I will not guess for a third time.\n\nRESOLUTION: needs-human-decision\nBLOCKER-TYPE: design-question\n\nThe task text and the rejection criteria directly contradict on scope, and I need the owner to say which wins before I edit:\n- The task title/SCOPE RULE/TASK line (owner 2026-10-15) say the deliverable is exactly ONE file, Docs/initiative-record-design.md, and \"change nothing else\" — i.e. a design doc, the \"smallest first PR\" being a *section inside the doc*, not an actual code change.\n- Rejection #2 says a doc-only diff \"is not the deliverable\" and demands a real code change.\n\nI need one answer: is this a doc-only task (write the design doc and stop), or does the owner actually want the smallest first PR implemented as code too (the initiative record file format + a read-only dashboard list, no auto-filing)?\n\nOPTIONS:\n1. Doc only (per task text) :: Deliverable is solely Docs/initiative-record-design.md; I write it and change nothing else, per the explicit SCOPE RULE.\n2. Doc + smallest code :: Also implement the initiative record file mechanism and a read-only dashboard list (no auto-filing) alongside the design doc, per the rejection feedback.\n\nFor grounding, the design doc I would write (under either option) is already fully scoped and grounded: record shape (JSON), how it differs from a hub (hubs decompose ONE task via queue/coordinating/; an initiative spans tasks/repos/time), which existing cross-reference mechanism to reuse (hub parent/child, dependsOn, brainDumpEntryId, raisedFrom, derived-task links) so it is not a sixth, per-piece repo naming and what that requires of the one-active-project scheduler, the dashboard view (one row per initiative: pieces done/in-flight/blocked, next piece, age by attention), premium-priority inheritance (premiumPriority ranks -Infinity in src/next-claimable-task.js effectivePriority), failure modes covering both 2026-10-15 evidence items, and the GPU-broker G0–G7 worked example from Docs/gpu-broker-extraction-map.md. Note: Docs/project-rotation-and-expiry-aging-findings.md does not exist in this repo, so the doc would ground the one-active-project behavior in src/queue-adhoc-task.js / src/next-claimable-task.js instead.";
const TL_RAW_TEXT = "WHY (owner 2026-10-15): the owner has had Claude do system management and streamlining of Agent Manager by hand across many sessions and wants that fine-tuning broken into a set of repeatable tasks that run passively through the pipeline. A first, memory-and-skim pass (NOT evidence-backed) found nine recurring loops: (1) stalled-bucket drain (blocked / needs-clarification: find the one shared cause, fix it, release the bucket), (2) incident -> root cause -> sweep siblings (the Incident Amplification concept, never built), (3) unmerged-branch review (read the whole hub, verdict merge / needs-work / discard; docs/agents/unmerged-branch-review.md), (4) scanner precision tuning (measure false positives, cut them, confidence tiers, 'dismissed'), (5) policy-change follow-up (after a change, read a week of data, tighten, flip env switches; nothing currently remembers to do it), (6) triage candidate sifts (100-200 candidates into keep / drop / hold), (7) code-health and history analysis (a daily health ledger was proposed, not built), (8) brain-dump / memory / docs hygiene, (9) environment drift (env switches, lanes, P40, plugin env vs the intended state). The first pass saw 2,799 commits on origin/master since 2026-08-01, ~220 of them 'Triage batch' commits and several hundred fixes. SCOPE RULE: this is ONE task, write the single file named below, change nothing else, do not decompose. TASK: write ONE file, Docs/tuning-loops-catalogue.md. Read the real history, not the nine-item guess: git log of origin/master since 2026-08-01 (group commits and PR titles by theme; count them), queue/done and queue/done/_archived* task records and their history stages (which sources and job types recur, which tasks were retried, blocked or requeued and why), brain-dump.json entries (group by theme; note which were machine-raised vs session-raised), the memory notes under /home/wok/.claude/projects/-home-wok/memory/ whose name starts project-agent-manager-* (they record what each hand-run session found; read the index file MEMORY.md first), and docs/agents/, Docs/ and the existing task sources in src/task-sources.js and /media/model-cache/github/agent-manager-hygiene/src. Produce: (a) a table of the recurring loops actually found (correct, merge, split or drop the nine above with evidence), each with: how many times it ran (count and dates), what triggered it, the evidence a human or Claude looked at, the decision made, the artefact produced (PR, task, doc, env change), and whether any of it is ALREADY automated (name the source/sweep and path:line, or say none); (b) for each loop, a verdict: automate fully / automate evidence-gathering and keep a human gate / keep manual, with the reason; (c) the five most valuable gaps ranked by (frequency x cost of forgetting), with the evidence; (d) every claim marked confirmed (with path or commit) or unconfirmed. Do not run any live pipeline command, sweep, or task-sources.js. If a data source cannot be read, say so and continue with the rest. Keep under 300 lines.\n\nADDITIONAL EVIDENCE FROM A HAND-RUN SESSION (2026-10-14/15, Claude session 015TvzBxsPvNeXXdPbh273DP; session-raised, not yet checked against the repo history -- verify or correct each in the catalogue, and include them as loops or as members of the nine above): (A) LAND-AND-DEPLOY after every merge: fast-forward the live checkout, restart the plugin via kill pid + remove ~/.local/state/agent-manager/pids/plugin-<name>.pid + POST /api/plugins/<name>/ensure-started, confirm the running process serves the merged commit (done ~10 times that day for promptforge, storyforge, sceneforge, the dashboard); candidate loop: deploy-drift sweep. (B) PRE-FLIGHT before a pipeline start or project switch: an uncommitted edit in the target repo's checkout (e.g. storyforge stories/enough.json) is at risk because apply self-heal rescues/resets dirt (see the rescue branch agent/rescued-master-20261014193855 and PR #467 / #474); candidate: a start guard. (C) STATE CHECKS done by hand: P40 VM up (virsh), workers per lane, plugin pids and zombie pidfiles, host RAM vs the mem-guard 2048 MB threshold, whether the live PromptForge has CHARACTERFORGE_ROOT, which commit is live; candidate: the environment-drift loop. (D) STATUS DIGESTS: 'what is the queue doing' answered by reading queue/ directories, task histories and worker logs; candidate: a generated, phone-readable digest. (E) CONTACT SHEETS: building a labelled image sheet after a render job so a human can review it; candidate: automatic sheet per render job. (F) FILING FINDINGS: turning an incident into a well-formed brain dump or premium task with evidence and a 'do not decompose' scope rule; candidate: a file-this-finding helper. (G) MEMORY UPKEEP: writing/updating memory notes and the index after each stretch of work; candidate: a debrief task that proposes the changes for approval. (H) SECRET HYGIENE: a grep of agent-manager.env printed the dashboard token into a session transcript; candidate: a redacting read wrapper. (I) PRIOR-ART SCOUTING: gh/web search, vet by stars/recency/size (<150 MB), add a row + notes subsection to UsefulProjectIndex/INDEX.md; candidate: a scout step attached to every design task. Count these in the catalogue's table with the evidence you can find (git, task records, memory notes) and mark each confirmed or unconfirmed.";
const TL_TITLE = "Catalogue of recurring tuning loops from the history of Agent Manager development (read-only findings doc)";
const TL_OPEN_QUESTIONS = "The automated handler could not get this past review after 3 attempts:\n  1. Your diff only created/edited documentation (Docs/tuning-loops-catalogue.md). That is not the deliverable -- the task asks for a real code change. Implement the actual change in the file(s) the plan/task names. A doc/ADR, if the task asks for one at all, comes LAST, after the code is written and checked.\n  2. A prior plan pass produced a degenerate (truncated or empty) plan even after an internal higher-temperature reroll:\n\nPlan pass degenerate: truncated\n\nTry a fresh plan pass. Keep the plan concrete and complete -- do not truncate mid-thought.\n  3. Plan pass degenerate: truncated\n\nIf this is a request to EXTEND an existing feature (a \"should also\", a \"when X, also Y\", or it names a different object than a similarly-named feature already covers), say exactly what should change and which file(s). If it is genuinely already done, use Archive.";

// The two stuck tasks were parked 2026-10-15, BEFORE 'docs-only-gate-read-only-deliverable' was first seen (2026-10-16T03:18:45Z), so once the gate stops misreading them that existing entry drains
// them -- no new id is needed. These tests pin that against the real KNOWN_FIXED and the real first-seen state.
const DG_ENTRY = 'docs-only-gate-read-only-deliverable';
const dgTask = (id, rawText, title, openQuestions, over = {}) => ({
  id, domain: 'adhoc', source: 'manual', title, status: 'pending', createdAt: '2026-10-15T20:00:00Z', premiumPriority: true,
  promptContext: { rawText },
  needsClarification: { reason: 'design-decision', openQuestions },
  history: [at('2026-10-15T20:49:00Z'), { stage: 'exhausted', at: '2026-10-15T20:49:01Z' }, { stage: 'needs-clarification', at: '2026-10-15T20:49:02Z' }],
  ...over,
});
const dgPair = () => [dgTask('adhoc-initiative-record', IR_RAW_TEXT, IR_TITLE, IR_OPEN_QUESTIONS), dgTask('adhoc-tuning-loops', TL_RAW_TEXT, TL_TITLE, TL_OPEN_QUESTIONS)];
const dgLiveState = () => ({ firstSeen: { 'docs-only-gate-negated-paths': '2026-09-22T00:21:58.333Z', [DG_ENTRY]: '2026-10-16T03:18:45.436Z' } });

test('read-only design / findings tasks (initiative record, tuning-loops catalogue): the docs-only entry now applies to both real stuck records and still not to a real code task', () => {
  for (const t of dgPair()) assert.equal(byId[DG_ENTRY].applies(t), true, t.id);
  assert.equal(byId[DG_ENTRY].applies(dgTask('code', 'Create docs/x.md and change the timeout in src/foo.js.', 'code task', IR_OPEN_QUESTIONS)), false);
});

test('live state: with the older docs-only entries already first-seen, the sweep requeues both stuck design / findings tasks once and keeps their premium priority', () => {
  const dir = pipeline();
  // every other entry already first-seen (so only the two docs-only ids could requeue), the two docs-only ids at their real first-seen times
  const others = Object.fromEntries(KNOWN_FIXED.filter((e) => !['docs-only-gate-negated-paths', DG_ENTRY].includes(e.id)).map((e) => [e.id, '2026-10-16T03:18:45.000Z']));
  fs.writeFileSync(path.join(dir, 'queue', STATE_FILE), JSON.stringify({ firstSeen: { ...others, ...dgLiveState().firstSeen } }));
  for (const t of dgPair()) put(dir, 'needs-clarification', t);
  const s = sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-10-16T12:00:00Z') });
  assert.deepEqual(s.requeued.map((r) => [r.id, r.entry]).sort(), [['adhoc-initiative-record', DG_ENTRY], ['adhoc-tuning-loops', DG_ENTRY]]);
  for (const id of ['adhoc-initiative-record', 'adhoc-tuning-loops']) {
    assert.equal(has(dir, 'needs-clarification', id), false, id);
    assert.deepEqual(read(dir, 'adhoc', id).requeuedForFixes, [DG_ENTRY], id);
    assert.equal(read(dir, 'adhoc', id).premiumPriority, true, 'premium priority is kept');
  }
  assert.deepEqual(sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-10-16T13:00:00Z') }).requeued, [], 'once only');
});

test('a read-only design / findings task that got stuck AFTER the entry went live is left for a human', () => {
  const dir = pipeline();
  fs.writeFileSync(path.join(dir, 'queue', STATE_FILE), JSON.stringify(dgLiveState()));
  put(dir, 'needs-clarification', dgTask('late', IR_RAW_TEXT, IR_TITLE, IR_OPEN_QUESTIONS, { history: [at('2026-10-16T05:00:00Z'), { stage: 'exhausted', at: '2026-10-16T05:00:01Z' }] }));
  assert.deepEqual(sweepKnownFixedFailures({ pipelineDir: dir, now: new Date('2026-10-16T12:00:00Z') }).requeued, []);
  assert.equal(has(dir, 'needs-clarification', 'late'), true);
});

test('first sight of an entry: prerequisiteHubs is among the coordination fields kept on the requeued task', () => {
  const dir = pipeline();
  put(dir, 'needs-clarification', stuck('function-length-fix-ac-4', {
    needsClarification: { reason: 'design-decision' }, history: [at('2026-09-20T05:00:00Z'), { stage: 'exhausted', at: '2026-09-20T05:39:46Z' }],
    prerequisiteHubs: ['HUB0006'], planResponse: 'stale',
  }));
  sweepKnownFixedFailures({ pipelineDir: dir, now: NOW });
  assert.deepEqual(read(dir, 'pending', 'function-length-fix-ac-4').prerequisiteHubs, ['HUB0006']);
});
