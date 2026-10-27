'use strict';

// Wiring test for the pre-filing citation gate (HUB0154 / AC-111): validateCitationBeforeFiling is pinned by context-trim-sweep.test.js, but nothing
// there proves nextCandidateFulfillmentTask actually USES it. Drives the real sdk wrapper end to end for an observability_fix candidate against a
// throwaway repo + pipeline dir: a candidate whose Snippet is gone is archived to done/_archived_no_action with the gate's reason, a candidate whose
// Snippet moved comes back with the corrected Files: list and nothing archived, and a valid citation is filed untouched.
// Run: node --test src/sdk/prefiling-gate-wiring.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GATE_BLOCK =
  'function computePremiseEvidence(section, fetchedFiles) {\n' +
  '  const evidence = [];\n' +
  '  for (const f of fetchedFiles) { if (f.content.includes(section.symbol)) evidence.push(f.path); }\n' +
  '  return evidence;\n' +
  '}';
const PADDING = '// filler line that is long enough to make the file a realistic size and unrelated to the snippet\n'.repeat(40);

function candidateDoc(files) {
  return [
    '### AC-111 · Silent catch in computePremiseEvidence',
    'Strength: Strong',
    `Files: ${files}`,
    '',
    'Snippet:',
    '```',
    GATE_BLOCK,
    '```',
    '',
    'Problem:',
    'The `computePremiseEvidence` helper swallows a failure.',
    '',
    'Solution:',
    'Log the failure.',
    '',
  ].join('\n');
}

// A throwaway repo (src files), pipeline dir and candidates doc; config is read from the environment at call time.
function setup({ files, repoFiles }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prefiling-wiring-'));
  const repo = path.join(root, 'repo');
  const pipeline = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(pipeline, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(pipeline, 'task-domains.json'), JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  for (const [rel, content] of Object.entries(repoFiles)) fs.writeFileSync(path.join(repo, rel), content);
  const doc = path.join(root, 'OBSERVABILITY_FIX_CANDIDATES.md'); // outside any git repo: the reader falls back to the working-tree file
  fs.writeFileSync(doc, candidateDoc(files));
  const saved = {};
  const env = { AGENT_MANAGER_REPO_ROOT: repo, AGENT_MANAGER_PIPELINE_DIR: pipeline, AGENT_MANAGER_DOMAINS_PATH: path.join(pipeline, 'task-domains.json') };
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  return {
    doc, pipeline,
    restore: () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } },
    archived: () => {
      const dir = path.join(pipeline, 'queue', 'done', '_archived_no_action');
      return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
    },
  };
}

function next(doc) {
  const { nextCandidateFulfillmentTask } = require('./candidate-fulfillment.js');
  return nextCandidateFulfillmentTask(doc, 'observability_fix');
}

test('a candidate whose Snippet is gone from every cited path is archived with the gate reason and not filed', () => {
  const s = setup({ files: 'src/gone.js', repoFiles: { 'src/unrelated.js': `${PADDING}\n${PADDING}` } });
  try {
    assert.equal(next(s.doc), null, 'nothing else in the doc, so no task comes back');
    const archived = s.archived();
    assert.equal(archived.length, 1);
    assert.equal(archived[0].promptContext.candidateId, 'AC-111');
    const reason = archived[0].history.map((h) => String(h.detail)).join('\n');
    assert.match(reason, /pre-filing citation gate/);
    assert.match(reason, /Snippet is absent from every cited path/);
  } finally { s.restore(); }
});

test('a candidate whose Snippet moved comes back with the corrected Files list and is not archived', () => {
  const s = setup({ files: 'src/old.js', repoFiles: { 'src/old.js': `${PADDING}\n${PADDING}`, 'src/moved.js': `${PADDING}\n${GATE_BLOCK}\n${PADDING}` } });
  try {
    const task = next(s.doc);
    assert.ok(task, 'a re-pointable candidate must be filed');
    const paths = task.promptContext.fetchedFiles.filter((f) => !f.context).map((f) => f.path);
    assert.deepEqual(paths, ['src/moved.js'], 'the Files list was corrected to the unique new home');
    assert.deepEqual(s.archived(), []);
  } finally { s.restore(); }
});

test('a valid citation is filed untouched and nothing is archived', () => {
  const s = setup({ files: 'src/handler.js', repoFiles: { 'src/handler.js': `${PADDING}\n${GATE_BLOCK}\n${PADDING}` } });
  try {
    const task = next(s.doc);
    assert.ok(task);
    assert.deepEqual(task.promptContext.fetchedFiles.filter((f) => !f.context).map((f) => f.path), ['src/handler.js']);
    assert.deepEqual(s.archived(), []);
  } finally { s.restore(); }
});
