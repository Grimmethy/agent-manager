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
